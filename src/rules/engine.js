'use strict';
/**
 * The rule engine.
 *
 * Every rule returns the same shape:
 *
 *   { rule_id, verdict, because, citations[], assumptions[], derived, evidence{} }
 *
 * `verdict` is one of:
 *   PASS              - rule applies and the subject satisfies it
 *   FAIL              - rule applies and the subject violates it (blocking if rule.hard)
 *   NOT_APPLICABLE    - rule does not apply to this route/client/season
 *   INSUFFICIENT_DATA - rule applies but the data needed to judge it does not exist
 *
 * INSUFFICIENT_DATA is a first-class outcome, not an error. A vehicle whose service
 * status cannot be established is not silently treated as compliant; it is reported
 * as unknown and the decision says so. That distinction is the whole point of the
 * exercise, so it is modelled explicitly rather than collapsed into a boolean.
 */
const { daysBetween } = require('../context/store');
const { vehicleStateAsOf } = require('../resolve/vehicles');

function monthOf(isoTs) {
  const m = /^(\d{4})-(\d{2})/.exec(String(isoTs || ''));
  return m ? Number(m[2]) : null;
}

function hourOf(isoTs) {
  const m = /T(\d{2}):/.exec(String(isoTs || ''));
  return m ? Number(m[1]) : null;
}

function ruleById(ctx, id) {
  return ctx.config.rulebook.rules.find((r) => r.id === id);
}

function result(rule, verdict, because, extra = {}) {
  return {
    rule_id: rule.id,
    rule_name: rule.name,
    hard: !!rule.hard,
    verdict,
    because,
    citations: rule.citations.concat(rule.corroboration || []),
    assumptions: rule.assumptions || [],
    derived: !!extra.derived,
    evidence: extra.evidence || {},
  };
}

/** Does this route touch the named region? Origin or destination counts. */
function touchesRegion(ctx, route, regionKey) {
  const members = new Set(ctx.config.rulebook.regions[regionKey] || []);
  return members.has(route.origin_hub) || members.has(route.destination);
}

// ---------------------------------------------------------------------------
// Vehicle eligibility rules
// ---------------------------------------------------------------------------

/** R-001: BS4 barred from Delhi NCR routes, October to February. */
function checkR001(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-001');
  const month = monthOf(route.when);
  const inSeason = rule.params.months.includes(month);
  const inRegion = touchesRegion(ctx, route, 'delhi_ncr');
  if (!inSeason || !inRegion) {
    return result(rule, 'NOT_APPLICABLE',
      !inSeason ? `month ${month} is outside the Oct-Feb GRAP window`
                : `route ${route.origin_hub} -> ${route.destination} does not touch Delhi NCR`,
      { evidence: { month, origin: route.origin_hub, destination: route.destination } });
  }
  if (!vehicle.bs_stage) {
    return result(rule, 'INSUFFICIENT_DATA', 'BS stage is not recorded for this vehicle in fleet_master.csv',
      { evidence: { registration: vehicle.registration } });
  }
  const ok = vehicle.bs_stage === rule.params.bs_stage_required;
  return result(rule, ok ? 'PASS' : 'FAIL',
    ok ? `${vehicle.bs_stage} is permitted on a Delhi NCR route in month ${month}`
       : `${vehicle.bs_stage} vehicle may not run a Delhi NCR route in month ${month}; BS6 required`,
    { evidence: { bs_stage: vehicle.bs_stage, month, citation: vehicle.bs_stage_citation } });
}

