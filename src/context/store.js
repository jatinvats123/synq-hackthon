'use strict';
/**
 * The context layer.
 *
 * Ingests every static source, resolves entities, records conflicts, and exposes
 * one queryable object. Building it is a pure function of the input files plus
 * config, so two runs over the same bundle produce byte-identical context.
 */
const fs = require('fs');
const path = require('path');
const ingest = require('../ingest');
const { resolveVehicles, attachMaintenance, attachTrips } = require('../resolve/vehicles');
const { resolveEmails } = require('../resolve/emails');
const { writeJson, sha256 } = require('../lib/util');
const pii = require('../pii/redact');
const { collectNames, scanUncovered } = require('../pii/names');
const { parseCSV } = require('../lib/csv');
const { readSheet } = require('../lib/xlsx');

const ROOT = path.join(__dirname, '..', '..');

function loadConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', name), 'utf8'));
}

/**
 * Read the raw text of every source that can contain a person's name, and hand it
 * to the name extractors. This runs *before* any adapter, so the redactor already
 * knows every name by the time the first value is stored.
 *
 * Nothing here is retained: the raw text is read, names are handed to the
 * redactor's in-memory registry, and the buffers go out of scope. No name is
 * written to disk, to a log, or into this repository.
 */
function collectCorpusNames(dataDir) {
  const driverNames = [];
  const mechanicNames = [];
  let interviewText = '';
  const emailTexts = [];

  const rosterPath = path.join(dataDir, 'drivers_roster.csv');
  if (fs.existsSync(rosterPath)) {
    const { records } = parseCSV(fs.readFileSync(rosterPath, 'utf8'));
    for (const r of records) if (r.name) driverNames.push(r.name);
  }

  const maintPath = path.join(dataDir, 'maintenance_log.xlsx');
  if (fs.existsSync(maintPath)) {
    const { records } = readSheet(maintPath);
    for (const r of records) if (r.mechanic) mechanicNames.push(r.mechanic);
  }

  const interviewPath = path.join(dataDir, 'dispatcher_interview.txt');
  if (fs.existsSync(interviewPath)) interviewText = fs.readFileSync(interviewPath, 'utf8');

  const emailDir = path.join(dataDir, 'emails');
  if (fs.existsSync(emailDir)) {
    for (const f of fs.readdirSync(emailDir).filter((x) => x.endsWith('.txt')).sort()) {
      emailTexts.push(fs.readFileSync(path.join(emailDir, f), 'utf8'));
    }
  }

  return {
    names: collectNames({ driverNames, mechanicNames, interviewText, emailTexts }),
    texts: [interviewText, ...emailTexts],
  };
}

