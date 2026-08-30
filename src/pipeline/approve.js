'use strict';
/**
 * Human approval gate for outbound client messages.
 *
 * outputs/comms_sent.jsonl is written ONLY from here, and only after an explicit
 * yes. There is no auto-approve flag: a batch run (`node run.js all`) always
 * leaves messages in comms_pending.jsonl untouched. That is what makes "run the
 * pipeline twice back to back" safe by construction - nothing gets sent by
 * running the pipeline, so nothing new can appear on the second run.
 */
const readline = require('readline');
const { markSent } = require('./ledger');

/**
 * Read one line at a time via readline's async-iterator protocol rather than
 * repeated `rl.question()` calls.
 *
 * With a piped (non-TTY) stdin, all input arrives and is line-buffered by
 * readline essentially at once. `rl.question()` attaches its listener fresh on
 * each call; if any synchronous work (our `output.write` calls) happens between
 * one answer resolving and the next `question()` being issued, the next
 * already-buffered 'line' event can fire with no listener attached yet and is
 * silently dropped - which looked like the approval loop hanging after exactly
 * one prompt. The async iterator pulls from readline's internal queue instead of
 * racing event listeners, so no line is ever lost regardless of timing.
 */
function lineReader(rl, output) {
  const it = rl[Symbol.asyncIterator]();
  return async function next(promptText) {
    if (promptText) output.write(promptText);
    const { value, done } = await it.next();
    return done ? '' : value;
  };
}

/**
 * Walk the approver through every pending message, one at a time, showing the
 * full context and citations the decision rested on - not just the body text.
 * Returns the list of ticket_ids that were approved this session.
 */
async function runApprovalSession(pending, ledger, { input = process.stdin, output = process.stdout, approverName = null } = {}) {
  if (pending.length === 0) {
    output.write('No messages pending approval.\n');
    return [];
  }

  const rl = readline.createInterface({ input, output });
  const ask = lineReader(rl, output);
  const approved = [];

  output.write(`\n${pending.length} message(s) awaiting approval.\n`);
  const nameAnswer = (await ask('Approving as (name/role, e.g. "ops-sandeep"): ')).trim();
  const approver = approverName || nameAnswer || 'unknown-approver';

  for (const msg of pending) {
    output.write('\n' + '-'.repeat(72) + '\n');
    output.write(`Ticket:      ${msg.ticket_id}\n`);
    output.write(`Recipient:   ${msg.recipient}\n`);
    output.write(`Client:      ${msg.context.client}\n`);
    output.write(`Route:       ${msg.context.route.origin_hub} -> ${msg.context.route.destination}\n`);
    output.write(`Replacement: ${msg.context.replacement}\n`);
    if (msg.context.actionable_constraints.length) {
      output.write('Constraints that shaped this message:\n');
      for (const c of msg.context.actionable_constraints) output.write(`  - [${c.rule_id}] ${c.because}\n`);
    }
    output.write(`Citations:   ${msg.citations.join(', ')}\n`);
    output.write('-'.repeat(72) + '\n');
    output.write(msg.body + '\n');
    output.write('-'.repeat(72) + '\n');

    const answer = (await ask('Send this message? [y/N/s=skip all]: ')).trim().toLowerCase();
    if (answer === 's') { output.write('Skipping all remaining messages.\n'); break; }
    if (answer !== 'y' && answer !== 'yes') { output.write('Not sent.\n'); continue; }

    markSent(ledger, msg.ticket_id, {
      approvedBy: approver,
      sentAt: new Date().toISOString(),
      recipient: msg.recipient,
      body: msg.body,
    });
    approved.push(msg.ticket_id);
    output.write(`Sent. (${msg.message_id})\n`);
  }

  rl.close();
  return approved;
}

module.exports = { runApprovalSession };
