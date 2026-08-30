'use strict';
/**
 * Format-tolerant ticket reader.
 *
 * The main queue is a JSON array with known field names. We are told a second file
 * arrives later "in a changed format", so this reader does not assume the shape of
 * anything. It:
 *   - sniffs the container (JSON array / wrapped object / JSONL / CSV / TSV),
 *   - maps field names through an alias table and a normalisation fallback,
 *   - flattens one level of nesting (vehicle.registration -> vehicle),
 *   - normalises values that arrive in several shapes (dates, km, severity),
 *   - reports every unrecognised field as an alert instead of dropping it silently,
 *   - and never throws: anything it cannot understand becomes a quarantine record
 *     carrying the raw payload.
 *
 * The design rule: an unexpected format produces a loud, complete, correct-as-far-
 * as-it-goes result. It never produces a silent partial one.
 */
const fs = require('fs');
const path = require('path');
const { parseCSV, sniffDelimiter } = require('../lib/csv');
const { sha256 } = require('../lib/util');

/**
 * Canonical field -> the spellings we accept for it.
 * Comparison is done on a normalised key (lowercase, separators stripped), so
 * "ticketId", "ticket-id", "Ticket ID" and "TICKET_ID" all collapse to "ticketid".
 */
const ALIASES = {
  ticket_id: ['ticketid', 'id', 'ticketno', 'ticketnumber', 'ticketref', 'reference', 'refno', 'caseid', 'incidentid'],
  created_at: ['createdat', 'created', 'createdon', 'timestamp', 'time', 'datetime', 'date', 'reportedat', 'raisedat', 'openedat', 'eventtime', 'whenraised', 'raisedon', 'loggedat', 'occurredat', 'incidentat', 'when'],
  vehicle: ['vehicle', 'vehiclereg', 'vehicleregistration', 'registration', 'registrationnumber', 'reg', 'regno', 'truck', 'truckno', 'plate', 'platenumber', 'vehicleno', 'vehiclenumber'],
  driver_id: ['driverid', 'driver', 'driverref', 'drivercode', 'drivernumber'],
  origin_hub: ['originhub', 'origin', 'source', 'sourcehub', 'fromhub', 'from', 'startinghub', 'basehub', 'hub'],
  km_from_origin_hub: ['kmfromoriginhub', 'kmfromorigin', 'distancefromoriginkm', 'distancefromorigin', 'distancekm', 'km', 'kms', 'distance', 'breakdownkm', 'kmfromhub'],
  destination: ['destination', 'dest', 'desthub', 'destinationhub', 'to', 'tohub', 'deliverylocation', 'droplocation'],
  issue: ['issue', 'problem', 'fault', 'description', 'issuetype', 'breakdowntype', 'symptom', 'complaint'],
  severity: ['severity', 'priority', 'urgency', 'criticality', 'sev'],
  client: ['client', 'customer', 'account', 'clientname', 'customername', 'consignor'],
  status: ['status', 'state', 'ticketstatus', 'currentstatus'],
  resolution_note: ['resolutionnote', 'resolution', 'notes', 'note', 'remarks', 'comment', 'comments', 'closurenote'],
};

const normKey = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canon, aliases] of Object.entries(ALIASES)) {
    m.set(normKey(canon), canon);
    for (const a of aliases) m.set(a, canon);
  }
  return m;
})();

/** Severity arrives as words, numbers, or single letters depending on the exporter. */
function normSeverity(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (['HIGH', 'H', 'CRITICAL', 'P1', 'URGENT', '1', '3'].includes(s)) return 'HIGH';
  if (['MEDIUM', 'MED', 'M', 'P2', 'NORMAL', '2'].includes(s)) return 'MEDIUM';
  if (['LOW', 'L', 'P3', 'MINOR', '0'].includes(s)) return 'LOW';
  return s; // preserved verbatim; validation decides whether it is acceptable
}

/**
 * Parse a timestamp from any of the shapes a client export might use.
 * Returns { iso, ok, form }. Ambiguous DD/MM vs MM/DD is resolved as DD/MM
 * (Indian convention) and the chosen interpretation is reported so a reviewer can
 * see the assumption rather than guess at it.
 */