function buildContext({ dataDir, log, asOf = null }) {
  const rulebook = loadConfig('rulebook.json');
  const assumptions = loadConfig('assumptions.json');
  const precedence = loadConfig('precedence.json');
  const hubs = loadConfig('hubs.json');

  // Names are discovered from the data, never hard-coded. See src/pii/names.js.
  pii.clearNameRegistry();
  const { names } = collectCorpusNames(dataDir);
  pii.registerNames(names);
  log.info('pii.names_registered', {
    count: names.length,
    sources: 'drivers_roster.name, maintenance_log.mechanic, interview header, email sign-offs, config/pii_names.local.json',
    note: 'names are held in memory only; none is written to disk, logs, or source',
  });

  const drivers = ingest.ingestDrivers(dataDir, log);
  const fleet = ingest.ingestFleet(dataDir, log);
  const maintenance = ingest.ingestMaintenance(dataDir, log);
  const trips = ingest.ingestTrips(dataDir, log);
  const emails = ingest.ingestEmails(dataDir, log);
  const interview = ingest.ingestInterview(dataDir, log);

  const { vehicles, conflicts: vehicleConflicts } = resolveVehicles(fleet.records, log);
  const odoConflicts = attachMaintenance(vehicles, maintenance.records, log);
  attachTrips(vehicles, trips.records, log);

  // Drivers, keyed by id, with tenure precomputed against the as-of date.
  const driverIndex = new Map();
  for (const d of drivers.records) driverIndex.set(d.driver_id, d);

  const emailClaims = resolveEmails(emails.records, log);

  // as-of date: explicit flag wins, else config, else the latest event date in the
  // corpus. Never wall-clock - that would make re-runs differ (ASM-002).
  const corpusDates = [
    ...maintenance.records.map((m) => m.date),
    ...emails.records.flatMap((e) => e.dates.map((d) => {
      const t = Date.parse(d);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
    })),
  ].filter(Boolean).sort();
  const resolvedAsOf = asOf || assumptions['ASM-002'].value || corpusDates[corpusDates.length - 1];

  for (const d of driverIndex.values()) {
    d.tenure_months = d.joining_date ? monthsBetween(d.joining_date, resolvedAsOf) : null;
  }

  const ctx = {
    as_of: resolvedAsOf,
    config: { rulebook, assumptions, precedence, hubs },
    vehicles,
    drivers: driverIndex,
    trips: trips.records,
    maintenance: maintenance.records,
    emailClaims,
    emailThreads: emails.records,
    interview: interview.records,
    conflicts: [...vehicleConflicts, ...odoConflicts],
    provenance: {
      as_of_source: asOf ? 'cli --as-of' : 'config ASM-002',
      sources: [
        { file: fleet.file, digest: fleet.digest, rows: fleet.records.length },
        { file: drivers.file, digest: drivers.digest, rows: drivers.records.length },
        { file: maintenance.file, digest: maintenance.digest, rows: maintenance.records.length },
        { file: trips.file, digest: trips.digest, rows: trips.records.length },
        { file: emails.file, digest: emails.digest, rows: emails.records.length },
        { file: interview.file, digest: interview.digest, rows: interview.records.length },
      ],
    },
    stats: {
      fleet_rows: fleet.records.length,
      canonical_vehicles: vehicles.size,
      drivers: driverIndex.size,
      maintenance_rows: maintenance.records.length,
      trips: trips.records.length,
      email_threads: emails.records.length,
      email_distinct_claims: emailClaims.length,
      interview_lines: interview.records.length,
      conflicts: vehicleConflicts.length + odoConflicts.length,
    },
  };

  log.info('context.built', ctx.stats);
  return ctx;
}

function monthsBetween(fromIsoDate, toIsoDate) {
  const a = new Date(fromIsoDate + 'T00:00:00Z');
  const b = new Date(toIsoDate + 'T00:00:00Z');
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return null;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  return months;
}

function daysBetween(fromIsoDate, toIsoDate) {
  if (!fromIsoDate || !toIsoDate) return null;
  const a = Date.parse(String(fromIsoDate).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toIsoDate).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Persist a human-readable snapshot of the resolved context for observability. */
function saveContext(ctx, outPath) {
  const snapshot = {
    as_of: ctx.as_of,
    stats: ctx.stats,
    provenance: ctx.provenance,
    conflicts: ctx.conflicts,
    vehicles: [...ctx.vehicles.values()].map((v) => ({
      reg_key: v.reg_key, registration: v.registration, vehicle_id: v.vehicle_id,
      model: v.model, year: v.year, bs_stage: v.bs_stage, engine_heater: v.engine_heater,
      home_hub: v.home_hub, capacity_tonnes: v.capacity_tonnes, status: v.status,
      merged_from: v.merged_from, source_rows: v.source_rows,
      odometer_km: v.odometer_km, odometer_trusted: v.odometer_trusted, last_workshop_visit: v.last_workshop_visit,
      last_brake_work: v.last_brake_work, open_jugaad: v.open_jugaad,
      maintenance_count: v.maintenance_count, trips: v.trips,
      conflicts: v.conflicts,
    })).sort((a, b) => a.reg_key.localeCompare(b.reg_key)),
    drivers: [...ctx.drivers.values()].map((d) => ({
      driver_id: d.driver_id, person_ref: d.person_ref, joining_date: d.joining_date,
      home_hub: d.home_hub, tenure_months: d.tenure_months, citation: d.citation,
    })).sort((a, b) => a.driver_id.localeCompare(b.driver_id)),
    email_claims: ctx.emailClaims,
  };
  writeJson(outPath, snapshot);
  return sha256(JSON.stringify(snapshot));
}

module.exports = { buildContext, saveContext, monthsBetween, daysBetween, collectCorpusNames };
