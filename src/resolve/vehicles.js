'use strict';
/**
 * Vehicle entity resolution.
 *
 * The same truck appears across five sources in three registration formats
 * (UP40IM3144 / UP-40-IM-3144 / "UP 40 IM 3144"), in mixed case, and fleet_master
 * itself carries two rows for eighteen of the hundred vehicles. This module
 * collapses all of that into one record per physical vehicle, and - importantly -
 * records every conflict it had to resolve rather than quietly picking a winner.
 */
const { regDisplay } = require('../ingest');

const MERGEABLE = ['model', 'year', 'bs_stage', 'engine_heater', 'home_hub', 'capacity_tonnes', 'status'];

/**
 * Resolve fleet_master rows into canonical vehicles.
 *
 * Precedence (config/precedence.json, field_rules[0..1]):
 *   1. The row carrying an MF- vehicle_id is the master record. In every duplicate
 *      group exactly one row has an id, and the id-less rows are also the ones
 *      missing capacity_tonnes / engine_heater - they are an unreconciled re-import.
 *   2. Where the master row is silent on a field, fill it from the duplicate rather
 *      than discarding a known value.
 *   3. A disagreement on a field where both rows have a value is a *conflict*: the
 *      master value is used, and the conflict is recorded so year-sensitive
 *      decisions (Orion's 2020+ gate) can be flagged.
 */
