'use strict';
/**
 * The idempotency ledger.
 *
 * This is the one piece of state that survives between runs and between files.
 * Everything in outputs/ is a deterministic projection of this ledger plus the
 * current rulebook - never a running accumulation that could double-write.
 *
 * Why a ledger and not "check if the output file already has this id": the brief
 * promises a *second, smaller ticket file* in the final hour, arriving after the
 * main queue has already been processed. Rule 1 ("exactly one per unique valid
 * ticket") has to hold across that boundary, not just within one file. So the unit
 * of idempotency is the ticket_id, tracked here, and outputs/*.jsonl are rebuilt in
 * full from the ledger on every run - which also gives rule 2 (re-run twice,
 * identical output) for free, because "rebuild from the same state" is the
 * definition of idempotent.
 *
 * A ticket is decided exactly once. If the same ticket_id shows up again - same
 * file re-run, or the surprise file re-lists something the main queue already
 * handled - the stored decision is replayed, not recomputed. That is what makes
 * two runs byte-identical even if the rulebook's "as-of" clock or the hub distance
 * table changed in between: the work order a client already saw does not silently
 * change under them.
 */
const fs = require('fs');
const path = require('path');
const { readJsonIfExists, writeJson, shortHash } = require('../lib/util');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'state', 'ledger.json');
const SCHEMA_VERSION = 1;

function emptyLedger() {
  return { schema_version: SCHEMA_VERSION, accepted: {}, quarantine: {} };
}

function loadLedger(ledgerPath = LEDGER_PATH) {
  const ledger = readJsonIfExists(ledgerPath, null);
  if (!ledger || ledger.schema_version !== SCHEMA_VERSION) return emptyLedger();
  return ledger;
}

function saveLedger(ledger, ledgerPath = LEDGER_PATH) {
  writeJson(ledgerPath, ledger);
}

/** Deterministic ids. Same ticket_id -> same id, forever, on any machine. */
function workOrderId(ticketId) { return `WO-${shortHash(`wo:${ticketId}`, 10)}`; }
function messageId(ticketId) { return `MSG-${shortHash(`msg:${ticketId}`, 10)}`; }

/**
 * Merge one batch of validation results into the ledger.
 *
 * `decideFn(accepted)` is called only for ticket_ids the ledger has never seen
 * accepted before - the actual rule evaluation happens exactly once per ticket,
 * which is the whole point of persisting decisions rather than outputs.
 *
 * Returns a summary of what changed this run, for the audit trail and the console.
 */
function mergeBatch(ledger, { accepted, quarantine }, decideFn, log) {
  const changes = { newly_accepted: [], newly_quarantined: [], recovered: [], reaffirmed_duplicate: [], skipped_conflicting: [] };

  for (const q of quarantine) {
    if (ledger.quarantine[q.quarantine_id]) {
      changes.reaffirmed_duplicate.push(q.quarantine_id);
      continue;
    }
    ledger.quarantine[q.quarantine_id] = { ...q, first_seen_at_run: new Date().toISOString() };
    changes.newly_quarantined.push(q.quarantine_id);
  }

  for (const a of accepted) {
    const ticketId = a.ticket.ticket_id;

    if (ledger.accepted[ticketId]) {
      // Already decided in a prior run. The stored decision stands - see the
      // module note on why this is what makes re-runs byte-identical.
      changes.reaffirmed_duplicate.push(ticketId);
      continue;
    }

    // A ticket that was previously quarantined has now arrived valid - the
    // "surprise file" case where a correction supersedes a broken record.
    const wasQuarantined = Object.keys(ledger.quarantine).some(
      (qid) => ledger.quarantine[qid].ticket_id === ticketId
    );
    if (wasQuarantined) {
      for (const qid of Object.keys(ledger.quarantine)) {
        if (ledger.quarantine[qid].ticket_id === ticketId) delete ledger.quarantine[qid];
      }
      changes.recovered.push(ticketId);
      log.alert('QUARANTINE_RECOVERED', {
        ticket_id: ticketId,
        action: 'a corrected record for a previously quarantined ticket validated cleanly; promoted to accepted',
      });
    }

    const decision = decideFn(a);
    ledger.accepted[ticketId] = {
      decision,
      work_order_id: workOrderId(ticketId),
      message_id: messageId(ticketId),
      sent: false,
      approved_by: null,
      sent_at: null,
      first_seen_source: a.ticket._ingest.citation,
      first_seen_at_run: new Date().toISOString(),
    };
    changes.newly_accepted.push(ticketId);
  }

  return changes;
}

/**
 * Mark a ticket's message as sent. Called only from the approval flow, and only
 * once - run.js checks `entry.sent` before ever offering the prompt again.
 *
 * The recipient and body are frozen into the ledger at the moment of approval,
 * not recomputed from the decision on later runs. That is deliberate: what the
 * human approved is what gets replayed into comms_sent.jsonl forever, even if a
 * template or rulebook change would produce different wording tomorrow.
 */
function markSent(ledger, ticketId, { approvedBy, sentAt, recipient, body }) {
  const entry = ledger.accepted[ticketId];
  if (!entry) throw new Error(`markSent: no ledger entry for ${ticketId}`);
  entry.sent = true;
  entry.approved_by = approvedBy;
  entry.sent_at = sentAt;
  entry.sent_recipient = recipient;
  entry.sent_body = body;
}

module.exports = { loadLedger, saveLedger, emptyLedger, mergeBatch, markSent, workOrderId, messageId, LEDGER_PATH };