/** R-002: engine heater required on hill routes, November to February. */
function checkR002(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-002');
  const month = monthOf(route.when);
  const inSeason = rule.params.months.includes(month);
  const inRegion = touchesRegion(ctx, route, 'hill');
  if (!inSeason || !inRegion) {
    return result(rule, 'NOT_APPLICABLE',
      !inSeason ? `month ${month} is outside the Nov-Feb hill window`
                : `route ${route.origin_hub} -> ${route.destination} is not a hill route`,
      { evidence: { month } });
  }
  if (vehicle.engine_heater === null || vehicle.engine_heater === undefined) {
    return result(rule, 'INSUFFICIENT_DATA', 'engine_heater is blank for this vehicle in fleet_master.csv',
      { evidence: { registration: vehicle.registration } });
  }
  return result(rule, vehicle.engine_heater ? 'PASS' : 'FAIL',
    vehicle.engine_heater ? 'vehicle has an engine heater' : 'vehicle has no engine heater and the route is a hill route in winter',
    { evidence: { engine_heater: vehicle.engine_heater, month, citation: vehicle.engine_heater_citation } });
}

/** R-003: no brake work in the last 30 days before a hill route. */
function checkR003(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-003');
  const month = monthOf(route.when);
  const inSeason = rule.params.months.includes(month);
  const inRegion = touchesRegion(ctx, route, 'hill');
  if (!inSeason || !inRegion) {
    return result(rule, 'NOT_APPLICABLE',
      !inRegion ? `route ${route.origin_hub} -> ${route.destination} is not a hill route`
                : `month ${month} is outside the Nov-Feb hill window`);
  }
  if (!vehicle.last_brake_work) {
    return result(rule, 'PASS', 'no brake work recorded for this vehicle in the maintenance log',
      { evidence: { maintenance_rows: vehicle.maintenance_count } });
  }
  const days = daysBetween(vehicle.last_brake_work.date, route.when);
  const ok = days === null ? null : days > rule.params.window_days;
  if (ok === null) {
    return result(rule, 'INSUFFICIENT_DATA', 'brake work date could not be compared to the dispatch date');
  }
  return result(rule, ok ? 'PASS' : 'FAIL',
    ok ? `last brake work was ${days} days ago, beyond the ${rule.params.window_days}-day bar`
       : `brake work ${days} days ago is inside the ${rule.params.window_days}-day bar for hill routes`,
    { evidence: { last_brake_work: vehicle.last_brake_work.date, days_since: days, citation: vehicle.last_brake_work.citation } });
}

/** R-006: Apex Chemicals rotation after an incident. */
function checkR006(ctx, vehicle, route, incidents) {
  const rule = ruleById(ctx, 'R-006');
  if (route.client !== rule.params.client) {
    return result(rule, 'NOT_APPLICABLE', `client is ${route.client || 'unset'}, not ${rule.params.client}`);
  }
  // Grounded in the ticket corpus, which is contemporaneous with the queue.
  // meridian_trips.csv covers 2018 only and cannot speak to 2026 dispatches (ASM-003).
  const priorApexIncidents = (incidents.get(vehicle.reg_key) || [])
    .filter((i) => i.client === rule.params.client && i.when <= route.when)
    .sort((a, b) => a.when.localeCompare(b.when));
  if (priorApexIncidents.length === 0) {
    return result(rule, 'PASS', 'no recorded incident for this vehicle on an Apex Chemicals run',
      { evidence: { apex_incidents: 0 } });
  }
  const latest = priorApexIncidents[priorApexIncidents.length - 1];
  return result(rule, 'FAIL',
    `this vehicle had an incident on an Apex run (ticket ${latest.ticket_id}); Apex require a different vehicle on the next Apex dispatch`,
    {
      derived: true,
      evidence: {
        apex_incidents: priorApexIncidents.length,
        latest_incident_ticket: latest.ticket_id,
        latest_incident_at: latest.when,
        citation: latest.citation,
      },
    });
}