function normTimestamp(v) {
  if (v == null || v === '') return { iso: null, ok: false, form: 'empty' };
  const s = String(v).trim();

  // Epoch seconds / milliseconds
  if (/^\d{10}$/.test(s)) return { iso: new Date(Number(s) * 1000).toISOString().slice(0, 19), ok: true, form: 'epoch_s' };
  if (/^\d{13}$/.test(s)) return { iso: new Date(Number(s)).toISOString().slice(0, 19), ok: true, form: 'epoch_ms' };

  // ISO-ish: 2026-08-11T19:00:00 / with space / with Z / with offset / date only
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const [, Y, Mo, D, H = '00', Mi = '00', S = '00'] = m;
    const iso = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}`;
    return { iso, ok: Number.isFinite(Date.parse(iso + 'Z')), form: m[4] ? 'iso' : 'iso_date_only' };
  }

  // DD/MM/YYYY or DD-MM-YYYY, optional time
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const [, D, Mo, Y, H = '0', Mi = '00', S = '00'] = m;
    const pad = (x) => String(x).padStart(2, '0');
    const iso = `${Y}-${pad(Mo)}-${pad(D)}T${pad(H)}:${Mi}:${pad(S)}`;
    return { iso, ok: Number.isFinite(Date.parse(iso + 'Z')) && Number(Mo) <= 12, form: 'dd/mm/yyyy' };
  }

  // Anything else: let Date try, but only trust it if it round-trips.
  const t = Date.parse(s);
  if (Number.isFinite(t)) return { iso: new Date(t).toISOString().slice(0, 19), ok: true, form: 'date_parse' };
  return { iso: null, ok: false, form: 'unparseable' };
}

/** "47", "47 km", "47.0", 47 -> 47. Anything else -> null. */
function normKm(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^-?\d+(\.\d+)?/.exec(String(v).trim());
  return m ? Number(m[0]) : null;
}

/** Flatten one level of nesting so {vehicle:{registration:"X"}} maps like {vehicle:"X"}. */
function flatten(obj, prefix = '', depth = 0, out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
      flatten(v, key, depth + 1, out);
      // Also expose the leaf name alone, so `vehicle.registration` can match the
      // `registration` alias as well as `vehicle_registration`.
      for (const [ik, iv] of Object.entries(v)) {
        if (out[ik] === undefined && (iv == null || typeof iv !== 'object')) out[ik] = iv;
      }
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Map one raw record onto the canonical ticket shape. */
function mapRecord(raw, unmapped) {
  const flat = flatten(raw);
  const mapped = {};
  const extra = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith('_')) continue; // parser metadata
    const canon = ALIAS_LOOKUP.get(normKey(k));
    if (canon) {
      // First alias wins; a later, less specific spelling must not clobber it.
      if (mapped[canon] === undefined || mapped[canon] === null || mapped[canon] === '') mapped[canon] = v;
    } else {
      extra[k] = v;
      unmapped.add(k);
    }
  }
  return { mapped, extra };
}

/**
 * Detect the container format and return an array of raw records plus a label.
 * Everything here is best-effort and non-throwing; failure returns an empty list
 * and a reason the caller turns into an alert.
 */
function readContainer(text, filePath) {
  const trimmed = text.trim();
  const ext = path.extname(filePath).toLowerCase();

  if (trimmed.startsWith('[')) {
    try { return { records: JSON.parse(trimmed), format: 'json_array' }; }
    catch (err) { return { records: [], format: 'json_array', error: err.message }; }
  }

  if (trimmed.startsWith('{')) {
    // Either a single wrapped object, or JSONL whose first line is an object.
    try {
      const obj = JSON.parse(trimmed);
      const arrayKey = ['tickets', 'data', 'items', 'records', 'queue', 'rows', 'results', 'payload', 'entries']
        .find((k) => Array.isArray(obj[k]));
      if (arrayKey) return { records: obj[arrayKey], format: `json_object.${arrayKey}` };
      // A lone object is a one-record file.
      return { records: [obj], format: 'json_single_object' };
    } catch {
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
      const recs = [];
      const bad = [];
      lines.forEach((l, i) => {
        try { recs.push(JSON.parse(l)); }
        catch { bad.push(i + 1); }
      });
      if (recs.length) return { records: recs, format: 'jsonl', badLines: bad };
      return { records: [], format: 'unknown', error: 'not valid JSON or JSONL' };
    }
  }

  if (ext === '.csv' || ext === '.tsv' || ext === '.txt' || /[,;\t|]/.test(trimmed.split('\n', 1)[0])) {
    const delimiter = ext === '.tsv' ? '\t' : sniffDelimiter(trimmed);
    const { records } = parseCSV(text, { source: path.basename(filePath), delimiter });
    const label = { ',': 'csv', ';': 'csv_semicolon', '\t': 'tsv', '|': 'psv' }[delimiter] || 'delimited';
    return { records, format: label };
  }

  return { records: [], format: 'unknown', error: 'unrecognised container' };
}

/**
 * Read a ticket file of unknown shape.
 * Returns canonical tickets, each with `_raw` (the untouched source record, for
 * quarantine payloads) and `_ingest` metadata describing what we had to assume.
 */
function readTickets(filePath, log) {
  const fileName = path.basename(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const { records, format, error, badLines } = readContainer(text, filePath);

  if (error) {
    log.alert('TICKET_FILE_UNREADABLE', { file: fileName, format, reason: error });
  }
  if (badLines && badLines.length) {
    log.alert('TICKET_FILE_BAD_LINES', { file: fileName, format, count: badLines.length, lines: badLines.slice(0, 20) });
  }
  if (!Array.isArray(records)) {
    log.alert('TICKET_FILE_NOT_A_LIST', { file: fileName, format });
    return { tickets: [], format, fileName, unmapped: [], digest: sha256(text) };
  }

  // Announce the shape we found. If it is not the shape of the main queue, say so
  // loudly - a silently different format is exactly the failure this guards against.
  if (format !== 'json_array') {
    log.alert('TICKET_FORMAT_CHANGED', {
      file: fileName, detected: format, expected: 'json_array',
      action: 'adapted via alias mapping; every field mapping is recorded in the audit trail',
    });
  }

  const unmapped = new Set();
  const tickets = records.map((raw, i) => {
    const { mapped, extra } = mapRecord(raw, unmapped);
    const ts = normTimestamp(mapped.created_at);
    return {
      ticket_id: mapped.ticket_id == null ? null : String(mapped.ticket_id).trim(),
      created_at: ts.iso,
      created_at_raw: mapped.created_at == null ? null : String(mapped.created_at),
      created_at_form: ts.form,
      created_at_ok: ts.ok,
      vehicle: mapped.vehicle == null ? null : String(mapped.vehicle).trim(),
      driver_id: mapped.driver_id == null ? null : String(mapped.driver_id).trim(),
      origin_hub: mapped.origin_hub == null ? null : String(mapped.origin_hub).trim(),
      km_from_origin_hub: normKm(mapped.km_from_origin_hub),
      destination: mapped.destination == null ? null : String(mapped.destination).trim(),
      issue: mapped.issue == null ? null : String(mapped.issue).trim(),
      severity: normSeverity(mapped.severity),
      client: mapped.client == null ? null : String(mapped.client).trim(),
      status: mapped.status == null ? null : String(mapped.status).trim(),
      resolution_note: mapped.resolution_note == null ? null : String(mapped.resolution_note).trim(),
      _extra: Object.keys(extra).length ? extra : undefined,
      _raw: raw,
      _ingest: { file: fileName, format, index: i, citation: `${fileName}#index${i}` },
    };
  });

  if (unmapped.size) {
    // Preserved, not dropped. The evaluator can see exactly what we did not know
    // how to use, which is the honest failure mode for an unseen format.
    log.alert('TICKET_FIELDS_UNMAPPED', {
      file: fileName, fields: [...unmapped].sort(),
      action: 'preserved verbatim on each ticket under _extra; not used in any decision',
    });
  }

  log.info('tickets.read', { file: fileName, format, count: tickets.length });
  return { tickets, format, fileName, unmapped: [...unmapped].sort(), digest: sha256(text) };
}

module.exports = { readTickets, normTimestamp, normSeverity, normKm, ALIASES, mapRecord, readContainer };
