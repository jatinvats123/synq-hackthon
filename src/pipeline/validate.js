'use strict';
/**
 * Ticket validation, de-duplication and quarantine.
 *
 * Three things happen here, in this order:
 *   1. Every ticket is checked against the context. Anything that cannot be
 *      grounded is quarantined with the specific reason and the raw record, and
 *      raises an alert. Nothing is ever dropped and nothing throws.
 *   2. Tickets sharing a ticket_id collapse to one. If the duplicates disagree on
 *      anything that matters, that is a separate finding from a benign re-sync.
 *   3. The survivors are returned in a deterministic order.
 */
const { sha256 } = require('../lib/util');
const { regKey } = require('../ingest');

const KNOWN_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

/** Fields whose disagreement between two copies of one ticket_id is material. */
const MATERIAL_FIELDS = [
  'created_at', 'vehicle', 'driver_id', 'origin_hub',
  'km_from_origin_hub', 'destination', 'issue', 'severity', 'client',
];

function materialHash(t) {
  return sha256(MATERIAL_FIELDS.map((f) => `${f}=${t[f] ?? ''}`).join('|')).slice(0, 16);
}

/** How much of a ticket is populated - used to pick a winner deterministically. */
function completeness(t) {
  return MATERIAL_FIELDS.filter((f) => t[f] !== null && t[f] !== undefined && t[f] !== '').length;
}

/**
 * Validate one ticket against the resolved context.
 * Returns { ok, reasons[], resolved{} }. `reasons` is empty iff ok.
 */
function validateTicket(t, ctx) {
  const reasons = [];
  const resolved = {};

  if (!t.ticket_id) {
    reasons.push({ code: 'MISSING_TICKET_ID', detail: 'no ticket identifier in any recognised field' });
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/.test(t.ticket_id)) {
    reasons.push({ code: 'MALFORMED_TICKET_ID', detail: `ticket_id ${JSON.stringify(t.ticket_id)} is not a usable identifier` });
  }

  if (!t.created_at_ok || !t.created_at) {
    reasons.push({
      code: 'UNPARSEABLE_TIMESTAMP',
      detail: `created_at ${JSON.stringify(t.created_at_raw)} could not be parsed (detected form: ${t.created_at_form})`,
    });
  }

  // Vehicle must resolve to a real vehicle in the fleet master. A registration we
  // cannot resolve means we cannot check BS stage, year, heater or service - so
  // every downstream rule would be guessing.
  const key = regKey(t.vehicle);
  if (!key) {
    reasons.push({ code: 'MISSING_VEHICLE', detail: 'no vehicle registration on the ticket' });
  } else if (!ctx.vehicles.has(key)) {
    reasons.push({
      code: 'UNKNOWN_VEHICLE',
      detail: `registration ${JSON.stringify(t.vehicle)} (normalised ${key}) is not in fleet_master.csv`,
    });
  } else {
    resolved.vehicle = ctx.vehicles.get(key);
    resolved.reg_key = key;
  }

  const hubs = new Set(Object.keys(ctx.config.hubs.distances));
  if (!t.origin_hub) {
    reasons.push({ code: 'MISSING_ORIGIN_HUB', detail: 'origin hub is empty; rule R-010 cannot be evaluated' });
  } else if (!hubs.has(t.origin_hub)) {
    reasons.push({ code: 'UNKNOWN_ORIGIN_HUB', detail: `origin hub ${JSON.stringify(t.origin_hub)} is not one of the nine known hubs` });
  } else {
    resolved.origin_hub = t.origin_hub;
  }

  if (t.km_from_origin_hub === null || t.km_from_origin_hub === undefined) {
    reasons.push({ code: 'MISSING_DISTANCE', detail: 'km_from_origin_hub is null; the 50 km sourcing rule (R-010) cannot be applied' });
  } else if (!(t.km_from_origin_hub >= 0)) {
    reasons.push({ code: 'INVALID_DISTANCE', detail: `km_from_origin_hub ${t.km_from_origin_hub} is not a non-negative number` });
  }

  if (!t.destination) {
    reasons.push({ code: 'MISSING_DESTINATION', detail: 'destination is empty; route-based rules (R-001, R-002, R-003, R-009) cannot be evaluated' });
  }

  // Driver and severity are recorded as findings but do not by themselves
  // quarantine a ticket: a breakdown with a bad driver reference is still a real
  // breakdown, and the work order still needs to exist.
  const findings = [];
  if (t.driver_id && !ctx.drivers.has(t.driver_id)) {
    findings.push({ code: 'UNKNOWN_DRIVER', detail: `driver ${t.driver_id} is not in drivers_roster.csv; driver rules (R-013) skipped` });
  } else if (t.driver_id) {
    resolved.driver = ctx.drivers.get(t.driver_id);
  }
  if (t.severity && !KNOWN_SEVERITIES.has(t.severity)) {
    findings.push({ code: 'UNKNOWN_SEVERITY', detail: `severity ${JSON.stringify(t.severity)} is not LOW/MEDIUM/HIGH; treated as unset` });
  }
  if (!t.issue) {
    findings.push({ code: 'MISSING_ISSUE', detail: 'issue text is empty; classification falls back to UNSPECIFIED' });
  }
  if (t.client && !ctx.config.rulebook.clients[t.client]) {
    findings.push({ code: 'UNKNOWN_CLIENT', detail: `client ${JSON.stringify(t.client)} has no entry in the rulebook; client-specific rules skipped` });
  }

  return { ok: reasons.length === 0, reasons, findings, resolved };
}

