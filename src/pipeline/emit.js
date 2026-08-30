'use strict';
/**
 * Turns ledger state into the four outputs/*.jsonl files and audit/audit.jsonl.
 *
 * Every function here is a pure projection: same ledger in, same rows out. No
 * function in this file mutates the ledger or does file IO - run.js does the
 * writing, so the shape of an output row can be unit-tested without touching disk.
 */
const pii = require('../pii/redact');

// ---------------------------------------------------------------------------
// outputs/work_orders.jsonl
// ---------------------------------------------------------------------------

/**
 * One row per accepted ticket, in the exact shape CANDIDATE_README.md specifies,
 * with extra fields appended (never removed) for operational usefulness.
 *
 * created_at is the ticket's own incident time, not wall-clock processing time.
 * That is a deliberate idempotency choice: if created_at were "now", re-running
 * the pipeline tomorrow against the same ledger would change this file even
 * though nothing about the decision changed - which would fail rule 2 outright.
 */
function buildWorkOrder(ticketId, entry) {
  const d = entry.decision;
  return {
    work_order_id: entry.work_order_id,
    ticket_id: ticketId,
    vehicle_reg: d.vehicle_reg,
    created_at: d.created_at,
    citations: d.citations,
    client: d.client,
    severity: d.severity,
    issue: d.classification.issue_key,
    origin_hub: d.route.origin_hub,
    destination: d.route.destination,
    replacement: d.replacement.outcome === 'SELECTED'
      ? { registration: d.replacement.selected.registration, from_hub: d.replacement.selected.from_hub, rests_on_assumption: d.replacement.selected.rests_on_assumption }
      : null,
    status: d.replacement.outcome === 'SELECTED' ? (d.needs_human ? 'DISPATCHED_WITH_CONSTRAINTS' : 'DISPATCHED') : 'ESCALATED_NO_VEHICLE',
    needs_human_review: d.needs_human,
    assumptions_used: d.assumptions_used,
  };
}

function buildWorkOrders(ledger) {
  return Object.keys(ledger.accepted)
    .sort()
    .map((ticketId) => buildWorkOrder(ticketId, ledger.accepted[ticketId]));
}

// ---------------------------------------------------------------------------
// Client message bodies - built from the resolved decision, never from raw text.
// No name, phone, email, DL or Aadhaar can appear here because nothing in a
// `decide.js` decision object carries one; the PII gate in run.js re-checks this
// before the file is written regardless.
// ---------------------------------------------------------------------------

function formatHours(h) { return h == null ? 'the standard SLA' : `${h} hours`; }

function buildMessageBody(decision) {
  const d = decision;
  const lines = [];
  lines.push(`Meridian Freight service update - ticket ${d.ticket_id}`);
  lines.push('');
  lines.push(
    `Vehicle ${d.vehicle_reg} on your ${d.route.origin_hub} -> ${d.route.destination} consignment experienced ` +
    `${d.classification.issue_key || 'a mechanical issue'} and is out of service.`
  );

  if (d.replacement.outcome === 'SELECTED') {
    lines.push(`A replacement vehicle has been dispatched from our ${d.replacement.selected.from_hub} hub to continue the delivery.`);
  } else {
    lines.push('We are arranging a replacement vehicle and will confirm dispatch shortly.');
  }

  // Client-specific commitments, only when the corresponding rule actually fired.
  const byRule = Object.fromEntries(d.plan_checks.map((c) => [c.rule_id, c]));
  if (byRule['R-005'] && byRule['R-005'].verdict === 'FAIL') {
    lines.push('Your delivery is being held at the last halt and will arrive at 08:00 tomorrow as a scheduled morning delivery. This is not a failed delivery attempt.');
  }
  if (byRule['R-008'] && byRule['R-008'].verdict === 'FAIL') {
    lines.push('Your consignment will be transferred directly to the replacement vehicle without being staged at a hub, in line with your cold-chain requirement.');
  }
  if (byRule['R-009'] && byRule['R-009'].verdict === 'FAIL') {
    lines.push(`Given current monsoon conditions on this route, please plan for a revised ETA of approximately ${formatHours(d.sla.quoted_hours)} from original dispatch.`);
  } else if (d.sla.quoted_hours) {
    lines.push(`Revised delivery ETA: approximately ${formatHours(d.sla.quoted_hours)} from original dispatch.`);
  }

  lines.push('');
  lines.push('We will keep you informed of any further change. Thank you for your patience.');
  lines.push('');
  lines.push('Meridian Freight Operations');
  return lines.join('\n');
}

