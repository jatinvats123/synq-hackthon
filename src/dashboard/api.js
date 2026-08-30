'use strict';
/**
 * Data layer for the dashboard. Every function here reads real files - the
 * ledger, outputs/, audit/, logs/, config/rulebook.json - and returns plain
 * JSON-serialisable objects. Nothing here fabricates a record: an empty section
 * in the UI means the underlying file is genuinely empty, not that a mock was
 * omitted.
 *
 * `approveTicket` is the one function that writes. It reuses the exact same
 * `markSent` ledger function the CLI's `node run.js all --approve` uses, so the
 * dashboard's approve button and the terminal's approval flow are one code path,
 * not two that could drift apart.
 */
const fs = require('fs');
const path = require('path');

const ledgerMod = require('../pipeline/ledger');
const emit = require('../pipeline/emit');
const { materialiseOutputsAt } = require('../pipeline/orchestrator');
const { readJsonlIfExists, readJsonIfExists } = require('../lib/util');
const { Logger } = require('../lib/log');
const pii = require('../pii/redact');

function rulebookPath(rootDir) { return path.join(rootDir, 'config', 'rulebook.json'); }
function assumptionsPath(rootDir) { return path.join(rootDir, 'config', 'assumptions.json'); }
function ledgerPath(rootDir) { return path.join(rootDir, 'state', 'ledger.json'); }

/**
 * A minimal stand-in for the full context object, carrying only what
 * materialiseOutputsAt / emit.js actually read (ctx.config.rulebook) - so an
 * approve click doesn't have to re-parse a 2.6MB trips CSV and 250-row
 * maintenance log just to write one sent message.
 */
function lightweightCtx(rootDir) {
  return { config: { rulebook: JSON.parse(fs.readFileSync(rulebookPath(rootDir), 'utf8')) } };
}

function loadLedger(rootDir) {
  return ledgerMod.loadLedger(ledgerPath(rootDir));
}

function outputRows(rootDir, name) {
  return readJsonlIfExists(path.join(rootDir, 'outputs', name));
}

function auditRows(rootDir) {
  return readJsonlIfExists(path.join(rootDir, 'audit', 'audit.jsonl'));
}

