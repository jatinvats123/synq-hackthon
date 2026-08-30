'use strict';
/**
 * Isolated working directories for verification tests.
 *
 * Tests that feed synthetic tickets (duplicates, broken records, a differently
 * shaped file) must never touch the live ledger or outputs/ a judge is looking
 * at. But they don't need a copy of the client bundle either: fleet_master.csv,
 * drivers_roster.csv, maintenance_log.xlsx, meridian_trips.csv, the interview and
 * the email corpus are read-only inputs to buildContext - a test can point
 * `dataDir` straight at the real repo root and only isolate `outDir` (state/,
 * outputs/, audit/, data/) and the ticket file itself. That's what this module
 * sets up: a fresh temp directory with nothing in it, so `runOnce` starts from an
 * empty ledger every time a test calls it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJson } = require('../lib/util');

function createSandbox(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meridian-verify-${label}-`));
  for (const sub of ['state', 'outputs', 'audit', 'data']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function cleanupSandbox(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Write a synthetic ticket file (any shape - array, object, or raw text) into a sandbox. */
function writeTicketFile(dir, filename, content) {
  const filePath = path.join(dir, filename);
  if (typeof content === 'string') fs.writeFileSync(filePath, content, 'utf8');
  else fs.writeFileSync(filePath, JSON.stringify(content, null, 1), 'utf8');
  return filePath;
}

module.exports = { createSandbox, cleanupSandbox, writeTicketFile };
