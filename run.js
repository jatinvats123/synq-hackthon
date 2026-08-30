#!/usr/bin/env node
'use strict';
/**
 * Single entry point for the whole system.
 *
 *   node run.js                 process ROOT/tickets.json, write outputs/ + audit/
 *   node run.js all --approve   same, then walk through comms_pending interactively
 *   node run.js --tickets <path> [--approve]   process a different/surprise file
 *   node run.js approve         re-run (cheap, deterministic) then just approve
 *   node run.js pii-scan        report name-shaped tokens the redactor may be missing
 *   node run.js reset           wipe state/ledger.json (start the ledger over)
 *   node run.js dashboard       serve the live verification dashboard at http://localhost:3000
 *   node run.js selftest        run every verification test (see src/verify/) and print PASS/FAIL
 *
 * Flags:
 *   --as-of YYYY-MM-DD   evaluate recency rules as of this date (default: config)
 *   --data-dir <path>    where the client bundle lives (default: this directory)
 *   --quiet              suppress info-level console output (warnings still show)
 *   --port <n>           dashboard port (default 3000)
 *
 * The actual pipeline logic (ingest -> validate -> decide -> ledger -> outputs) is
 * in src/pipeline/orchestrator.js, so the dashboard and the verification test
 * harness can drive it directly rather than shelling out to this CLI.
 */
const fs = require('fs');
const path = require('path');

const { Logger } = require('./src/lib/log');
const { runOnce, materialiseOutputsAt } = require('./src/pipeline/orchestrator');
const ledgerMod = require('./src/pipeline/ledger');
const emit = require('./src/pipeline/emit');
const { runApprovalSession } = require('./src/pipeline/approve');
const { ensureDir } = require('./src/lib/util');
const { collectNames, scanUncovered } = require('./src/pii/names');

const ROOT = __dirname;

function parseArgs(argv) {
  const args = { command: 'all', flags: {} };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('-')) { args.command = rest.shift(); }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--approve') args.flags.approve = true;
    else if (a === '--quiet') args.flags.quiet = true;
    else if (a === '--as-of') args.flags.asOf = rest[++i];
    else if (a === '--tickets') args.flags.tickets = rest[++i];
    else if (a === '--data-dir') args.flags.dataDir = rest[++i];
    else if (a === '--yes-approver') args.flags.approverName = rest[++i];
    else if (a === '--port') args.flags.port = Number(rest[++i]);
  }
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function commandAll(flags, log) {
  const dataDir = flags.dataDir || ROOT;
  const ticketsPath = flags.tickets || path.join(dataDir, 'tickets.json');

  if (!fs.existsSync(ticketsPath)) {
    log.error('tickets.missing', { path: ticketsPath });
    process.exitCode = 1;
    return;
  }

  const { ledger, changes, commsPending, ctx } = runOnce({ dataDir, ticketsPath, outDir: ROOT, asOf: flags.asOf || null, log });

  log.info('ledger.merged', {
    file: path.basename(ticketsPath),
    newly_accepted: changes.newly_accepted.length,
    newly_quarantined: changes.newly_quarantined.length,
    recovered_from_quarantine: changes.recovered.length,
    already_known: changes.reaffirmed_duplicate.length,
    ledger_total_accepted: Object.keys(ledger.accepted).length,
    ledger_total_quarantined: Object.keys(ledger.quarantine).length,
  });

  if (flags.approve) {
    const pendingAfter = emit.buildCommsPending(ledger, ctx.config.rulebook);
    await runApprovalSession(pendingAfter, ledger, { approverName: flags.approverName || null });
    ledgerMod.saveLedger(ledger);
    materialiseOutputsAt(ledger, ctx, log, ROOT);
  }

  printSummary(ledger, changes, log);
}

async function commandApprove(flags, log) {
  // Cheap and deterministic: re-run the pipeline against the ledger's current
  // known state (no new file necessarily), then approve whatever is pending.
  await commandAll({ ...flags, approve: true }, log);
}

