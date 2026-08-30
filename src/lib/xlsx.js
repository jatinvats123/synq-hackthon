'use strict';
/**
 * Minimal .xlsx reader: enough of the OOXML spec to read a flat sheet.
 *
 * Again hand-rolled to keep the deploy story honest (`node run.js all`, no install).
 * It reads the zip central directory, inflates the entries it needs, and pulls
 * cell values out of the sheet XML. Supports both sharedStrings and inline strings;
 * `maintenance_log.xlsx` uses inline strings.
 */
const fs = require('fs');
const zlib = require('zlib');

/** Read a zip archive into a Map of entryName -> Buffer. */
function readZip(filePath) {
  const buf = fs.readFileSync(filePath);

  // Locate the End Of Central Directory record (scan backwards; comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of central directory

  const entries = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Jump to the local header to find where the data actually starts: the local
    // header's extra field length can differ from the central directory's.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] !== undefined ? XML_ENTITIES[e] : m;
  });
}

/** Concatenate every <t> run inside a fragment (shared strings can be split into runs). */
function textRuns(xml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += unescapeXml(m[1]);
  return out;
}

function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read the first worksheet of an .xlsx as an array of header-keyed objects.
 * Each record carries `_row` (the spreadsheet row number) for citation.
 */
function readSheet(filePath, { source = 'xlsx' } = {}) {
  const zip = readZip(filePath);

  const sharedXml = zip.get('xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    const s = sharedXml.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(s))) shared.push(textRuns(m[1]));
  }

  // Take the first sheet in workbook order.
  const sheetName = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)))[0];
  if (!sheetName) throw new Error(`no worksheet found in ${filePath}`);
  const sheet = zip.get(sheetName).toString('utf8');

  const gridRows = [];
  const rowRe = /<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const rowNum = parseInt(rm[1], 10);
    const cells = [];
    const cellRe = /<c\s([^>]*)\/>|<c\s([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] || cm[2];
      const inner = cm[3] || '';
      const refMatch = attrs.match(/r="([A-Z]+\d+)"/);
      if (!refMatch) continue;
      const idx = colToIndex(refMatch[1]);
      const typeMatch = attrs.match(/t="([^"]*)"/);
      const type = typeMatch ? typeMatch[1] : 'n';

      let value = '';
      if (type === 'inlineStr') {
        value = textRuns(inner);
      } else if (type === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? (shared[parseInt(v[1], 10)] ?? '') : '';
      } else if (type === 'str') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? unescapeXml(v[1]) : '';
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? v[1] : '';
      }
      cells[idx] = value;
    }
    gridRows.push({ rowNum, cells });
  }
  if (gridRows.length === 0) return { header: [], records: [] };

  const header = (gridRows[0].cells || []).map((h) => String(h ?? '').trim());
  const records = [];
  for (let i = 1; i < gridRows.length; i++) {
    const { rowNum, cells } = gridRows[i];
    const obj = {};
    let nonEmpty = false;
    for (let c = 0; c < header.length; c++) {
      const v = String(cells[c] ?? '').trim();
      obj[header[c]] = v;
      if (v !== '') nonEmpty = true;
    }
    if (!nonEmpty) continue;
    obj._row = rowNum;
    obj._source = source;
    records.push(obj);
  }
  return { header, records };
}

module.exports = { readSheet, readZip };