/** R-007: Orion Pharma requires model year 2020 or later. */
function checkR007(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-007');
  if (route.client !== rule.params.client) {
    return result(rule, 'NOT_APPLICABLE', `client is ${route.client || 'unset'}, not ${rule.params.client}`);
  }
  if (vehicle.year == null) {
    return result(rule, 'INSUFFICIENT_DATA', 'model year is not recorded for this vehicle');
  }
  const ok = vehicle.year >= rule.params.min_year;
  const res = result(rule, ok ? 'PASS' : 'FAIL',
    ok ? `model year ${vehicle.year} meets Orion's ${rule.params.min_year}-or-later requirement`
       : `model year ${vehicle.year} is older than Orion's ${rule.params.min_year} minimum; the load would be rejected at their gate`,
    { evidence: { year: vehicle.year, citation: vehicle.year_citation } });

  // If the two fleet_master rows disagreed on the year, say so on the record. This
  // is the exact field Orion check against the RC, so an unresolved conflict here
  // is worth surfacing to the approver even when the chosen value passes.
  const yearConflict = (vehicle.conflicts || []).find((c) => c.field === 'year');
  if (yearConflict) {
    res.evidence.year_conflict = {
      values: yearConflict.values.map((v) => v.value),
      resolved_to: yearConflict.resolved_to,
      rule: yearConflict.rule,
      note: 'fleet_master.csv holds two rows for this registration with different years; the row carrying the MF- vehicle_id was used.',
    };
    res.data_quality_flag = 'YEAR_CONFLICT';
  }
  return res;
}

/** R-011: more than 30 days past due service grounds the vehicle. */
function checkR011(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-011');
  // There is no service due date in any source (ASM-001). We do not invent a PASS.
  if (!vehicle.last_workshop_visit) {
    return result(rule, 'INSUFFICIENT_DATA',
      'no service due date exists in any source, and this vehicle has no maintenance history at all, so no proxy can be computed',
      { evidence: { registration: vehicle.registration, maintenance_rows: 0 } });
  }
  const intervalDays = ctx.config.assumptions['ASM-001'].value;
  const sinceService = daysBetween(vehicle.last_workshop_visit.date, route.when);
  const overdueBy = sinceService === null ? null : sinceService - intervalDays;
  if (overdueBy === null) {
    return result(rule, 'INSUFFICIENT_DATA', 'last workshop visit date could not be compared to the dispatch date');
  }
  const grounded = overdueBy > rule.params.grace_days;
  // How much slack is left before the assumed interval would need to shrink for
  // this verdict to flip. A wide margin means the ASM-001 assumption is inert for
  // this vehicle - the verdict would hold under almost any reasonable interval
  // guess. A narrow margin means this specific verdict genuinely rests on the
  // assumed number and deserves a human's attention, not a blanket "assumption"
  // label applied identically to every vehicle regardless of how much it matters.
  const marginDays = rule.params.grace_days - overdueBy;
  const borderline = !grounded && marginDays <= 15;
  return result(rule, grounded ? 'FAIL' : 'PASS',
    grounded
      ? `derived service due date is ${overdueBy} days past, beyond the ${rule.params.grace_days}-day grace period; treated as grounded`
      : `${sinceService} days since last workshop visit; within the derived ${intervalDays}-day interval plus ${rule.params.grace_days}-day grace${borderline ? ` (only ${marginDays} days of margin - this verdict is close to the line)` : ''}`,
    {
      derived: true, // the due date is assumed, not observed - see ASM-001
      evidence: {
        last_workshop_visit: vehicle.last_workshop_visit.date,
        days_since_service: sinceService,
        assumed_interval_days: intervalDays,
        overdue_by_days: overdueBy,
        margin_days: marginDays,
        borderline,
        citation: vehicle.last_workshop_visit.citation,
        caveat: 'Service due date is derived from ASM-001, not observed. No source in the bundle contains one.',
      },
    });
}

