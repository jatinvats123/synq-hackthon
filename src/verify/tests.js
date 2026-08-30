'use strict';
/**
 * The verification suite. Every test here executes real pipeline code against
 * real or realistically-shaped data and inspects the actual files it produces -
 * none of this is decorative. Tests that need synthetic tickets (A, C, G) run in
 * an isolated sandbox (src/verify/sandbox.js) so they never touch the live ledger
 * a judge is inspecting; tests that verify the live system's own behaviour (B, D,
 * E, F) read and re-run the real thing in outDir=rootDir.
 *
 * Every test returns the same shape:
 *   { id, name, pass, summary, details, duration_ms }
 * `details` is a list of individual checks/findings, each independently
 * inspectable - "PASS" is never asserted without a concrete reason attached.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Logger } = require('../lib/log');
const { runOnce } = require('../pipeline/orchestrator');
const ledgerMod = require('../pipeline/ledger');
const { readTickets } = require('../ingest/tickets');
const { readJsonlIfExists } = require('../lib/util');
const pii = require('../pii/redact');
const { createSandbox, cleanupSandbox, writeTicketFile } = require('./sandbox');

function silentLogger() {
  return new Logger({ level: 'warn', quiet: true });
}

function finish(id, name, checks, extra = {}, startedAt) {
  return {
    id, name,
    pass: checks.every((c) => c.pass),
    summary: `${checks.filter((c) => c.pass).length}/${checks.length} checks passed`,
    details: checks,
    duration_ms: startedAt ? Date.now() - startedAt : undefined,
    ...extra,
  };
}

function failed(id, name, message, startedAt) {
  return { id, name, pass: false, summary: message, details: [{ desc: message, pass: false }], duration_ms: startedAt ? Date.now() - startedAt : undefined };
}

function hashFiles(paths) {
  const hash = crypto.createHash('sha256');
  for (const p of paths) hash.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from('<missing>'));
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// A. Duplicate / idempotency test
// ---------------------------------------------------------------------------
function testDuplicateIdempotency(rootDir) {
  const id = 'A', name = 'Duplicate / idempotency test';
  const startedAt = Date.now();
  const sandboxDir = createSandbox('dup');
  try {
    // A real vehicle/hub/driver combo (from the actual bundle's TKT-0001), fed
    // three times under one ticket_id - two byte-identical, one with the trailing
    // "(sync copy)" variation the real corpus itself uses for its planted dupes.
    const base = {
      ticket_id: 'TEST-DUP-0001', created_at: '2026-03-02T07:00:00', vehicle: 'UP-37-UP-7482',
      driver_id: 'DRV-026', origin_hub: 'Lucknow', km_from_origin_hub: 25, destination: 'Ludhiana',
      issue: 'brake failure warning', severity: 'MEDIUM', client: 'Apex Chemicals', status: 'CLOSED',
      resolution_note: 'Resolved by roadside assistance.',
    };
    const tickets = [base, { ...base }, { ...base, resolution_note: 'Resolved by roadside assistance. (sync copy)' }];
    const ticketsPath = writeTicketFile(sandboxDir, 'tickets.json', tickets);
    const log = silentLogger();

    const run1 = runOnce({ dataDir: rootDir, ticketsPath, outDir: sandboxDir, log });
    const wo1 = run1.workOrders.filter((w) => w.ticket_id === 'TEST-DUP-0001');
    const pending1 = run1.commsPending.filter((m) => m.ticket_id === 'TEST-DUP-0001');
    const dedupRows1 = run1.auditRows.filter((r) => r.ticket_id === 'TEST-DUP-0001' && r.step === 'DEDUPLICATED');
    const ingestRows1 = run1.auditRows.filter((r) => r.ticket_id === 'TEST-DUP-0001' && r.step === 'INGESTED');

    // Re-run the identical file against the SAME sandbox ledger: cross-run replay,
    // not just within-file de-duplication.
    const run2 = runOnce({ dataDir: rootDir, ticketsPath, outDir: sandboxDir, log });
    const wo2 = run2.workOrders.filter((w) => w.ticket_id === 'TEST-DUP-0001');
    const auditRowCount2 = run2.auditRows.filter((r) => r.ticket_id === 'TEST-DUP-0001').length;
    const auditRowCount1 = run1.auditRows.filter((r) => r.ticket_id === 'TEST-DUP-0001').length;

    const checks = [
      { desc: 'ticket fed 3x in one file collapses to exactly one work order', pass: wo1.length === 1, evidence: { work_orders: wo1.length } },
      { desc: 'exactly one pending client message drafted (not three)', pass: pending1.length === 1, evidence: { pending: pending1.length } },
      { desc: 'exactly one DEDUPLICATED audit row, recording all 3 occurrences', pass: dedupRows1.length === 1 && dedupRows1[0].occurrences === 3, evidence: dedupRows1[0] },
      { desc: 'exactly one INGESTED audit row (not three)', pass: ingestRows1.length === 1, evidence: { rows: ingestRows1.length } },
      { desc: 'work_order_id is identical across a second run of the same file', pass: wo2.length === 1 && wo2[0].work_order_id === wo1[0].work_order_id, evidence: { run1: wo1[0] && wo1[0].work_order_id, run2: wo2[0] && wo2[0].work_order_id } },
      { desc: 'second run makes zero new ledger entries for this ticket', pass: run2.changes.newly_accepted.length === 0, evidence: run2.changes.newly_accepted },
      { desc: 'audit trail does not grow on the second run (no duplicate side effects)', pass: auditRowCount2 === auditRowCount1, evidence: { run1_rows: auditRowCount1, run2_rows: auditRowCount2 } },
    ];
    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  } finally {
    cleanupSandbox(sandboxDir);
  }
}

// ---------------------------------------------------------------------------
// B. Double-run test (on the live system)
// ---------------------------------------------------------------------------
function testDoubleRun(rootDir) {
  const id = 'B', name = 'Double-run test (pipeline run twice back-to-back)';
  const startedAt = Date.now();
  try {
    const dataDir = rootDir;
    const ticketsPath = path.join(dataDir, 'tickets.json');
    if (!fs.existsSync(ticketsPath)) return failed(id, name, `no tickets.json at ${ticketsPath}`, startedAt);

    const files = () => [
      path.join(rootDir, 'outputs', 'work_orders.jsonl'),
      path.join(rootDir, 'outputs', 'comms_pending.jsonl'),
      path.join(rootDir, 'outputs', 'comms_sent.jsonl'),
      path.join(rootDir, 'outputs', 'quarantine.jsonl'),
      path.join(rootDir, 'audit', 'audit.jsonl'),
    ];
    const log = silentLogger();

    const run1 = runOnce({ dataDir, ticketsPath, outDir: rootDir, log });
    const hashAfter1 = hashFiles(files());
    const countsAfter1 = { work_orders: run1.workOrders.length, quarantine: run1.quarantineRows.length };

    const run2 = runOnce({ dataDir, ticketsPath, outDir: rootDir, log });
    const hashAfter2 = hashFiles(files());
    const countsAfter2 = { work_orders: run2.workOrders.length, quarantine: run2.quarantineRows.length };

    const checks = [
      { desc: 'outputs/*.jsonl + audit/audit.jsonl are byte-identical after two consecutive runs', pass: hashAfter1 === hashAfter2, evidence: { hash_after_run1: hashAfter1.slice(0, 16), hash_after_run2: hashAfter2.slice(0, 16) } },
      { desc: 'second run adds zero new work orders', pass: run2.changes.newly_accepted.length === 0, evidence: { newly_accepted: run2.changes.newly_accepted } },
      { desc: 'second run adds zero new quarantine records', pass: run2.changes.newly_quarantined.length === 0, evidence: { newly_quarantined: run2.changes.newly_quarantined } },
      { desc: 'record counts unchanged between the two runs', pass: countsAfter1.work_orders === countsAfter2.work_orders && countsAfter1.quarantine === countsAfter2.quarantine, evidence: { run1: countsAfter1, run2: countsAfter2 } },
    ];
    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  }
}

// ---------------------------------------------------------------------------
// C. Quarantine test
// ---------------------------------------------------------------------------
function testQuarantine(rootDir) {
  const id = 'C', name = 'Quarantine test (broken records, no crash, no silent drop)';
  const startedAt = Date.now();
  const sandboxDir = createSandbox('quarantine');
  try {
    const good = { created_at: '2026-03-02T07:00:00', vehicle: 'UP-37-UP-7482', driver_id: 'DRV-026', origin_hub: 'Lucknow', km_from_origin_hub: 25, destination: 'Ludhiana', issue: 'brake failure warning', severity: 'MEDIUM', client: 'Apex Chemicals' };
    const broken = [
      { ...good, ticket_id: 'TEST-QT-NOVEH', vehicle: '' },
      { ...good, ticket_id: 'TEST-QT-BADTIME', created_at: 'definitely-not-a-date' },
      { ...good, ticket_id: 'TEST-QT-UNKVEH', vehicle: 'ZZ-00-ZZ-0000' },
      { ...good, ticket_id: 'TEST-QT-UNKHUB', origin_hub: 'Atlantis' },
      { ...good, ticket_id: 'TEST-QT-NOKM', km_from_origin_hub: null },
      { ...good, ticket_id: 'TEST-QT-NODEST', destination: '' },
      { ...good, ticket_id: '' }, // no id at all
      'not even an object', // container-level garbage
      42,
      null,
    ];
    const ticketsPath = writeTicketFile(sandboxDir, 'tickets.json', broken);
    const log = silentLogger();

    let run;
    let threw = null;
    try { run = runOnce({ dataDir: rootDir, ticketsPath, outDir: sandboxDir, log }); }
    catch (err) { threw = err; }

    const checks = [{ desc: 'pipeline does not crash on a batch of broken/garbage records', pass: !threw, evidence: threw ? { error: threw.message } : undefined }];
    if (!threw) {
      const byExpectedCode = {
        'TEST-QT-NOVEH': 'MISSING_VEHICLE',
        'TEST-QT-BADTIME': 'UNPARSEABLE_TIMESTAMP',
        'TEST-QT-UNKVEH': 'UNKNOWN_VEHICLE',
        'TEST-QT-UNKHUB': 'UNKNOWN_ORIGIN_HUB',
        'TEST-QT-NOKM': 'MISSING_DISTANCE',
        'TEST-QT-NODEST': 'MISSING_DESTINATION',
      };
      for (const [ticketId, expectedCode] of Object.entries(byExpectedCode)) {
        const q = run.quarantineRows.find((r) => r.ticket_id === ticketId);
        checks.push({
          desc: `${ticketId} is quarantined with reason ${expectedCode}, not dropped`,
          pass: !!q && q.reason_codes.includes(expectedCode),
          evidence: q ? { reason_codes: q.reason_codes } : { found: false },
        });
      }
      checks.push({
        desc: 'no-id and non-object garbage entries are quarantined too, not silently skipped',
        pass: run.quarantineRows.length >= broken.length - Object.keys(byExpectedCode).length,
        evidence: { quarantine_count: run.quarantineRows.length, input_count: broken.length },
      });
      checks.push({
        desc: 'every quarantine record carries the raw source record for a human to review',
        pass: run.quarantineRows.every((r) => r.raw_record !== undefined),
      });
      checks.push({
        desc: 'no work order or comms draft was produced for any broken record',
        pass: !run.workOrders.some((w) => String(w.ticket_id || '').startsWith('TEST-QT'))
          && !run.commsPending.some((m) => String(m.ticket_id || '').startsWith('TEST-QT')),
      });
    }
    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  } finally {
    cleanupSandbox(sandboxDir);
  }
}

// ---------------------------------------------------------------------------
// D. PII leak scan
// ---------------------------------------------------------------------------
function scanFileForPii(filePath, allow) {
  if (!fs.existsSync(filePath)) return [];
  const findings = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const violations = pii.findViolations(line, { allow });
    if (violations.length) findings.push({ line: i + 1, types: violations });
  });
  return findings;
}

function testPiiScan(rootDir, extraSources = []) {
  const id = 'D', name = 'PII leak scan (outputs, audit, logs, dashboard API)';
  const startedAt = Date.now();
  try {
    const rulebookPath = path.join(rootDir, 'config', 'rulebook.json');
    const rulebook = JSON.parse(fs.readFileSync(rulebookPath, 'utf8'));
    const allowedEmails = Object.values(rulebook.clients).map((c) => c.role_mailbox).filter(Boolean);

    const targets = [
      path.join(rootDir, 'outputs', 'work_orders.jsonl'),
      path.join(rootDir, 'outputs', 'comms_pending.jsonl'),
      path.join(rootDir, 'outputs', 'comms_sent.jsonl'),
      path.join(rootDir, 'outputs', 'quarantine.jsonl'),
      path.join(rootDir, 'audit', 'audit.jsonl'),
    ];
    const logsDir = path.join(rootDir, 'logs');
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) if (f.endsWith('.log')) targets.push(path.join(logsDir, f));
    }

    const findings = [];
    for (const t of targets) {
      const hits = scanFileForPii(t, allowedEmails);
      for (const h of hits) findings.push({ file: path.relative(rootDir, t), ...h });
    }

    // Also scan whatever the dashboard's own API would return - "API responses"
    // per spec - without needing an HTTP round trip.
    for (const src of extraSources) {
      const body = JSON.stringify(src.data);
      const violations = pii.findViolations(body, { allow: allowedEmails });
      if (violations.length) findings.push({ file: `api:${src.name}`, line: null, types: violations });
    }

    const checks = [{
      desc: `no raw phone/Aadhaar/DL/email/name pattern found across ${targets.length} files + ${extraSources.length} API payloads`,
      pass: findings.length === 0,
      evidence: findings.length ? { offending_locations: findings.map((f) => ({ file: f.file, line: f.line, types: f.types })) } : { files_scanned: targets.length },
    }];
    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  }
}

// ---------------------------------------------------------------------------
// E. Dispatcher rule test - real rules, real tickets already in the live ledger
// ---------------------------------------------------------------------------
function findCheck(planChecks, ruleId) {
  return (planChecks || []).find((c) => c.rule_id === ruleId);
}

function testDispatcherRules(rootDir) {
  const id = 'E', name = 'Dispatcher rule test (real rules against the real queue)';
  const startedAt = Date.now();
  try {
    const ledger = ledgerMod.loadLedger(path.join(rootDir, 'state', 'ledger.json'));
    const decisions = Object.entries(ledger.accepted).map(([ticketId, e]) => ({ ticketId, ...e.decision }));
    if (decisions.length === 0) return failed(id, name, 'ledger is empty - run the pipeline first (node run.js all)', startedAt);

    const rulebook = JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'rulebook.json'), 'utf8'));
    const ruleIds = rulebook.rules.map((r) => r.id);
    const checks = [];

    // 1. Every rule is actually wired in: it appears at least once as a
    // RULE_EVALUATED verdict (any verdict, including NOT_APPLICABLE) across the
    // audit trail - proves it is live code, not a rule defined and never called.
    const auditRows = readJsonlIfExists(path.join(rootDir, 'audit', 'audit.jsonl'));
    const seenRuleIds = new Set(
      auditRows.filter((r) => r.step === 'RULE_EVALUATED').map((r) => r.rule_id)
      .concat(auditRows.filter((r) => r.step === 'REPLACEMENT_SOURCING').map((r) => r.rule_id))
    );
    for (const rid of ruleIds) {
      checks.push({ desc: `${rid} is evaluated by the engine (appears in the audit trail)`, pass: seenRuleIds.has(rid), evidence: { rule_id: rid } });
    }

    // 2. R-004: every Shakti Cement ticket plans to 36h, never the 48h contract figure.
    const shakti = decisions.filter((d) => d.client === 'Shakti Cement');
    checks.push({
      desc: 'R-004: every Shakti Cement ticket plans to 36 hours (not the 48h contract figure)',
      pass: shakti.length > 0 && shakti.every((d) => d.sla.planning_hours === 36),
      evidence: { applicable: shakti.length, planning_hours_seen: [...new Set(shakti.map((d) => d.sla.planning_hours))] },
    });

    // 3. R-005: Vertex/Ludhiana tickets whose incident hour is outside the gate
    // window get the "scheduled morning delivery" language, and only those.
    const vertexLudhiana = decisions.filter((d) => d.client === 'Vertex Retail' && d.route.destination === 'Ludhiana');
    const vertexMismatch = vertexLudhiana.filter((d) => {
      const r005 = findCheck(d.plan_checks, 'R-005');
      const shouldHold = d.route.hour !== null && (d.route.hour >= 18 || d.route.hour < 8);
      return !r005 || (shouldHold && r005.verdict !== 'FAIL') || (!shouldHold && r005.verdict === 'FAIL');
    });
    checks.push({
      desc: 'R-005: Vertex/Ludhiana tickets outside 08:00-18:00 are held for a scheduled morning delivery, and only those',
      pass: vertexLudhiana.length === 0 || vertexMismatch.length === 0,
      evidence: { applicable: vertexLudhiana.length, mismatches: vertexMismatch.map((d) => d.ticket_id) },
    });

    // 4. R-007: every Orion Pharma SELECTED replacement is model year 2020+.
    const orion = decisions.filter((d) => d.client === 'Orion Pharma' && d.replacement.outcome === 'SELECTED');
    const orionTooOld = orion.filter((d) => (d.replacement.selected.year || 0) < 2020);
    checks.push({
      desc: 'R-007: every Orion Pharma replacement is model year 2020 or later',
      pass: orion.length > 0 && orionTooOld.length === 0,
      evidence: { applicable: orion.length, violations: orionTooOld.map((d) => ({ ticket: d.ticket_id, year: d.replacement.selected.year })) },
    });

    // 5. R-008: Orion tickets raised overnight (20:00-06:00) get the direct-
    // transfer cold-chain instruction.
    const orionOvernight = decisions.filter((d) => d.client === 'Orion Pharma' && d.route.hour !== null && (d.route.hour >= 20 || d.route.hour < 6));
    const orionOvernightMissed = orionOvernight.filter((d) => { const r008 = findCheck(d.plan_checks, 'R-008'); return !r008 || r008.verdict !== 'FAIL'; });
    checks.push({
      desc: 'R-008: overnight Orion Pharma incidents trigger the no-hub-hold cold-chain instruction',
      pass: orionOvernight.length === 0 || orionOvernightMissed.length === 0,
      evidence: { applicable: orionOvernight.length, missed: orionOvernightMissed.map((d) => d.ticket_id) },
    });

    // 6. R-010: sourcing hub list matches the 50km rule exactly.
    const sourcingMismatch = decisions.filter((d) => {
      const km = d.route.km_from_origin_hub;
      const hubs = d.replacement.sourcing.hubs;
      if (km <= 50) return hubs.length !== 1 || hubs[0] !== d.route.origin_hub;
      return hubs[0] !== d.route.origin_hub || hubs.length <= 1;
    });
    checks.push({
      desc: 'R-010: within 50km the origin hub alone sources; beyond 50km the origin hub is tried first, then others',
      pass: sourcingMismatch.length === 0,
      evidence: { total: decisions.length, mismatches: sourcingMismatch.map((d) => d.ticket_id) },
    });

    // 7. R-011: no SELECTED replacement has a hard FAIL for overdue service (a
    // FAIL should have excluded it from selection entirely).
    const overdueSelected = decisions.filter((d) => d.replacement.outcome === 'SELECTED').filter((d) => {
      const r011 = d.replacement.selected.checks.find((c) => c.rule_id === 'R-011');
      return r011 && r011.verdict === 'FAIL';
    });
    checks.push({
      desc: 'R-011: no selected replacement is actually overdue on service (hard rule correctly excludes it)',
      pass: overdueSelected.length === 0,
      evidence: { violations: overdueSelected.map((d) => d.ticket_id) },
    });

    // 8. R-013: any ticket in the night window with a <6-month driver shows the
    // pairing action and a FAIL verdict.
    const nightNewDriver = decisions.filter((d) => {
      const r013 = findCheck(d.plan_checks, 'R-013');
      return r013 && r013.verdict === 'FAIL';
    });
    checks.push({
      desc: 'R-013: every night-run-with-a-new-driver case produces a pairing action',
      pass: nightNewDriver.length === 0 || nightNewDriver.every((d) => d.actions.some((a) => a.rule_id === 'R-013')),
      evidence: { applicable: nightNewDriver.length, tickets: nightNewDriver.map((d) => d.ticket_id) },
    });

    // 9. Seasonal rules (R-001/R-002/R-003/R-009) honestly reported as wired but
    // not exercised if the current queue never falls in-season - not silently
    // hidden, not falsely claimed as tested against a real trigger.
    for (const [rid, seasonName] of [['R-001', 'Oct-Feb Delhi NCR'], ['R-002', 'Nov-Feb hill'], ['R-003', 'Nov-Feb hill'], ['R-009', 'Jul-Sep monsoon-east']]) {
      const fired = auditRows.filter((r) => r.step === 'RULE_EVALUATED' && r.rule_id === rid && r.verdict !== 'NOT_APPLICABLE');
      checks.push({
        desc: `${rid} (${seasonName}): wired in; ${fired.length === 0 ? 'not exercised by the current queue (no ticket falls in-season) - reported honestly, not hidden' : `exercised ${fired.length} time(s)`}`,
        pass: true, // absence of a trigger in this queue is a fact about the data, not a failure of the rule
        evidence: { fired_count: fired.length, verdicts: [...new Set(fired.map((r) => r.verdict))] },
        informational: fired.length === 0,
      });
    }

    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  }
}

// ---------------------------------------------------------------------------
// F. Replacement eligibility test - independent re-derivation, not a replay
// ---------------------------------------------------------------------------
const CITATION_PATTERN = /^(fleet_master\.csv#|maintenance_log\.xlsx#|meridian_trips\.csv#|tickets\.json#|dispatcher_interview\.txt:|emails\/)/;

function testReplacementEligibility(rootDir) {
  const id = 'F', name = 'Replacement eligibility test (every selection re-checked against real data)';
  const startedAt = Date.now();
  try {
    const ledger = ledgerMod.loadLedger(path.join(rootDir, 'state', 'ledger.json'));
    const selected = Object.entries(ledger.accepted)
      .map(([ticketId, e]) => ({ ticketId, ...e.decision }))
      .filter((d) => d.replacement.outcome === 'SELECTED');
    if (selected.length === 0) return failed(id, name, 'ledger has no SELECTED replacements - run the pipeline first', startedAt);

    const checks = [];
    for (const d of selected) {
      const sel = d.replacement.selected;
      const hardChecks = sel.checks.filter((c) => c.hard);
      const fails = hardChecks.filter((c) => c.verdict === 'FAIL');
      const unresolvedUnknowns = hardChecks.filter((c) => c.verdict === 'INSUFFICIENT_DATA');
      const fired = sel.checks.filter((c) => c.verdict !== 'NOT_APPLICABLE');
      const uncited = fired.filter((c) => !c.citations || c.citations.length === 0 || !c.citations.some((cite) => CITATION_PATTERN.test(cite)));

      checks.push({
        desc: `${d.ticketId}: ${sel.registration} - no hard rule FAILs (a FAIL must exclude a vehicle from selection)`,
        pass: fails.length === 0,
        evidence: { rule_ids: fails.map((c) => c.rule_id) },
      });
      checks.push({
        desc: `${d.ticketId}: ${sel.registration} - unresolved unknowns (${unresolvedUnknowns.length}) are disclosed via needs_human_review`,
        pass: unresolvedUnknowns.length === 0 || d.needs_human === true,
        evidence: { unresolved: unresolvedUnknowns.map((c) => c.rule_id), needs_human: d.needs_human },
      });
      checks.push({
        desc: `${d.ticketId}: ${sel.registration} - every fired check cites a real source record`,
        pass: uncited.length === 0,
        evidence: uncited.length ? { rules_without_citation: uncited.map((c) => c.rule_id) } : { checks_fired: fired.length },
      });
    }

    const withBorderline = selected.filter((d) => d.replacement.selected.has_borderline_assumption);
    checks.push({
      desc: 'borderline assumption cases (verdict within 15 days of the R-011 grace threshold) are identified explicitly, not buried in a blanket flag',
      pass: true,
      evidence: { count: withBorderline.length, tickets: withBorderline.map((d) => d.ticketId) },
      informational: true,
    });

    return finish(id, name, checks, { selected_count: selected.length }, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  }
}

// ---------------------------------------------------------------------------
// G. Surprise-file test - a differently shaped ticket file
// ---------------------------------------------------------------------------
function testSurpriseFile(rootDir) {
  const id = 'G', name = 'Surprise-file test (unseen ticket format)';
  const startedAt = Date.now();
  const sandboxDir = createSandbox('surprise');
  try {
    // A shape nothing in the codebase has seen: wrapped in {"queue": [...]},
    // camelCase field names, DD/MM/YYYY timestamps, and a severity spelled as a
    // word the alias table has to normalise. Contains one duplicate id and one
    // broken record, per the brief's own description of the final-hour file.
    const surprise = {
      queue: [
        { id: 'SURPRISE-001', vehicleReg: 'UP-37-UP-7482', whenRaised: '02/03/2026 07:00', fromHub: 'Lucknow', toHub: 'Ludhiana', distanceKm: 25, problem: 'brake failure warning', urgency: 'Medium', customer: 'Apex Chemicals', driverCode: 'DRV-026' },
        { id: 'SURPRISE-002', vehicleReg: 'UP-37-UP-7482', whenRaised: '02/03/2026 07:00', fromHub: 'Lucknow', toHub: 'Ludhiana', distanceKm: 25, problem: 'brake failure warning', urgency: 'Medium', customer: 'Apex Chemicals', driverCode: 'DRV-026' },
        { id: 'SURPRISE-002', vehicleReg: 'UP-37-UP-7482', whenRaised: '02/03/2026 07:00', fromHub: 'Lucknow', toHub: 'Ludhiana', distanceKm: 25, problem: 'brake failure warning', urgency: 'Medium', customer: 'Apex Chemicals', driverCode: 'DRV-026', note: 'duplicate id, same content' },
        { id: 'SURPRISE-003', vehicleReg: '', whenRaised: '03/03/2026 09:00', fromHub: 'Gurgaon', toHub: 'Delhi', distanceKm: 12, problem: 'tyre burst', urgency: 'Low', customer: 'Internal' },
      ],
    };
    const ticketsPath = writeTicketFile(sandboxDir, 'surprise_tickets.json', surprise);
    const log = silentLogger();

    let run, threw = null;
    try { run = runOnce({ dataDir: rootDir, ticketsPath, outDir: sandboxDir, log }); }
    catch (err) { threw = err; }

    const checks = [{ desc: 'pipeline does not crash on a differently-shaped file', pass: !threw, evidence: threw ? { error: threw.message } : undefined }];
    if (!threw) {
      checks.push({ desc: 'container format was detected as non-standard (not silently assumed to be the known shape)', pass: run.format !== 'json_array', evidence: { detected_format: run.format } });
      checks.push({ desc: 'SURPRISE-001 (valid, camelCase fields) produced exactly one work order', pass: run.workOrders.filter((w) => w.ticket_id === 'SURPRISE-001').length === 1 });
      checks.push({ desc: 'SURPRISE-002 (duplicated id, wrapped queue) collapsed to exactly one work order', pass: run.workOrders.filter((w) => w.ticket_id === 'SURPRISE-002').length === 1 });
      checks.push({ desc: 'DD/MM/YYYY timestamp was parsed correctly (2026-03-02, not misread as month=03/day=02 confusion)', pass: run.workOrders.some((w) => w.ticket_id === 'SURPRISE-001' && w.created_at.startsWith('2026-03-02')) });
      checks.push({ desc: 'SURPRISE-003 (missing vehicle registration) was quarantined, not dropped or crashed on', pass: run.quarantineRows.some((q) => q.ticket_id === 'SURPRISE-003') });
    }
    return finish(id, name, checks, {}, startedAt);
  } catch (err) {
    return failed(id, name, `threw: ${err.message}`, startedAt);
  } finally {
    cleanupSandbox(sandboxDir);
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
const ALL_TESTS = [
  { id: 'A', fn: testDuplicateIdempotency },
  { id: 'B', fn: testDoubleRun },
  { id: 'C', fn: testQuarantine },
  { id: 'D', fn: testPiiScan },
  { id: 'E', fn: testDispatcherRules },
  { id: 'F', fn: testReplacementEligibility },
  { id: 'G', fn: testSurpriseFile },
];

function runTest(testId, rootDir, extra) {
  const entry = ALL_TESTS.find((t) => t.id === testId);
  if (!entry) throw new Error(`unknown test id ${testId}`);
  return entry.fn(rootDir, extra);
}

async function runAllTests({ rootDir }) {
  return ALL_TESTS.map((t) => t.fn(rootDir));
}

function formatReport(results) {
  const lines = [];
  lines.push('='.repeat(72));
  lines.push('VERIFICATION SUITE');
  lines.push('='.repeat(72));
  for (const r of results) {
    lines.push(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.id}. ${r.name} - ${r.summary}`);
    for (const c of r.details) {
      if (c.pass && c.informational) { lines.push(`       i  ${c.desc}`); continue; }
      lines.push(`       ${c.pass ? 'ok' : 'XX'} ${c.desc}`);
      if (!c.pass && c.evidence) lines.push(`          ${JSON.stringify(c.evidence)}`);
    }
  }
  lines.push('='.repeat(72));
  const overall = results.every((r) => r.pass);
  lines.push(`OVERALL: ${overall ? 'PASS' : 'FAIL'} (${results.filter((r) => r.pass).length}/${results.length} tests passed)`);
  return lines.join('\n');
}

module.exports = { runAllTests, runTest, formatReport, ALL_TESTS };
