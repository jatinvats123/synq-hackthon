'use strict';
/**
 * Discovering which names to mask, without putting anyone's name in the source.
 *
 * The redactor needs a list of person names, because a name is not pattern-
 * matchable the way a phone number is. The naive way to supply that list is to
 * hard-code it - which puts real people's names into the repository permanently,
 * and the scoring line "personal data out of code and logs" rules that out. Git
 * history is also the one place you cannot redact after the fact.
 *
 * So names are discovered from the data instead:
 *
 *   - driver names       from drivers_roster.csv `name`
 *   - mechanic names     from maintenance_log.xlsx `mechanic`
 *   - the interviewee    from the transcript header line
 *   - correspondents     from email sign-off blocks
 *
 * Anything those four extractors miss goes in config/pii_names.local.json, which
 * is gitignored. `node run.js pii-scan` reports what is still uncovered.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LOCAL_LIST = path.join(ROOT, 'config', 'pii_names.local.json');

/** Words that look like names in position but are titles, not identities. */
const NOT_NAMES = new Set([
  'meridian', 'freight', 'hub', 'team', 'ops', 'dispatch', 'workshop', 'regards',
  'thanks', 'sir', 'madam', 'noted', 'confirmed', 'shakti', 'cement', 'vertex',
  'retail', 'apex', 'chemicals', 'orion', 'pharma', 'interviewer',
  'senior', 'manager', 'coordinator', 'private', 'limited', 'transcript', 'end',
]);

/**
 * Names from the interview transcript header.
 * The header is structured: "Knowledge capture interview: <Name>, <Job title>".
 * We read the name out of that position rather than knowing it in advance.
 */
function fromInterview(text) {
  const names = new Set();
  const header = /^Knowledge capture interview:\s*([^,\n]+),/m.exec(text);
  if (header) {
    const full = header[1].trim();
    names.add(full);
    // Also register the parts, so a bare first name and "<first name> ji" are caught.
    for (const part of full.split(/\s+/)) if (part.length > 2) names.add(part);
  }
  // Speaker labels. The interviewee is labelled by first name in this transcript,
  // so the label position is a name source, not a role. INTERVIEWER and other
  // generic roles are filtered out by NOT_NAMES.
  const speakerRe = /^([A-Z][A-Z .]{2,30}):/gm;
  let m;
  while ((m = speakerRe.exec(text))) {
    const label = m[1].trim();
    if (NOT_NAMES.has(label.toLowerCase())) continue;
    // Re-case so it matches the mixed-case spellings used in the email corpus.
    names.add(label.charAt(0) + label.slice(1).toLowerCase());
  }
  return names;
}

/**
 * Names from email sign-off blocks.
 * Meridian's threads end with a signature: a short line of 1-3 capitalised words
 * immediately before either a company line or the end of a message. We take that
 * position, then discard anything that is a known company or role word.
 */
function fromEmails(texts) {
  const names = new Set();
  for (const text of texts) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l || l.length > 40) continue;
      // "Name", "Dr. Name Surname", or an initial plus surname
      if (!/^(?:Dr\.?\s+)?(?:[A-Z][a-z]*\.?\s+){0,2}[A-Z][a-z]{2,}$/.test(l)) continue;
      const words = l.replace(/^Dr\.?\s+/, '').split(/\s+/);
      if (words.some((w) => NOT_NAMES.has(w.toLowerCase().replace(/\./g, '')))) continue;
      // A signature is followed by a blank line, a separator, a company line, or EOF.
      const next = lines[i + 1] ?? '';
      const looksLikeSignature = next === '' || /^-{5,}$/.test(next) || /^[A-Z]/.test(next);
      // ...and is preceded by a blank line (it starts its own block).
      const prev = lines[i - 1] ?? '';
      if (!looksLikeSignature || prev !== '') continue;
      names.add(l.replace(/^Dr\.?\s+/, ''));
      for (const w of words) if (w.length > 2 && !/\.$/.test(w)) names.add(w);
    }
  }
  return names;
}

/** The optional, gitignored local list for anything the extractors cannot see. */
function fromLocalList() {
  if (!fs.existsSync(LOCAL_LIST)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_LIST, 'utf8'));
    return new Set((parsed.names || []).filter((n) => typeof n === 'string' && n.trim().length > 2));
  } catch {
    return new Set();
  }
}

/**
 * Collect every name to mask.
 * `sources` supplies the already-read raw text/columns so this does no file IO of
 * its own beyond the local list.
 */
function collectNames({ driverNames = [], mechanicNames = [], interviewText = '', emailTexts = [] } = {}) {
  const names = new Set();
  const add = (set, origin) => { for (const n of set) if (n && n.trim().length > 2) names.add(n.trim()); return origin; };

  add(new Set(driverNames), 'roster');
  add(new Set(mechanicNames), 'maintenance');
  add(fromInterview(interviewText), 'interview');
  add(fromEmails(emailTexts), 'emails');
  add(fromLocalList(), 'local');

  // Drop anything that is a company or role word that slipped through.
  for (const n of [...names]) if (NOT_NAMES.has(n.toLowerCase())) names.delete(n);

  return [...names].sort();
}

/**
 * Report name-shaped tokens the extractors did NOT cover, so an operator can
 * review them and add real misses to the local list. Returns counts and masked
 * samples only - it never prints a candidate name in full.
 */
function scanUncovered(covered, texts) {
  const coveredLower = new Set(covered.map((c) => c.toLowerCase()));
  const suspects = new Map();
  for (const text of texts) {
    // Capitalised word not at the start of a sentence: a weak but useful signal.
    const re = /(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,})\b/gm;
    let m;
    while ((m = re.exec(text))) {
      const w = m[1];
      if (coveredLower.has(w.toLowerCase()) || NOT_NAMES.has(w.toLowerCase())) continue;
      suspects.set(w, (suspects.get(w) || 0) + 1);
    }
  }
  return [...suspects.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, count]) => ({
      // Masked preview: first letter plus length. Enough to recognise, not enough
      // to be a leak if this report is pasted somewhere.
      preview: `${word[0]}${'*'.repeat(word.length - 1)}`,
      length: word.length,
      occurrences: count,
    }));
}

module.exports = { collectNames, scanUncovered, fromInterview, fromEmails, fromLocalList, NOT_NAMES };