function resolveVehicles(fleetRecords, log) {
  const groups = new Map();
  for (const r of fleetRecords) {
    if (!groups.has(r.reg_key)) groups.set(r.reg_key, []);
    groups.get(r.reg_key).push(r);
  }

  const vehicles = new Map();
  const conflicts = [];
  let mergedGroups = 0;

  for (const [key, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Deterministic ordering: master row (has vehicle_id) first, then by file row.
    const ordered = [...rows].sort((a, b) => {
      const am = a.vehicle_id ? 0 : 1;
      const bm = b.vehicle_id ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.citation.localeCompare(b.citation);
    });
    const master = ordered[0];
    if (rows.length > 1) mergedGroups++;

    const merged = {
      reg_key: key,
      registration: regDisplay(key),
      vehicle_id: master.vehicle_id || null,
      source_rows: ordered.map((r) => r.citation),
      merged_from: rows.length,
      conflicts: [],
      derived: {},
    };

    for (const field of MERGEABLE) {
      const values = ordered
        .map((r) => ({ v: r[field], cite: r.citation, isMaster: r === master }))
        .filter((x) => x.v !== null && x.v !== undefined && x.v !== '');

      if (values.length === 0) { merged[field] = null; continue; }

      const distinct = [...new Set(values.map((x) => JSON.stringify(x.v)))];
      // Master value if present, else the first non-empty value (rule 2).
      const chosen = values.find((x) => x.isMaster) || values[0];
      merged[field] = chosen.v;
      merged[`${field}_citation`] = chosen.cite;

      if (distinct.length > 1) {
        const conflict = {
          entity: 'vehicle',
          entity_key: key,
          registration: merged.registration,
          field,
          values: values.map((x) => ({ value: x.v, citation: x.cite, is_master_row: x.isMaster })),
          resolved_to: chosen.v,
          rule: 'prefer_row_with_vehicle_id',
          why: 'The row carrying an MF- vehicle_id is the fleet master record; the id-less row is an unreconciled re-import.',
        };
        merged.conflicts.push(conflict);
        conflicts.push(conflict);
      }
    }

    vehicles.set(key, merged);
  }

  log.info('resolve.vehicles', {
    source_rows: fleetRecords.length,
    canonical_vehicles: vehicles.size,
    merged_groups: mergedGroups,
    field_conflicts: conflicts.length,
  });
  for (const c of conflicts) {
    log.alert('ENTITY_CONFLICT', {
      entity: 'vehicle', key: c.entity_key, field: c.field,
      values: c.values.map((v) => v.value), resolved_to: c.resolved_to, rule: c.rule,
    });
  }

  return { vehicles, conflicts };
}

/**
 * Attach maintenance history to each vehicle and derive the facts the rules need:
 * last brake work, open jugaad fix, latest odometer, last workshop visit.
 *
 * Odometer readings that go *backwards* over time are a real defect in this data
 * (CH67HY8613 reads 410,767 in July and 296,178 in September). We take the latest
 * reading by date, as ops directed, and flag the non-monotonicity as a conflict
 * rather than smoothing it away.
 */
function attachMaintenance(vehicles, maintenanceRecords, log) {
  const byVehicle = new Map();
  for (const m of maintenanceRecords) {
    if (!byVehicle.has(m.reg_key)) byVehicle.set(m.reg_key, []);
    byVehicle.get(m.reg_key).push(m);
  }

  const conflicts = [];
  let orphanRows = 0;

  for (const [key, rows] of byVehicle) {
    const v = vehicles.get(key);
    if (!v) { orphanRows += rows.length; continue; }

    // Sort by date, then by citation, so ties resolve identically on every run.
    rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.citation.localeCompare(b.citation));

    v.maintenance_count = rows.length;
    v.maintenance_citations = rows.map((r) => r.citation);

    const last = rows[rows.length - 1];
    v.last_workshop_visit = last ? { date: last.date, citation: last.citation } : null;
    v.odometer_km = last && last.odometer_km != null
      ? { value: last.odometer_km, as_of: last.date, citation: last.citation }
      : null;

    // Non-monotonic odometer detection. An odometer cannot decrease, so any
    // backwards step means the column is not a running total for this vehicle.
    const withOdo = rows.filter((r) => r.odometer_km != null);
    const regressions = [];
    for (let i = 1; i < withOdo.length; i++) {
      if (withOdo[i].odometer_km < withOdo[i - 1].odometer_km) {
        regressions.push({
          from: { value: withOdo[i - 1].odometer_km, as_of: withOdo[i - 1].date, citation: withOdo[i - 1].citation },
          to: { value: withOdo[i].odometer_km, as_of: withOdo[i].date, citation: withOdo[i].citation },
        });
      }
    }
    if (regressions.length) {
      const latest = withOdo[withOdo.length - 1];
      const conflict = {
        entity: 'vehicle',
        entity_key: key,
        registration: v.registration,
        field: 'odometer_km',
        values: withOdo.map((r) => ({ value: r.odometer_km, as_of: r.date, citation: r.citation })),
        regressions,
        resolved_to: latest.odometer_km,
        resolved_citation: latest.citation,
        rule: 'latest_workshop_reading_by_date',
        why: 'Odometer decreases between workshop visits, which is physically impossible. Ops ruled the workshop reading the reference over hub yard checks, so the latest workshop reading is carried, but it is flagged untrusted and no rule is allowed to depend on it.',
        severity: 'data_quality',
        trusted: false,
      };
      v.odometer_trusted = false;
      v.conflicts.push(conflict);
      conflicts.push(conflict);
    } else {
      v.odometer_trusted = withOdo.length > 0;
    }

    const brakeRows = rows.filter((r) => r.brake_work);
    v.last_brake_work = brakeRows.length
      ? { date: brakeRows[brakeRows.length - 1].date, citation: brakeRows[brakeRows.length - 1].citation }
      : null;

    // A jugaad fix is "open" until a later permanent repair is recorded for the
    // same vehicle. Order matters, which is why rows are date-sorted above.
    let openJugaad = null;
    for (const r of rows) {
      if (r.jugaad) openJugaad = { date: r.date, citation: r.citation, note: r.notes };
      else if (r.permanent_repair && openJugaad) openJugaad = null;
    }
    v.open_jugaad = openJugaad;
  }

  for (const v of vehicles.values()) {
    if (v.maintenance_count === undefined) {
      v.maintenance_count = 0;
      v.maintenance_citations = [];
      v.last_workshop_visit = null;
      v.odometer_km = null;
      v.last_brake_work = null;
      v.open_jugaad = null;
    }
  }

  const withHistory = byVehicle.size;
  log.info('resolve.maintenance', {
    rows: maintenanceRecords.length,
    vehicles_with_history: withHistory,
    orphan_rows: orphanRows,
    odometer_conflicts: conflicts.length,
  });

  // One systemic alert, not one per vehicle. When more than half the fleet shows
  // a physically impossible odometer trace, the finding is "this column is not a
  // running total", not fifty-five separate incidents - and fifty-five warnings
  // would bury every other alert in the run.
  if (conflicts.length) {
    const share = withHistory ? conflicts.length / withHistory : 0;
    log.alert('ODOMETER_COLUMN_UNRELIABLE', {
      vehicles_affected: conflicts.length,
      vehicles_with_history: withHistory,
      share: `${Math.round(share * 100)}%`,
      finding: share > 0.4
        ? 'maintenance_log.odometer_km is not a cumulative reading; it cannot support km-based service scheduling'
        : 'isolated odometer regressions; individual entries suspect',
      action: 'odometer marked untrusted per vehicle; no rule depends on it. See ASM-001.',
      example_vehicles: conflicts.slice(0, 5).map((c) => c.registration),
    });
  }

  return conflicts;
}

/** Attach trip history, used for client-familiarity signals and utilisation. */
function attachTrips(vehicles, tripRecords, log) {
  let orphans = 0;
  for (const t of tripRecords) {
    const v = vehicles.get(t.reg_key);
    if (!v) { orphans++; continue; }
    if (!v.trips) v.trips = { total: 0, by_client: {}, cancelled: 0, first: null, last: null };
    v.trips.total++;
    if (t.client) v.trips.by_client[t.client] = (v.trips.by_client[t.client] || 0) + 1;
    if (t.status === 'CANCELLED') v.trips.cancelled++;
    const d = t.dispatch_time || '';
    if (!v.trips.first || d < v.trips.first) v.trips.first = d;
    if (!v.trips.last || d > v.trips.last) v.trips.last = d;
  }
  for (const v of vehicles.values()) {
    if (!v.trips) v.trips = { total: 0, by_client: {}, cancelled: 0, first: null, last: null };
  }
  log.info('resolve.trips', { rows: tripRecords.length, orphan_rows: orphans });
  return orphans;
}

module.exports = { resolveVehicles, attachMaintenance, attachTrips };