/** R-012: a jugaad fix is a seven-day clock and confines the vehicle to its home region. */
function checkR012(ctx, vehicle, route) {
  const rule = ruleById(ctx, 'R-012');
  if (!vehicle.open_jugaad) {
    return result(rule, 'PASS', 'no open temporary (jugaad) fix recorded for this vehicle');
  }
  const days = daysBetween(vehicle.open_jugaad.date, route.when);
  const hubRegions = ctx.config.hubs.regions;
  const homeRegion = hubRegions[vehicle.home_hub];
  const destRegion = hubRegions[route.destination];
  const withinWindow = days !== null && days <= rule.params.window_days;
  const leavesRegion = destRegion !== undefined && homeRegion !== undefined && destRegion !== homeRegion;

  if (!withinWindow) {
    // Past seven days with no permanent repair recorded: the rule says the repair
    // *must* have happened by now. It has not, so the vehicle is still restricted -
    // arguably more so. We report FAIL rather than letting the clock expire quietly.
    return result(rule, 'FAIL',
      `temporary fix recorded ${days} days ago with no permanent repair in the log; the ${rule.params.window_days}-day repair window has expired`,
      { evidence: { jugaad_date: vehicle.open_jugaad.date, days_since: days, citation: vehicle.open_jugaad.citation } });
  }
  if (leavesRegion) {
    return result(rule, 'FAIL',
      `vehicle is inside its ${rule.params.window_days}-day post-jugaad window and this route leaves its home region (${homeRegion} -> ${destRegion})`,
      { evidence: { jugaad_date: vehicle.open_jugaad.date, days_since: days, home_region: homeRegion, dest_region: destRegion, citation: vehicle.open_jugaad.citation } });
  }
  return result(rule, 'PASS',
    `vehicle is inside its post-jugaad window but the route stays inside its home region (${homeRegion})`,
    { evidence: { jugaad_date: vehicle.open_jugaad.date, days_since: days, home_region: homeRegion, citation: vehicle.open_jugaad.citation } });
}

/** Base availability: the vehicle must be active, and must not be the one that broke down. */
function checkAvailability(ctx, vehicle, route) {
  const pseudoRule = { id: 'R-000', name: 'Vehicle is active and not the failed vehicle', hard: true, citations: ['dispatcher_interview.txt:L38'], assumptions: [] };
  if (route.exclude_reg_key && vehicle.reg_key === route.exclude_reg_key) {
    return result(pseudoRule, 'FAIL', 'this is the vehicle that broke down');
  }
  if (vehicle.status && vehicle.status !== 'Active') {
    return result(pseudoRule, 'FAIL', `fleet status is ${vehicle.status}`, { evidence: { status: vehicle.status, citation: vehicle.status_citation } });
  }
  return result(pseudoRule, 'PASS', 'vehicle is Active in the fleet master',
    { evidence: { status: vehicle.status, citation: vehicle.status_citation } });
}

/**
 * Run every vehicle-eligibility rule for one candidate vehicle on one route.
 * `eligible` is true only if no hard rule FAILs and no hard rule is INSUFFICIENT_DATA -
 * an unknown is not a pass.
 */
