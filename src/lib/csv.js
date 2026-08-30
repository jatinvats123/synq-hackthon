'use strict';
/**
 * Minimal RFC-4180 delimited-text reader.
 *
 * Written by hand rather than pulled from npm so that `node run.js all` works on a
 * clean machine with no install step. It handles the things the Meridian exports
 * actually do: quoted fields, embedded commas/newlines, CRLF, and (for the
 * surprise ticket file) delimiters other than comma.
 */

/** Split raw delimited text into an array of string arrays. */
function parseRows(text, delimiter = ',') {
  // Strip a UTF-8 BOM if the client's export tool added one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
      sawAny = true;
      continue;
    }
    if (c === '"') { quoted = true; sawAny = true; }
    else if (c === delimiter) { row.push(field); field = ''; sawAny = true; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; sawAny = false; }
    else if (c === '\r') { /* swallow; the \n that follows ends the row */ }
    else { field += c; sawAny = true; }
  }
  if (sawAny || field.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Parse delimited text into objects keyed by header name.
 * Ragged rows are tolerated: missing cells become '', extra cells land in `_extra`.
 * Every record carries `_row` (1-based line number in the file) so anything we
 * later decide about it can be cited back to a physical location.
 */
function parseCSV(text, { source = 'csv', delimiter = ',' } = {}) {
  const rows = parseRows(text, delimiter);
  if (rows.length === 0) return { header: [], records: [] };

  const header = rows[0].map((h) => h.trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    // A trailing newline produces one empty cell; that is not a record.
    if (r.length === 1 && r[0].trim() === '') continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = (r[c] ?? '').trim();
    if (r.length > header.length) obj._extra = r.slice(header.length);
    obj._row = i + 1;
    obj._source = source;
    records.push(obj);
  }
  return { header, records };
}

/**
 * Guess the delimiter of a delimited file from its first line.
 * Used only by the format-tolerant ticket reader; the known static exports are
 * all plain commas.
 */
function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

module.exports = { parseCSV, parseRows, sniffDelimiter };