function lastRunInfo(rootDir) {
  const logsDir = path.join(rootDir, 'logs');
  if (!fs.existsSync(logsDir)) return { at: null, alerts: [] };
  const files = fs.readdirSync(logsDir).filter((f) => f.startsWith('run_') && f.endsWith('.log')).sort();
  if (!files.length) return { at: null, alerts: [] };
  const latest = files[files.length - 1];
  const fullPath = path.join(logsDir, latest);
  const rows = readJsonlIfExists(fullPath);
  return {
    at: fs.statSync(fullPath).mtime.toISOString(),
    file: latest,
    alerts: rows.filter((r) => r.event && r.event.startsWith('ALERT')),
    errors: rows.filter((r) => r.level === 'error'),
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function getOverview(rootDir) {
  const ledger = loadLedger(rootDir);
  const accepted = Object.values(ledger.accepted);
  const context = readJsonIfExists(path.join(rootDir, 'data', 'context.json'), null);
  const run = lastRunInfo(rootDir);

  return {
    total_unique_valid_tickets: accepted.length,
    work_orders_created: accepted.length,
    tickets_quarantined: Object.keys(ledger.quarantine).length,
    pending_client_approvals: accepted.filter((e) => !e.sent && emit.needsClientMessage(e.decision)).length,
    messages_sent: accepted.filter((e) => e.sent).length,
    needs_human_review: accepted.filter((e) => e.decision.needs_human).length,
    last_run_at: run.at,
    last_run_alert_count: run.alerts.length,
    as_of: context ? context.as_of : null,
  };
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------
function getWorkOrders(rootDir) {
  return outputRows(rootDir, 'work_orders.jsonl');
}

/** Full decision trail for one ticket: the stored decision plus its audit rows. */
function getWorkOrderDetail(rootDir, ticketId) {
  const ledger = loadLedger(rootDir);
  const entry = ledger.accepted[ticketId];
  if (!entry) return null;
  const allAudit = auditRows(rootDir);
  return {
    ticket_id: ticketId,
    work_order_id: entry.work_order_id,
    message_id: entry.message_id,
    sent: entry.sent,
    approved_by: entry.approved_by,
    sent_at: entry.sent_at,
    decision: entry.decision,
    audit_trail: allAudit.filter((r) => r.ticket_id === ticketId).sort((a, b) => a.seq - b.seq),
  };
}

// ---------------------------------------------------------------------------
// Comms
// ---------------------------------------------------------------------------
function getPending(rootDir) {
  const ledger = loadLedger(rootDir);
  const rulebook = lightweightCtx(rootDir).config.rulebook;
  return emit.buildCommsPending(ledger, rulebook);
}

function getSent(rootDir) {
  return outputRows(rootDir, 'comms_sent.jsonl');
}

/**
 * Approve one pending message. Idempotent: a second call (double-click, retry)
 * for an already-sent ticket returns the existing sent record and writes
 * nothing - it never creates a second comms_sent row or a second audit entry.
 */
function approveTicket(rootDir, ticketId, approvedBy) {
  const ledger = loadLedger(rootDir);
  const entry = ledger.accepted[ticketId];
  if (!entry) return { ok: false, status: 404, error: `no such ticket: ${ticketId}` };

  if (entry.sent) {
    return { ok: true, already_sent: true, message_id: entry.message_id, approved_by: entry.approved_by, sent_at: entry.sent_at };
  }

  const ctx = lightweightCtx(rootDir);
  const pending = emit.buildCommsPending(ledger, ctx.config.rulebook);
  const msg = pending.find((m) => m.ticket_id === ticketId);
  if (!msg) {
    return { ok: false, status: 409, error: 'no pending message for this ticket (client unknown, internal ticket, or already sent)' };
  }

  const approver = String(approvedBy || '').trim() || 'dashboard-user';
  const sentAt = new Date().toISOString();
  ledgerMod.markSent(ledger, ticketId, { approvedBy: approver, sentAt, recipient: msg.recipient, body: msg.body });
  ledgerMod.saveLedger(ledger, ledgerPath(rootDir));

  const log = new Logger({ level: 'warn', quiet: true });
  materialiseOutputsAt(ledger, ctx, log, rootDir);

  return { ok: true, already_sent: false, message_id: entry.message_id, approved_by: approver, sent_at: sentAt };
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------
function getQuarantine(rootDir) {
  return outputRows(rootDir, 'quarantine.jsonl');
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
function getAudit(rootDir, ticketFilter) {
  const rows = auditRows(rootDir);
  if (!ticketFilter) return rows;
  return rows.filter((r) => r.ticket_id.toLowerCase().includes(String(ticketFilter).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Dispatcher rules
// ---------------------------------------------------------------------------
function getRules(rootDir) {
  const rulebook = JSON.parse(fs.readFileSync(rulebookPath(rootDir), 'utf8'));
  const assumptions = readJsonIfExists(assumptionsPath(rootDir), {});
  const rows = auditRows(rootDir);
  const evaluated = rows.filter((r) => r.step === 'RULE_EVALUATED' || (r.step === 'REPLACEMENT_SOURCING' && r.rule_id));

  return rulebook.rules.map((r) => {
    const hits = evaluated.filter((row) => row.rule_id === r.id);
    const byVerdict = {};
    const ticketsAffected = new Set();
    for (const h of hits) {
      if (h.verdict) byVerdict[h.verdict] = (byVerdict[h.verdict] || 0) + 1;
      if (h.verdict && h.verdict !== 'NOT_APPLICABLE') ticketsAffected.add(h.ticket_id);
    }
    return {
      id: r.id,
      name: r.name,
      hard: r.hard,
      statement: r.statement,
      rationale: r.rationale,
      citations: r.citations.concat(r.corroboration || []),
      assumptions: (r.assumptions || []).map((aid) => ({ id: aid, ...(assumptions[aid] || {}) })),
      times_evaluated: hits.length,
      verdict_breakdown: byVerdict,
      tickets_affected: ticketsAffected.size,
    };
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
function getHealth(rootDir) {
  const ledger = loadLedger(rootDir);
  const accepted = Object.values(ledger.accepted);
  const run = lastRunInfo(rootDir);
  const rulebook = JSON.parse(fs.readFileSync(rulebookPath(rootDir), 'utf8'));
  const allowedEmails = Object.values(rulebook.clients).map((c) => c.role_mailbox).filter(Boolean);

  // Live PII sweep of the actual output files, same detector the write-time gate
  // uses - this is what "PII safety status" reports, not a cached assumption.
  const targets = ['work_orders.jsonl', 'comms_pending.jsonl', 'comms_sent.jsonl', 'quarantine.jsonl']
    .map((f) => path.join(rootDir, 'outputs', f))
    .concat([path.join(rootDir, 'audit', 'audit.jsonl')]);
  let piiViolations = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    for (const line of fs.readFileSync(t, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      if (pii.findViolations(line, { allow: allowedEmails }).length) piiViolations++;
    }
  }

  return {
    last_run_at: run.at,
    processed: accepted.length,
    quarantined: Object.keys(ledger.quarantine).length,
    dispatched: accepted.filter((e) => e.decision.replacement.outcome === 'SELECTED' && !e.decision.needs_human).length,
    needs_review: accepted.filter((e) => e.decision.needs_human).length,
    escalated_no_vehicle: accepted.filter((e) => e.decision.replacement.outcome === 'NO_ELIGIBLE_VEHICLE').length,
    errors_last_run: run.errors.length,
    alerts_last_run: run.alerts.length,
    idempotency_status: 'verified by test B - see Verification tab',
    pii_safety_status: piiViolations === 0 ? 'CLEAN' : `${piiViolations} VIOLATION(S) FOUND`,
    pii_violations: piiViolations,
  };
}

module.exports = {
  getOverview, getWorkOrders, getWorkOrderDetail, getPending, getSent, approveTicket,
  getQuarantine, getAudit, getRules, getHealth, lightweightCtx, loadLedger, lastRunInfo,
};