/** Whether a ticket warrants an outbound client message at all. Internal incidents do not. */
function needsClientMessage(decision) {
  return !!decision.client && decision.client !== 'Internal' && decision.client !== '';
}

// ---------------------------------------------------------------------------
// outputs/comms_pending.jsonl and outputs/comms_sent.jsonl
// ---------------------------------------------------------------------------

function recipientFor(decision, rulebook) {
  const cfg = rulebook.clients[decision.client];
  return cfg ? cfg.role_mailbox : null;
}

function buildCommsPending(ledger, rulebook) {
  const rows = [];
  for (const ticketId of Object.keys(ledger.accepted).sort()) {
    const entry = ledger.accepted[ticketId];
    if (entry.sent) continue; // already sent; not pending any more
    if (!needsClientMessage(entry.decision)) continue;
    const recipient = recipientFor(entry.decision, rulebook);
    if (!recipient) continue; // unknown client, no mailbox on file - handled as a finding elsewhere
    rows.push({
      message_id: entry.message_id,
      ticket_id: ticketId,
      recipient,
      body: buildMessageBody(entry.decision),
      // Context for the human approver: exactly what the decision rested on.
      context: {
        client: entry.decision.client,
        vehicle_reg: entry.decision.vehicle_reg,
        route: entry.decision.route,
        replacement: entry.decision.replacement.outcome,
        actionable_constraints: entry.decision.actionable_constraints,
        needs_human: entry.decision.needs_human,
      },
      citations: entry.decision.citations,
      drafted_at: entry.decision.created_at,
    });
  }
  return rows;
}

