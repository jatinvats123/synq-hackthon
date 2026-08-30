'use strict';
/** Small shared helpers: hashing, deterministic JSON, deterministic file writes. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** Short stable id fragment. Used for work order / message ids. */
function shortHash(input, len = 12) {
  return sha256(input).slice(0, len).toUpperCase();
}

/**
 * JSON.stringify with keys in a stable order at every level.
 * Without this, two runs could emit semantically identical but byte-different
 * JSONL, and "run it twice, diff the outputs" would be meaningless.
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && v.constructor === Object) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Write JSONL atomically: build the whole body, then replace the file.
 * A half-written outputs file after a crash would be worse than none.
 */
function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const body = rows.map((r) => stableStringify(r)).join('\n') + (rows.length ? '\n' : '');
  atomicWrite(filePath, body);
  return rows.length;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  atomicWrite(filePath, JSON.stringify(sortKeys(value), null, 2) + '\n');
}

function atomicWrite(filePath, body) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonlIfExists(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`corrupt JSON at ${filePath}: ${err.message}`);
  }
}

/** sha256 of a file's bytes, for provenance of every input we read. */
function fileDigest(filePath) {
  return sha256(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  sha256, shortHash, stableStringify, sortKeys,
  writeJsonl, writeJson, atomicWrite, ensureDir,
  readJsonlIfExists, readJsonIfExists, fileDigest,
};
