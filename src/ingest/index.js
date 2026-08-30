'use strict';
/**
 * Ingest adapters, one per source file.
 *
 * Two invariants hold across all of them:
 *   1. PII is masked here, before a value is stored anywhere. Nothing downstream
 *      ever sees a raw phone number, Aadhaar, DL number or person's name.
 *   2. Every record keeps a citation - `source_file` plus a physical location
 *      (row number, line number) - so any later decision can be traced to bytes
 *      on disk.
 */
const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../lib/csv');
const { readSheet } = require('../lib/xlsx');
const { fileDigest } = require('../lib/util');
const pii = require('../pii/redact');

/** Canonical key for an Indian registration plate: uppercase, separators stripped. */
function regKey(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Render a canonical key back into the standard display form XX-00-XX-0000.
 * Falls back to the raw key when the plate does not fit the standard shape
 * (rather than inventing a format for something we did not understand).
 */
function regDisplay(key) {
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(key || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : (key || null);
}

function cite(file, locator) {
  return `${file}#${locator}`;
}

// ---------------------------------------------------------------------------
// fleet_master.csv
// ---------------------------------------------------------------------------
function ingestFleet(dataDir, log) {
  const file = 'fleet_master.csv';
  const full = path.join(dataDir, file);
  const { records } = parseCSV(fs.readFileSync(full, 'utf8'), { source: file });
  const out = [];
  for (const r of records) {
    const key = regKey(r.registration_number);
    if (!key) {
      log.alert('FLEET_ROW_NO_REGISTRATION', { file, row: r._row });
      continue;
    }
    out.push({
      reg_key: key,
      vehicle_id: r.vehicle_id || null,
      registration_raw: r.registration_number,
      model: r.model || null,
      year: r.year ? Number(r.year) : null,
      bs_stage: r.bs_stage || null,
      engine_heater: r.engine_heater === '' ? null : /^y/i.test(r.engine_heater),
      home_hub: r.home_hub || null,
      capacity_tonnes: r.capacity_tonnes ? Number(r.capacity_tonnes) : null,
      status: r.status || null,
      citation: cite(file, `row${r._row}`),
    });
  }
  return { file, digest: fileDigest(full), records: out };
}

// ---------------------------------------------------------------------------
// drivers_roster.csv  - the highest-PII source in the bundle
// ---------------------------------------------------------------------------
function ingestDrivers(dataDir, log) {
  const file = 'drivers_roster.csv';
  const full = path.join(dataDir, file);
  const { records } = parseCSV(fs.readFileSync(full, 'utf8'), { source: file });

  // Roster names are already registered with the redactor by the name-collection
  // pre-pass in context/store.js, which runs before any adapter. They are not
  // registered here, so this adapter never needs to hold the name list itself.

  const out = [];
  for (const r of records) {
    if (!r.driver_id) {
      log.alert('DRIVER_ROW_NO_ID', { file, row: r._row });
      continue;
    }
    out.push({
      driver_id: r.driver_id,
      // name, phone, dl_number and aadhaar are dropped entirely. We keep only a
      // non-reversible pseudonym so the same person can be matched across sources.
      person_ref: pii.pseudonym(r.name, 'PERSON'),
      joining_date: r.joining_date || null,
      home_hub: r.home_hub || null,
      citation: cite(file, `row${r._row}`),
      pii_fields_dropped: ['name', 'phone', 'dl_number', 'aadhaar'],
    });
  }
  return { file, digest: fileDigest(full), records: out };
}

// ---------------------------------------------------------------------------
// maintenance_log.xlsx  - free text, mixed Hindi/English, mixed case
// ---------------------------------------------------------------------------

/**
 * Classify a workshop note. The corpus is Hinglish and inconsistently cased, so
 * matching is done on a lowercased string against both English and transliterated
 * Hindi markers observed in the data.
 */
function classifyNote(noteRaw) {
  const n = String(noteRaw || '').toLowerCase();
  const flags = {
    // "band kiya jugaad se, permanent fix baaki hai" / "temporary fix applied,
    // needs permanent repair" - both mean the same thing operationally.
    jugaad: /jugaad|temporary fix|permanent fix baaki|needs permanent repair/.test(n),
    brake_work: /\bbrake\b|brake pad|brake drum|\bpad\b|\bdrum\b/.test(n),
    permanent_repair: /replaced|replace kiya|naya lagwaya|repaired and tested|overhaul/.test(n)
      && !/temporary fix|jugaad|permanent fix baaki|needs permanent repair/.test(n),
    road_tested: /road test ok/.test(n),
    under_warranty: /under warranty/.test(n),
  };
  return flags;
}

function ingestMaintenance(dataDir, log) {
  const file = 'maintenance_log.xlsx';
  const full = path.join(dataDir, file);
  const { records } = readSheet(full, { source: file });
  const out = [];
  for (const r of records) {
    const key = regKey(r.vehicle);
    if (!key) {
      log.alert('MAINTENANCE_ROW_NO_VEHICLE', { file, row: r._row });
      continue;
    }
    const flags = classifyNote(r.notes);
    out.push({
      reg_key: key,
      date: r.date || null,
      odometer_km: r.odometer_km ? Number(r.odometer_km) : null,
      // Mechanic first names are personal data. Pseudonymised, not stored.
      mechanic_ref: pii.pseudonym(r.mechanic, 'MECHANIC'),
      // The note is kept because the operating rules depend on what it says, but
      // it is masked first - drivers are named in some notes.
      notes: pii.scrub(r.notes),
      ...flags,
      citation: cite(file, `row${r._row}`),
    });
  }
  return { file, digest: fileDigest(full), records: out };
}

// ---------------------------------------------------------------------------
// meridian_trips.csv
// ---------------------------------------------------------------------------
function ingestTrips(dataDir, log) {
  const file = 'meridian_trips.csv';
  const full = path.join(dataDir, file);
  const { records } = parseCSV(fs.readFileSync(full, 'utf8'), { source: file });
  const out = [];
  for (const r of records) {
    const key = regKey(r.vehicle_reg);
    if (!r.trip_id) { log.alert('TRIP_ROW_NO_ID', { file, row: r._row }); continue; }
    out.push({
      trip_id: r.trip_id,
      reg_key: key || null,
      driver_id: r.driver_id || null,
      client: r.client || null,
      status: r.status || null,
      route_type: r.route_type || null,
      dispatch_time: r.dispatch_time || null,
      delivery_time: r.delivery_time || null,
      osrm_time_min: r.osrm_time_min ? Number(r.osrm_time_min) : null,
      actual_time_min: r.actual_time_min ? Number(r.actual_time_min) : null,
      osrm_distance_km: r.osrm_distance_km ? Number(r.osrm_distance_km) : null,
      origin_name: r.origin_name || null,
      dest_name: r.dest_name || null,
      citation: cite(file, `row${r._row}`),
    });
  }
  return { file, digest: fileDigest(full), records: out };
}

// ---------------------------------------------------------------------------
// emails/  - 40 threads, several are near-duplicates of each other
// ---------------------------------------------------------------------------
function ingestEmails(dataDir, log) {
  const dir = path.join(dataDir, 'emails');
  if (!fs.existsSync(dir)) return { file: 'emails/', digest: null, records: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const masked = pii.scrub(raw);
    const subject = (raw.match(/^Subject:\s*(.+)$/m) || [, ''])[1].trim();
    const dates = [...raw.matchAll(/^Date:\s*(.+)$/gm)].map((m) => m[1].trim());
    // Body = everything that is not a header line, masked.
    const body = masked
      .split('\n')
      .filter((l) => !/^(From|To|Date|Subject):/.test(l) && !/^-{10,}$/.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out.push({
      thread_id: f.replace(/\.txt$/, ''),
      file: `emails/${f}`,
      subject: pii.scrub(subject),
      dates,
      body,
      // Content fingerprint ignoring dates, so the planted near-duplicate threads
      // (same rule restated on a different date) collapse to one claim.
      claim_key: require('../lib/util').sha256(
        body.replace(/\b\d{1,2}\s+\w{3}\s+20\d\d\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
      ).slice(0, 16),
      citation: cite(`emails/${f}`, 'thread'),
    });
  }
  return { file: 'emails/', digest: null, records: out };
}

// ---------------------------------------------------------------------------
// dispatcher_interview.txt
// ---------------------------------------------------------------------------
function ingestInterview(dataDir, log) {
  const file = 'dispatcher_interview.txt';
  const full = path.join(dataDir, file);
  const raw = fs.readFileSync(full, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  let redactedLines = 0;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const { text, hits } = pii.redact(line);
    if (hits.length) redactedLines++;
    out.push({
      line_no: i + 1,
      // Speaker role, derived from the label position rather than from a
      // hard-coded name. The interviewee is labelled by name in this transcript,
      // so anyone who is not the interviewer is the subject being interviewed.
      speaker: /^INTERVIEWER:/.test(line) ? 'INTERVIEWER'
        : /^[A-Z][A-Z .]{2,30}:/.test(line) ? 'DISPATCHER' : null,
      text,
      redacted: hits,
      citation: cite(file, `L${i + 1}`),
    });
  });
  if (redactedLines) {
    // The dispatcher reads a colleague's mobile number aloud at L46 and is called
    // out for it at L48. Worth an explicit alert - it is the exact failure mode
    // the hard gate exists for.
    log.alert('PII_IN_SOURCE_REDACTED', { file, lines_affected: redactedLines });
  }
  return { file, digest: fileDigest(full), records: out };
}

module.exports = {
  regKey, regDisplay, cite, classifyNote,
  ingestFleet, ingestDrivers, ingestMaintenance, ingestTrips, ingestEmails, ingestInterview,
};