function commandReset(log) {
  if (fs.existsSync(ledgerMod.LEDGER_PATH)) {
    fs.unlinkSync(ledgerMod.LEDGER_PATH);
    log.info('ledger.reset', { path: ledgerMod.LEDGER_PATH });
  } else {
    log.info('ledger.reset', { path: ledgerMod.LEDGER_PATH, note: 'no ledger existed' });
  }
}

function commandPiiScan(flags, log) {
  const dataDir = flags.dataDir || ROOT;
  const { collectCorpusNames } = require('./src/context/store');
  const { names, texts } = collectCorpusNames(dataDir);
  const uncovered = scanUncovered(names, texts);
  log.say(`Names auto-discovered: ${names.length}`);
  log.say(`Uncovered name-shaped tokens (masked preview, review and add real hits to config/pii_names.local.json):`);
  for (const u of uncovered.slice(0, 40)) {
    log.say(`  ${u.preview}  (len ${u.length}, seen ${u.occurrences}x)`);
  }
  if (uncovered.length === 0) log.say('  none - every capitalised name-shaped token is already covered.');
}

async function commandSelftest(flags, log) {
  const { runAllTests, formatReport } = require('./src/verify/tests');
  const results = await runAllTests({ rootDir: ROOT, log });
  log.say(formatReport(results));
  process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
}

function printSummary(ledger, changes, log) {
  const acceptedCount = Object.keys(ledger.accepted).length;
  const quarantinedCount = Object.keys(ledger.quarantine).length;
  const sent = Object.values(ledger.accepted).filter((e) => e.sent).length;
  const pending = Object.values(ledger.accepted).filter((e) => !e.sent && emit.needsClientMessage(e.decision)).length;
  const needsHuman = Object.values(ledger.accepted).filter((e) => e.decision.needs_human).length;

  log.say('');
  log.say('='.repeat(60));
  log.say('PIPELINE SUMMARY');
  log.say('='.repeat(60));
  log.say(`Work orders (cumulative):     ${acceptedCount}`);
  log.say(`  new this run:               ${changes.newly_accepted.length}`);
  log.say(`  recovered from quarantine:  ${changes.recovered.length}`);
  log.say(`Needs human review:           ${needsHuman}`);
  log.say(`Messages sent:                ${sent}`);
  log.say(`Messages pending approval:    ${pending}`);
  log.say(`Quarantined (cumulative):     ${quarantinedCount}`);
  log.say(`  new this run:               ${changes.newly_quarantined.length}`);
  if (!changes.newly_accepted.length && !changes.newly_quarantined.length) {
    log.say('No new tickets since last run - outputs unchanged (idempotent).');
  }
  log.say('='.repeat(60));
  log.say(`Outputs: outputs/work_orders.jsonl, outputs/comms_pending.jsonl, outputs/comms_sent.jsonl, outputs/quarantine.jsonl`);
  log.say(`Audit:   audit/audit.jsonl`);
  log.say('');
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  ensureDir(path.join(ROOT, 'logs'));
  const log = new Logger({
    level: flags.quiet ? 'warn' : 'info',
    file: path.join(ROOT, 'logs', `run_${timestampSlug()}.log`),
  });

  try {
    if (command === 'all') await commandAll(flags, log);
    else if (command === 'approve') await commandApprove(flags, log);
    else if (command === 'reset') commandReset(log);
    else if (command === 'pii-scan') commandPiiScan(flags, log);
    else if (command === 'selftest') await commandSelftest(flags, log);
    else if (command === 'dashboard') { require('./src/dashboard/server').startServer(flags.port || 3000); return; }
    else {
      log.say(`Unknown command "${command}". Use: all | approve | reset | pii-scan | selftest | dashboard`);
      process.exitCode = 1;
    }
  } catch (err) {
    log.error('fatal', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