function evaluateVehicle(ctx, vehicle, route, incidents) {
  // Time-bound facts (last brake work, open jugaad fix, last workshop visit) must
  // be evaluated as of THIS ticket's timestamp, not as of the end of the
  // maintenance log - tickets and maintenance events interleave across the same
  // window, so using the vehicle's all-time-latest event would let a repair from
  // months after this incident decide whether the vehicle was eligible for it.
  // Static attributes (bs_stage, year, engine_heater, status) are unaffected by
  // time in this dataset, so checks that only need those still take `vehicle`.
  const asOf = vehicleStateAsOf(vehicle, route.when);
  const checks = [
    checkAvailability(ctx, vehicle, route),
    checkR001(ctx, vehicle, route),
    checkR002(ctx, vehicle, route),
    checkR003(ctx, asOf, route),
    checkR006(ctx, vehicle, route, incidents),
    checkR007(ctx, vehicle, route),
    checkR011(ctx, asOf, route),
    checkR012(ctx, asOf, route),
  ];
  const blocking = checks.filter((c) => c.hard && c.verdict === 'FAIL');
  const unknown = checks.filter((c) => c.hard && c.verdict === 'INSUFFICIENT_DATA');
  // Precisely which checks rest on an assumption, and why - not a single opaque
  // boolean. A vehicle can have exactly one derived check (almost always R-011,
  // because no source has a service due date) while every other check is fully
  // grounded in a real fleet_master/maintenance_log/ticket citation. Collapsing
  // that into "rests_on_assumption: true" made every selection look equally
  // uncertain, which overstates the real gap. borderline flags the rarer case
  // where the assumption is actually load-bearing for this specific vehicle.
  const derivedChecks = checks
    .filter((c) => c.derived && c.verdict !== 'NOT_APPLICABLE')
    .map((c) => ({
      rule_id: c.rule_id, rule_name: c.rule_name, verdict: c.verdict,
      assumptions: c.assumptions, because: c.because,
      borderline: !!(c.evidence && c.evidence.borderline),
    }));
  return {
    reg_key: vehicle.reg_key,
    registration: vehicle.registration,
    checks,
    blocking,
    unknown,
    eligible: blocking.length === 0 && unknown.length === 0,
    eligible_with_caveats: blocking.length === 0 && unknown.length > 0,
    derived_checks: derivedChecks,
    derived_used: derivedChecks.length > 0,
    has_borderline_assumption: derivedChecks.some((c) => c.borderline),
  };
}

// ---------------------------------------------------------------------------
// Client / delivery rules - these shape the message and the plan, not eligibility
// ---------------------------------------------------------------------------

/** R-004: Shakti's real 36-hour window, and R-009 monsoon padding on top. */
function planSla(ctx, route) {
  const out = { checks: [], sla_hours: null, quoted_hours: null };
  const r004 = ruleById(ctx, 'R-004');
  if (route.client === r004.params.client) {
    out.sla_hours = r004.params.sla_hours;
    out.checks.push(result(r004, 'PASS',
      `Shakti Cement is planned to ${r004.params.sla_hours} hours; the ${r004.params.contract_hours}-hour contract figure is legacy and is not used`,
      { evidence: { planning_sla_hours: r004.params.sla_hours, contract_sla_hours: r004.params.contract_hours } }));
  } else {
    const clientCfg = ctx.config.rulebook.clients[route.client];
    out.sla_hours = clientCfg ? clientCfg.sla_hours : null;
    out.checks.push(result(r004, 'NOT_APPLICABLE', `client is ${route.client || 'unset'}, not ${r004.params.client}`));
  }

  const r009 = ruleById(ctx, 'R-009');
  const month = monthOf(route.when);
  const inMonsoon = r009.params.months.includes(month);
  const east = touchesRegion(ctx, route, 'east_of_lucknow');
  if (inMonsoon && east) {
    out.quoted_hours = out.sla_hours ? Math.ceil(out.sla_hours * (1 + r009.params.padding_pct / 100)) : null;
    out.checks.push(result(r009, 'FAIL',
      `monsoon month ${month} on an eastern route: quote ${out.quoted_hours ?? 'the padded'} hours, not the standard figure`,
      { derived: true, evidence: { padding_pct: r009.params.padding_pct, base_hours: out.sla_hours, padded_hours: out.quoted_hours } }));
  } else {
    out.quoted_hours = out.sla_hours;
    out.checks.push(result(r009, 'NOT_APPLICABLE',
      !inMonsoon ? `month ${month} is outside the Jul-Sep monsoon window`
                 : `destination ${route.destination || 'unset'} is not east of Lucknow`));
  }
  return out;
}

