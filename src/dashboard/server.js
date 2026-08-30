'use strict';
/**
 * A minimal local dashboard: `node run.js dashboard` starts a plain http.Server
 * (no framework, no build step) that reads outputs/, audit/, and the ledger fresh
 * on every request and renders one static HTML page. There is nothing to build or
 * deploy - refreshing the browser after `node run.js all` shows the new state.
 *
 * This process only ever reads the pipeline's files. It never writes an output or
 * approves anything, so it cannot become a second, uncoordinated writer racing the
 * CLI pipeline.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { readJsonlIfExists, readJsonIfExists } = require('../lib/util');
const ledgerMod = require('../pipeline/ledger');

const ROOT = path.join(__dirname, '..', '..');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readState() {
  const workOrders = readJsonlIfExists(path.join(ROOT, 'outputs', 'work_orders.jsonl'));
  const commsPending = readJsonlIfExists(path.join(ROOT, 'outputs', 'comms_pending.jsonl'));
  const commsSent = readJsonlIfExists(path.join(ROOT, 'outputs', 'comms_sent.jsonl'));
  const quarantine = readJsonlIfExists(path.join(ROOT, 'outputs', 'quarantine.jsonl'));
  const audit = readJsonlIfExists(path.join(ROOT, 'audit', 'audit.jsonl'));
  const ledger = ledgerMod.loadLedger();
  const context = readJsonIfExists(path.join(ROOT, 'data', 'context.json'), null);

  // Most recent run log, for a "last run" timestamp and a tail of alerts.
  const logsDir = path.join(ROOT, 'logs');
  let alerts = [];
  let lastRunAt = null;
  if (fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir).filter((f) => f.startsWith('run_')).sort();
    if (files.length) {
      const latest = files[files.length - 1];
      lastRunAt = fs.statSync(path.join(logsDir, latest)).mtime.toISOString();
      const rows = readJsonlIfExists(path.join(logsDir, latest));
      alerts = rows.filter((r) => r.event && r.event.startsWith('ALERT'));
    }
  }

  return { workOrders, commsPending, commsSent, quarantine, audit, ledger, context, alerts, lastRunAt };
}

function stat(n, label) {
  return `<div class="stat"><div class="stat-value">${esc(n)}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function badge(text, kind) {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

function verdictBadge(v) {
  const kind = { PASS: 'ok', FAIL: 'bad', NOT_APPLICABLE: 'muted', INSUFFICIENT_DATA: 'warn' }[v] || 'muted';
  return badge(v, kind);
}

function renderWorkOrders(rows) {
  if (!rows.length) return '<p class="empty">No work orders yet. Run <code>node run.js all</code>.</p>';
  return `<table><thead><tr>
      <th>Work Order</th><th>Ticket</th><th>Vehicle</th><th>Client</th><th>Route</th><th>Status</th><th>Replacement</th>
    </tr></thead><tbody>${rows.map((w) => `
      <tr>
        <td><code>${esc(w.work_order_id)}</code></td>
        <td>${esc(w.ticket_id)}</td>
        <td>${esc(w.vehicle_reg)}</td>
        <td>${esc(w.client)}</td>
        <td>${esc(w.origin_hub)} &rarr; ${esc(w.destination)}</td>
        <td>${badge(w.status, w.status === 'ESCALATED_NO_VEHICLE' ? 'bad' : (w.needs_human_review ? 'warn' : 'ok'))}</td>
        <td>${w.replacement ? `${esc(w.replacement.registration)} <span class="muted-text">from ${esc(w.replacement.from_hub)}</span>${w.replacement.rests_on_assumption ? ' ' + badge('assumption', 'warn') : ''}` : '<span class="muted-text">none - escalated</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
}

function renderQuarantine(rows) {
  if (!rows.length) return '<p class="empty">Nothing quarantined.</p>';
  return rows.map((q) => `
    <div class="card card-warn">
      <div class="card-title">${esc(q.quarantine_id)} ${q.occurrences > 1 ? badge(`${q.occurrences} occurrences`, 'muted') : ''}</div>
      <div class="reasons">${q.reasons.map((r) => `<div class="reason"><strong>${esc(r.code)}</strong> - ${esc(r.detail)}</div>`).join('')}</div>
      ${q.remediation.length ? `<div class="remediation"><strong>Fix:</strong> ${q.remediation.map(esc).join(' ')}</div>` : ''}
      <details><summary>Raw record</summary><pre>${esc(JSON.stringify(q.raw_record, null, 2))}</pre></details>
    </div>`).join('');
}

function renderPending(rows) {
  if (!rows.length) return '<p class="empty">No messages pending approval.</p>';
  return rows.map((m) => `
    <div class="card">
      <div class="card-title">${esc(m.ticket_id)} <span class="muted-text">&rarr; ${esc(m.recipient)}</span></div>
      <div class="context-line">${esc(m.context.client)} &middot; ${esc(m.context.route.origin_hub)} &rarr; ${esc(m.context.route.destination)} &middot; replacement: ${esc(m.context.replacement)}</div>
      <pre class="body">${esc(m.body)}</pre>
      <details><summary>Citations (${m.citations.length})</summary><div class="cites">${m.citations.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div></details>
    </div>`).join('');
}

function renderSent(rows) {
  if (!rows.length) return '<p class="empty">No messages sent yet.</p>';
  return `<table><thead><tr><th>Ticket</th><th>Recipient</th><th>Approved By</th><th>Sent At</th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td>${esc(m.ticket_id)}</td><td>${esc(m.recipient)}</td><td>${esc(m.approved_by)}</td><td>${esc(m.sent_at)}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderAudit(rows) {
  if (!rows.length) return '<p class="empty">No audit trail yet.</p>';
  // Group by ticket, most recently first-seen ticket first isn't meaningful here;
  // show newest-looking (highest ticket id lexically reversed) isn't useful either -
  // just show a flat, filterable table, most rows first for recency-ish feel.
  const byTicket = new Map();
  for (const r of rows) {
    if (!byTicket.has(r.ticket_id)) byTicket.set(r.ticket_id, []);
    byTicket.get(r.ticket_id).push(r);
  }
  const tickets = [...byTicket.keys()];
  return `<div class="audit-controls">
      <input id="audit-filter" type="text" placeholder="Filter by ticket id..." oninput="filterAudit()">
      <span class="muted-text">${tickets.length} tickets, ${rows.length} steps</span>
    </div>
    <div id="audit-groups">
    ${tickets.map((t) => `
      <details class="audit-group" data-ticket="${esc(t)}">
        <summary>${esc(t)} <span class="muted-text">(${byTicket.get(t).length} steps)</span></summary>
        <table class="audit-table"><tbody>
          ${byTicket.get(t).map((r) => `
            <tr>
              <td class="step-name">${esc(r.step)}</td>
              <td>${r.verdict ? verdictBadge(r.verdict) : ''} ${esc(r.rule_id || '')}</td>
              <td class="because">${esc(r.because || r.reason || summarise(r))}</td>
            </tr>`).join('')}
        </tbody></table>
      </details>`).join('')}
    </div>
    <script>
      function filterAudit() {
        const q = document.getElementById('audit-filter').value.trim().toLowerCase();
        document.querySelectorAll('.audit-group').forEach(function(g) {
          const t = g.getAttribute('data-ticket').toLowerCase();
          g.style.display = (!q || t.includes(q)) ? '' : 'none';
        });
      }
    </script>`;
}

function summarise(row) {
  const { ticket_id, seq, step, ...rest } = row;
  const parts = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return parts.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

function renderConflicts(context) {
  if (!context || !context.conflicts || !context.conflicts.length) return '<p class="empty">No entity conflicts recorded.</p>';
  return `<table><thead><tr><th>Entity</th><th>Field</th><th>Values</th><th>Resolved To</th><th>Rule</th></tr></thead><tbody>
    ${context.conflicts.map((c) => `<tr>
      <td>${esc(c.registration || c.entity_key)}</td>
      <td>${esc(c.field)}</td>
      <td>${esc((c.values || []).map((v) => (typeof v === 'object' ? v.value : v)).join(', '))}</td>
      <td>${esc(c.resolved_to)}</td>
      <td><code>${esc(c.rule)}</code></td>
    </tr>`).join('')}
  </tbody></table>`;
}

const STYLE = `
:root {
  --bg: #0b0d12; --panel: #12151c; --panel-2: #171b24; --border: #232838;
  --text: #e6e9f0; --text-dim: #8b93a7; --accent: #5b8cff;
  --ok: #2fbf71; --bad: #ef5a5a; --warn: #e2a53a; --muted: #6b7385;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f5f6f9; --panel: #ffffff; --panel-2: #f0f1f5; --border: #e1e4ea;
    --text: #14161c; --text-dim: #5b6172; --accent: #3b5fe0;
    --ok: #1f8f56; --bad: #cf3a3a; --warn: #b4791f; --muted: #8790a3; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; }
header { padding: 20px 28px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
header h1 { font-size: 18px; margin: 0; }
header .sub { color: var(--text-dim); font-size: 12px; }
.stats { display: flex; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 20px 28px; flex-wrap: wrap; }
.stat { flex: 1 1 120px; background: var(--panel); padding: 14px 18px; }
.stat-value { font-size: 22px; font-weight: 600; }
.stat-label { color: var(--text-dim); font-size: 12px; margin-top: 2px; }
main { padding: 0 28px 40px; max-width: 1200px; }
section { margin-bottom: 28px; }
section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 14px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
th { color: var(--text-dim); font-weight: 500; background: var(--panel-2); }
tr:last-child td { border-bottom: none; }
code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.muted-text { color: var(--text-dim); }
.empty { color: var(--text-dim); font-style: italic; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
.badge-ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.badge-bad { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
.badge-warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.badge-muted { background: color-mix(in srgb, var(--muted) 25%, transparent); color: var(--text-dim); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.card-warn { border-left: 3px solid var(--warn); }
.card-title { font-weight: 600; margin-bottom: 6px; }
.reason { font-size: 13px; margin: 4px 0; color: var(--text-dim); }
.reason strong { color: var(--text); }
.remediation { margin-top: 8px; font-size: 13px; color: var(--text-dim); }
.body { background: var(--panel-2); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12.5px; margin: 8px 0; }
.context-line { color: var(--text-dim); font-size: 12.5px; margin-bottom: 4px; }
details summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
.cites { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
pre { white-space: pre-wrap; font-size: 12px; background: var(--panel-2); padding: 10px; border-radius: 6px; }
.audit-controls { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
#audit-filter { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; width: 240px; }
.audit-group { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; padding: 8px 12px; }
.audit-group summary { color: var(--text); font-weight: 500; }
.audit-table { border: none; margin-top: 8px; }
.audit-table td { border-bottom: 1px solid var(--border); font-size: 12.5px; }
.step-name { color: var(--accent); font-weight: 600; white-space: nowrap; }
.because { color: var(--text-dim); }
nav.tabs { display: flex; gap: 4px; margin: 0 28px 8px; }
nav.tabs a { padding: 6px 12px; border-radius: 6px; color: var(--text-dim); text-decoration: none; font-size: 13px; }
nav.tabs a.active { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
footer { padding: 20px 28px; color: var(--text-dim); font-size: 12px; border-top: 1px solid var(--border); }
`;

function page(state) {
  const acceptedCount = Object.keys(state.ledger.accepted).length;
  const quarantinedCount = Object.keys(state.ledger.quarantine).length;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<title>Meridian Freight - Pipeline Dashboard</title>
<style>${STYLE}</style>
</head><body>
<header>
  <div><h1>Meridian Freight &mdash; Breakdown Pipeline</h1>
  <div class="sub">Auto-refreshes every 15s. Reads outputs/, audit/, and the ledger directly - nothing cached.</div></div>
  <div class="sub">as-of: ${esc(state.context ? state.context.as_of : 'n/a')} &middot; last run: ${esc(state.lastRunAt || 'never')}</div>
</header>

<div class="stats">
  ${stat(acceptedCount, 'Work orders (cumulative)')}
  ${stat(state.workOrders.filter((w) => w.needs_human_review).length, 'Needs human review')}
  ${stat(state.commsPending.length, 'Pending approval')}
  ${stat(state.commsSent.length, 'Messages sent')}
  ${stat(quarantinedCount, 'Quarantined')}
  ${stat(state.alerts.length, 'Alerts (last run)')}
</div>

<main>
  <section>
    <h2>Work Orders</h2>
    ${renderWorkOrders(state.workOrders)}
  </section>

  <section>
    <h2>Pending Approval (${state.commsPending.length})</h2>
    <p class="muted-text" style="margin-top:-8px">Approve from the terminal: <code>node run.js all --approve</code></p>
    ${renderPending(state.commsPending)}
  </section>

  <section>
    <h2>Sent Messages</h2>
    ${renderSent(state.commsSent)}
  </section>

  <section>
    <h2>Quarantined (${quarantinedCount})</h2>
    ${renderQuarantine(state.quarantine)}
  </section>

  <section>
    <h2>Entity Resolution Conflicts</h2>
    ${renderConflicts(state.context)}
  </section>

  <section>
    <h2>Audit Trail</h2>
    ${renderAudit(state.audit)}
  </section>
</main>

<footer>Meridian Freight FDE challenge &middot; served from local files only, no external calls &middot; refresh the page or wait 15s after running <code>node run.js all</code></footer>
</body></html>`;
}

function startServer(port = 3000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    try {
      const html = page(readState());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard error: ${err.message}\n${err.stack}`);
    }
  });
  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
    console.log('Run "node run.js all" in another terminal, then refresh the page.');
  });
  return server;
}

module.exports = { startServer, readState, page };