/**
 * Validate and de-duplicate a batch of tickets.
 *
 * Returns:
 *   accepted   - one entry per unique valid ticket_id, deterministically ordered
 *   quarantine - one entry per broken *source record* (duplicates of a broken
 *                ticket collapse too, so re-running does not multiply them)
 *   duplicates - the de-duplication ledger for the audit trail
 */
function validateBatch(tickets, ctx, log) {
  const seen = new Map(); // ticket_id -> [{ticket, validation}]
  const noId = [];

  for (const t of tickets) {
    const v = validateTicket(t, ctx);
    if (!t.ticket_id) { noId.push({ ticket: t, validation: v }); continue; }
    if (!seen.has(t.ticket_id)) seen.set(t.ticket_id, []);
    seen.get(t.ticket_id).push({ ticket: t, validation: v });
  }

  const accepted = [];
  const quarantine = [];
  const duplicates = [];

  for (const [ticketId, entries] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Deterministic winner: most complete record, then lowest material hash.
    // Never "whichever the file listed first" - the surprise file may reorder.
    const ranked = [...entries].sort((a, b) => {
      const c = completeness(b.ticket) - completeness(a.ticket);
      if (c !== 0) return c;
      return materialHash(a.ticket).localeCompare(materialHash(b.ticket));
    });
    const winner = ranked[0];

    if (entries.length > 1) {
      const hashes = [...new Set(entries.map((e) => materialHash(e.ticket)))];
      const record = {
        ticket_id: ticketId,
        occurrences: entries.length,
        citations: entries.map((e) => e.ticket._ingest.citation),
        material_variants: hashes.length,
        kept: winner.ticket._ingest.citation,
        rule: 'unique by ticket_id; winner = most complete record, ties broken by content hash',
      };
      duplicates.push(record);

      if (hashes.length > 1) {
        // Same id, genuinely different content. That is not a benign re-sync -
        // somebody edited a ticket, or two different incidents share an id.
        const differing = MATERIAL_FIELDS.filter(
          (f) => new Set(entries.map((e) => String(e.ticket[f] ?? ''))).size > 1
        );
        record.conflicting_fields = differing;
        log.alert('DUPLICATE_TICKET_CONTENT_MISMATCH', {
          ticket_id: ticketId, occurrences: entries.length,
          conflicting_fields: differing,
          action: 'processed once using the most complete record; all variants recorded in the audit trail',
        });
      } else {
        log.info('ticket.duplicate_collapsed', { ticket_id: ticketId, occurrences: entries.length });
      }
    }

    if (winner.validation.ok) {
      accepted.push({ ticket: winner.ticket, validation: winner.validation, occurrences: entries.length });
    } else {
      quarantine.push(buildQuarantine(ticketId, winner, entries, log));
    }
  }

  // Records with no usable ticket_id cannot be de-duplicated by id, so they are
  // keyed by a hash of their content to stay idempotent across re-runs.
  for (const e of noId) {
    const synthetic = `NOID-${materialHash(e.ticket).toUpperCase()}`;
    if (quarantine.some((q) => q.quarantine_id === synthetic)) continue;
    quarantine.push(buildQuarantine(synthetic, e, [e], log, true));
  }

  log.info('validate.summary', {
    input_records: tickets.length,
    unique_ticket_ids: seen.size,
    accepted: accepted.length,
    quarantined: quarantine.length,
    duplicate_groups: duplicates.length,
  });

  return { accepted, quarantine, duplicates };
}