/** R-005: Vertex gate hours, and the never-mark-it-failed instruction. */
function planVertexGate(ctx, route) {
  const rule = ruleById(ctx, 'R-005');
  if (route.client !== rule.params.client) {
    return result(rule, 'NOT_APPLICABLE', `client is ${route.client || 'unset'}, not ${rule.params.client}`);
  }
  const closeHour = Number(rule.params.gate_close.slice(0, 2));
  const openHour = Number(rule.params.gate_open.slice(0, 2));
  const hour = hourOf(route.when);
  const toLudhiana = route.destination === rule.params.site;
  if (!toLudhiana) {
    return result(rule, 'NOT_APPLICABLE',
      `gate hours are recorded for the ${rule.params.site} warehouse; this delivery is to ${route.destination || 'an unrecorded destination'}`);
  }
  // A recovery started after the gate closes cannot make the same-day slot.
  const lateStart = hour !== null && (hour >= closeHour || hour < openHour);
  return result(rule, lateStart ? 'FAIL' : 'PASS',
    lateStart
      ? `incident at ${String(hour).padStart(2, '0')}:00 cannot reach the ${rule.params.site} gate before it closes at ${rule.params.gate_close}; hold at the last halt and deliver at ${rule.params.gate_open}, recorded as ${rule.params.required_status}, never as ${rule.params.forbidden_status}`
      : `incident at ${String(hour).padStart(2, '0')}:00 leaves time to reach the gate before ${rule.params.gate_close}`,
    { evidence: { incident_hour: hour, gate_open: rule.params.gate_open, gate_close: rule.params.gate_close, required_status: rule.params.required_status } });
}

/** R-008: Orion loads must not sit at a hub overnight unrefrigerated. */
function planOrionColdChain(ctx, route) {
  const rule = ruleById(ctx, 'R-008');
  if (route.client !== rule.params.client) {
    return result(rule, 'NOT_APPLICABLE', `client is ${route.client || 'unset'}, not ${rule.params.client}`);
  }
  const hour = hourOf(route.when);
  const overnightRisk = hour !== null && (hour >= 20 || hour < 6);
  return result(rule, overnightRisk ? 'FAIL' : 'PASS',
    overnightRisk
      ? `incident at ${String(hour).padStart(2, '0')}:00 risks the load sitting at a hub overnight; the recovery plan must transfer the load directly to the replacement vehicle, not stage it at a hub`
      : 'daytime incident; direct transfer to the replacement vehicle avoids any overnight hub hold',
    { evidence: { incident_hour: hour } });
}

/** R-013: the incident driver's night-solo eligibility. */
function checkDriver(ctx, driver, route) {
  const rule = ruleById(ctx, 'R-013');
  if (!driver) {
    return result(rule, 'INSUFFICIENT_DATA', 'no resolvable driver on this ticket, so tenure could not be checked');
  }
  const hour = hourOf(route.when);
  const [nStart, nEnd] = rule.params.night_window.map((h) => Number(h.slice(0, 2)));
  const isNight = hour !== null && (hour >= nStart || hour < nEnd);
  if (!isNight) {
    return result(rule, 'NOT_APPLICABLE', `dispatch hour ${hour} is outside the ${rule.params.night_window.join('-')} night window`);
  }
  if (driver.tenure_months === null) {
    return result(rule, 'INSUFFICIENT_DATA', 'joining date missing for this driver');
  }
  const ok = driver.tenure_months >= rule.params.min_tenure_months;
  return result(rule, ok ? 'PASS' : 'FAIL',
    ok ? `driver has ${driver.tenure_months} months' service, at or above the ${rule.params.min_tenure_months}-month night-solo threshold`
       : `driver has only ${driver.tenure_months} months' service; a solo night run is not permitted - pair them or move the dispatch to daytime`,
    { evidence: { driver_id: driver.driver_id, tenure_months: driver.tenure_months, joining_date: driver.joining_date, incident_hour: hour, citation: driver.citation } });
}

module.exports = {
  evaluateVehicle, planSla, planVertexGate, planOrionColdChain, checkDriver,
  checkR001, checkR002, checkR003, checkR006, checkR007, checkR011, checkR012, checkAvailability,
  monthOf, hourOf, touchesRegion, ruleById, result,
};
