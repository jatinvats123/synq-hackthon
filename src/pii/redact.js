'use strict';
/**
 * PII redaction.
 *
 * The scoring rule is blunt: any raw personal data in any outbound action, answer,
 * or visible log caps the whole submission. So redaction is not a formatting step
 * at the end - it happens at ingest, before a value is ever stored in the context
 * layer, and it is re-asserted as a gate immediately before anything is written.
 *
 * Two mechanisms:
 *   1. `redact(text)` - pattern-based masking of free text (emails, notes, tickets).
 *   2. `pseudonym(value, kind)` - stable, non-reversible token for values we still
 *      need to *join* on (a driver's name appearing in two sources) but must never
 *      display. HMAC with a per-install secret, so the token cannot be brute-forced
 *      back to the name from a leaked output file.
 *
 * There is deliberately no reverse map on disk. If an operator needs the real name
 * they look it up in the source system, which has access control. We do not rebuild
 * a shadow copy of the roster.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_PATH = path.join(__dirname, '..', '..', 'state', 'pii_secret');

/**
 * Per-install secret for pseudonymisation. Generated on first run, never committed
 * (state/ is gitignored). Overridable via env for shared/CI installs.
 */
let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.MERIDIAN_PII_SECRET) {
    cachedSecret = process.env.MERIDIAN_PII_SECRET;
    return cachedSecret;
  }
  if (fs.existsSync(SECRET_PATH)) {
    cachedSecret = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    return cachedSecret;
  }
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  cachedSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, cachedSecret + '\n', { mode: 0o600 });
  return cachedSecret;
}

/**
 * Stable pseudonym for a sensitive value.
 * Same input -> same token within an install (so entity resolution still works),
 * different token across installs, and not invertible without the secret.
 */
function pseudonym(value, kind = 'PERSON') {
  const norm = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm === '') return null;
  const mac = crypto.createHmac('sha256', secret()).update(`${kind}:${norm}`).digest('hex');
  return `${kind}_${mac.slice(0, 10).toUpperCase()}`;
}

/**
 * Detectors, applied most-specific-first so that a driving licence number
 * ("HR16 20128663605") is not partially eaten by the phone rule, and a vehicle
 * registration ("HR16SP9238") is never mistaken for either.
 */
const DETECTORS = [
  {
    type: 'EMAIL',
    // Meridian's own role mailboxes (ops@, dispatch@, hub.*@) are corporate routing
    // addresses, not personal data - but named client contacts are. We mask them all
    // and let the comms layer inject the approved recipient address explicitly.
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'AADHAAR',
    // 12 digits as 4-4-4, optionally space or hyphen separated.
    re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g,
  },
  {
    type: 'DL_NUMBER',
    // Indian DL: 2 letters + 2 digits (RTO code), separator, then 11 digits.
    re: /\b[A-Z]{2}[ -]?\d{2}[ -]\d{11}\b/gi,
  },
  {
    type: 'PHONE',
    // +91 prefixed, in any of the spacings the corpus uses.
    re: /(?:\+?91[ -]?)\d{5}[ -]?\d{5}\b|(?:\+?91[ -]?)\d{10}\b/g,
  },
  {
    type: 'PHONE',
    // Bare 10-digit Indian mobile (starts 6-9). Anchored on non-digit boundaries so
    // it cannot bite into a trip id ("trip-153712955898890756") or an odometer.
    re: /(?<![\d.])[6-9]\d{9}(?![\d.])/g,
  },
];

/**
 * Names are not pattern-matchable, so they come from a registry the ingest layer
 * populates (driver roster names, plus the individuals who appear by name in the
 * interview transcript and email corpus).
 */
const nameRegistry = new Map(); // lowercased name -> {type}

function registerNames(names, type = 'PERSON_NAME') {
  for (const n of names) {
    const clean = String(n ?? '').trim();
    if (clean.length < 3) continue; // too short to match safely
    nameRegistry.set(clean.toLowerCase(), { type, original: clean });
  }
}

function clearNameRegistry() {
  nameRegistry.clear();
}

/** Build one alternation regex over registered names, longest first. */
let nameRe = null;
let nameReSize = -1;
function namePattern() {
  if (nameRe && nameReSize === nameRegistry.size) return nameRe;
  const names = [...nameRegistry.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) { nameRe = null; nameReSize = 0; return null; }
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  nameRe = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
  nameReSize = nameRegistry.size;
  return nameRe;
}

/**
 * Mask personal data in free text.
 * Returns the masked string plus the set of detector types that fired, so the
 * caller can record *that* redaction happened (never *what* was redacted).
 */
function redact(text) {
  if (text == null) return { text: text, hits: [] };
  let out = String(text);
  const hits = new Set();

  for (const d of DETECTORS) {
    out = out.replace(d.re, () => { hits.add(d.type); return `[REDACTED:${d.type}]`; });
  }

  const nre = namePattern();
  if (nre) {
    out = out.replace(nre, (m) => {
      const entry = nameRegistry.get(m.toLowerCase());
      hits.add(entry ? entry.type : 'PERSON_NAME');
      return `[REDACTED:PERSON]`;
    });
  }

  return { text: out, hits: [...hits].sort() };
}

/** Convenience: masked string only. */
function scrub(text) {
  return redact(text).text;
}

/**
 * Final gate. Run over anything about to leave the system (message bodies, log
 * lines, query answers). Returns the list of violations; empty means clean.
 *
 * This re-runs the detectors on already-redacted text. It is intentionally
 * redundant with `redact` - the point is that a bug in an enrichment step that
 * reintroduces a raw value gets caught here rather than in the client's inbox.
 */
/**
 * Final gate. `allow` is a short, explicit list of known business routing
 * addresses (client role mailboxes from config/rulebook.json - see ASM-008) that
 * are permitted to appear verbatim. This is not a blanket exemption: it only
 * strips the exact strings supplied by the caller, so a personal address that
 * happens to share a domain still trips the detector. The allowlist has to be
 * passed in by the caller (never inferred from the text itself), so there is no
 * way for a rogue value to get itself allowed.
 */
function findViolations(text, { allow = [] } = {}) {
  if (text == null) return [];
  let s = String(text);
  for (const a of allow) if (a) s = s.split(a).join('');
  const found = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    if (d.re.test(s)) found.push(d.type);
    d.re.lastIndex = 0;
  }
  const nre = namePattern();
  if (nre) {
    nre.lastIndex = 0;
    if (nre.test(s)) found.push('PERSON_NAME');
    nre.lastIndex = 0;
  }
  return [...new Set(found)];
}

/** Deep-scrub an object graph. Used for log payloads and audit details. */
function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

module.exports = {
  redact, scrub, scrubDeep, findViolations,
  pseudonym, registerNames, clearNameRegistry,
  DETECTOR_TYPES: [...new Set(DETECTORS.map((d) => d.type))].concat('PERSON_NAME'),
};