/** Replays sent messages from the ledger. Never regenerates a body after the fact. */
function buildCommsSent(ledger) {
  const rows = [];
  for (const ticketId of Object.keys(ledger.accepted).sort()) {
    const entry = ledger.accepted[ticketId];
    if (!entry.sent) continue;
    const recipient = entry.sent_recipient || null;
    rows.push({
      message_id: entry.message_id,
      ticket_id: ticketId,
      recipient,
      body: entry.sent_body,
      approved_by: entry.approved_by,
      sent_at: entry.sent_at,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// outputs/quarantine.jsonl
// ---------------------------------------------------------------------------

function buildQuarantine(ledger) {
  return Object.keys(ledger.quarantine)
    .sort()
    .map((qid) => {
      const q = ledger.quarantine[qid];
      return {
        quarantine_id: qid,
        ticket_id: q.ticket_id,
        reasons: q.reasons,
        findings: q.findings,
        occurrences: q.occurrences,
        source_citations: q.all_citations,
        remediation: q.remediation,
        raw_record: q.raw_record,
      };
    });
}

// ---------------------------------------------------------------------------
// audit/audit.jsonl
// ---------------------------------------------------------------------------

/**
 * One audit row per step per ticket, fully deterministic (no wall-clock fields),
 * so a diff between two runs' audit files is as clean as the outputs diff.
 * Rows are ordered by ticket_id then a fixed step sequence.
 */
function buildAuditRows(ledger) {
  const rows = [];
  let seq;

  const push = (ticketId, step, detail) => rows.push({ ticket_id: ticketId, seq: ++seq, step, ...detail });

  for (const ticketId of Object.keys(ledger.accepted).sort()) {
    seq = 0;
    const entry = ledger.accepted[ticketId];
    const d = entry.decision;

    push(ticketId, 'INGESTED', { source: entry.first_seen_source, occurrences_in_queue: d.occurrences_in_queue });
    push(ticketId, 'VALIDATED', { result: 'ACCEPTED', vehicle_reg: d.vehicle_reg, origin_hub: d.route.origin_hub, destination: d.route.destination });
    if (d.occurrences_in_queue > 1) {
      push(ticketId, 'DEDUPLICATED', { occurrences: d.occurrences_in_queue, kept_source: entry.first_seen_source });
    }
    push(ticketId, 'CLASSIFIED', { issue: d.classification.issue_key, class: d.classification.class, recovery: d.classification.recovery, known_taxonomy: d.classification.known });

    for (const check of (d.plan_checks || [])) {
      push(ticketId, 'RULE_EVALUATED', {
        rule_id: check.rule_id, rule_name: check.rule_name, verdict: check.verdict,
        because: check.because, hard: check.hard, derived: check.derived,
        citations: check.citations, assumptions: check.assumptions,
      });
    }

    push(ticketId, 'REPLACEMENT_SOURCING', {
      rule_id: d.replacement.sourcing.rule_id, basis: d.replacement.sourcing.basis,
      hubs_considered: d.replacement.sourcing.hubs, derived: d.replacement.sourcing.derived,
    });
    if (d.replacement.outcome === 'SELECTED') {
      push(ticketId, 'REPLACEMENT_SELECTED', {
        registration: d.replacement.selected.registration, from_hub: d.replacement.selected.from_hub,
        fully_eligible: d.replacement.selected.fully_eligible, rests_on_assumption: d.replacement.selected.rests_on_assumption,
        citations: d.replacement.selected.citations,
      });
    } else {
      push(ticketId, 'REPLACEMENT_ESCALATED', { reason: d.replacement.escalation.reason, waiver_option: d.replacement.escalation.waiver_option });
    }

    push(ticketId, 'WORK_ORDER_EMITTED', { work_order_id: entry.work_order_id });

    if (needsClientMessage(d)) {
      push(ticketId, 'COMMS_DRAFTED', { message_id: entry.message_id, recipient_role_mailbox: true });
    }
    if (entry.sent) {
      push(ticketId, 'COMMS_SENT', { message_id: entry.message_id, approved_by: entry.approved_by, sent_at: entry.sent_at });
    }
  }

  for (const qid of Object.keys(ledger.quarantine).sort()) {
    seq = 0;
    const q = ledger.quarantine[qid];
    push(qid, 'INGESTED', { source: q.quarantined_at_source, occurrences: q.occurrences });
    push(qid, 'QUARANTINED', { reason_codes: q.reason_codes, findings: q.findings.map((f) => f.code) });
  }

  return rows;
}

/**
 * Final PII gate on a whole output batch before it touches disk.
 *
 * `allowedEmails` is the small, explicit set of client role mailboxes a comms row
 * is allowed to name as its recipient (ASM-008) - a routing address on file, not
 * personal data. Every other row type is passed with no allowlist, so an email
 * address has no legitimate way to appear in a work order, quarantine record, or
 * audit line at all.
 */
function assertClean(rows, label, { allowedEmails = [] } = {}) {
  for (const row of rows) {
    const violations = pii.findViolations(JSON.stringify(row), { allow: allowedEmails });
    if (violations.length) {
      throw new Error(`PII GATE: ${label} row would expose ${violations.join(',')} - refusing to write. Row: ${JSON.stringify(row).slice(0, 200)}`);
    }
  }
}

module.exports = {
  buildWorkOrder, buildWorkOrders, buildMessageBody, needsClientMessage, recipientFor,
  buildCommsPending, buildCommsSent, buildQuarantine, buildAuditRows, assertClean,
};