function buildQuarantine(id, entry, allEntries, log, syntheticId = false) {
  const reasons = entry.validation.reasons;
  log.alert('TICKET_QUARANTINED', {
    ticket_id: id,
    reasons: reasons.map((r) => r.code),
    occurrences: allEntries.length,
    action: 'held for human review; no work order, no client message',
  });
  return {
    quarantine_id: id,
    ticket_id: syntheticId ? null : id,
    quarantined_at_source: entry.ticket._ingest.citation,
    occurrences: allEntries.length,
    all_citations: allEntries.map((e) => e.ticket._ingest.citation),
    reasons: reasons.map((r) => ({ code: r.code, detail: r.detail })),
    reason_codes: reasons.map((r) => r.code),
    findings: entry.validation.findings.map((f) => ({ code: f.code, detail: f.detail })),
    // The raw record is retained so a human can fix and replay it. It has already
    // been through the PII masker at ingest.
    raw_record: entry.ticket._raw,
    remediation: suggestRemediation(reasons),
  };
}

/** Turn reason codes into the specific thing a human has to go and do. */
function suggestRemediation(reasons) {
  const codes = new Set(reasons.map((r) => r.code));
  const steps = [];
  if (codes.has('MISSING_VEHICLE') || codes.has('UNKNOWN_VEHICLE')) {
    steps.push('Confirm the registration with the driver or hub, then re-submit. If the vehicle is genuinely new, add it to fleet_master.csv first.');
  }
  if (codes.has('UNPARSEABLE_TIMESTAMP')) {
    steps.push('Supply created_at as ISO-8601 (YYYY-MM-DDTHH:MM:SS) or DD/MM/YYYY HH:MM.');
  }
  if (codes.has('MISSING_ORIGIN_HUB') || codes.has('UNKNOWN_ORIGIN_HUB')) {
    steps.push('Set origin_hub to one of the nine Meridian hubs.');
  }
  if (codes.has('MISSING_DISTANCE') || codes.has('INVALID_DISTANCE')) {
    steps.push('Supply km_from_origin_hub; without it the 50 km replacement-sourcing rule cannot be applied.');
  }
  if (codes.has('MISSING_DESTINATION')) {
    steps.push('Supply the destination; route eligibility rules depend on it.');
  }
  if (codes.has('MISSING_TICKET_ID') || codes.has('MALFORMED_TICKET_ID')) {
    steps.push('Assign a ticket id. Without one the record cannot be de-duplicated and will re-quarantine on every run.');
  }
  return steps;
}

module.exports = { validateBatch, validateTicket, materialHash, completeness, MATERIAL_FIELDS };
