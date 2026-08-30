'use strict';
/**
 * The verification dashboard: `node run.js dashboard` serves this at
 * http://localhost:3000 (no build step, no framework - one Node http.Server).
 *
 * Every GET /api/* route reads real files fresh on every request (the ledger,
 * outputs/, audit/, logs/, config/rulebook.json) via src/dashboard/api.js - there
 * is no cache and no mock data path. The one POST route that writes
 * (/api/approve) reuses the exact ledger function the CLI approval flow uses, so
 * there is one approval code path, not two that could drift.
 *
 * POST /api/tests/:id runs the real verification suite (src/verify/tests.js)
 * in-process against the live rootDir and returns the actual result - clicking
 * the button in the browser executes the same code `node run.js selftest` does.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const api = require('./api');
const { runTest, ALL_TESTS } = require('../verify/tests');

const ROOT = path.join(__dirname, '..', '..');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** Build the same API payloads the frontend actually receives, for the PII test's "API responses" surface. */
function collectApiPayloadsForPiiScan() {
  const names = ['overview', 'work-orders', 'pending', 'sent', 'quarantine', 'audit', 'rules', 'health'];
  const getters = [api.getOverview, api.getWorkOrders, api.getPending, api.getSent, api.getQuarantine, api.getAudit, api.getRules, api.getHealth];
  return names.map((name, i) => {
    try { return { name, data: getters[i](ROOT) }; }
    catch { return { name, data: null }; }
  });
}

async function handleApi(req, res, parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean); // ['api', ...]
  const query = parsed.query;

  try {
    if (req.method === 'GET' && segments[1] === 'overview') return sendJson(res, 200, api.getOverview(ROOT));
    if (req.method === 'GET' && segments[1] === 'work-orders' && !segments[2]) return sendJson(res, 200, api.getWorkOrders(ROOT));
    if (req.method === 'GET' && segments[1] === 'work-orders' && segments[2]) {
      const detail = api.getWorkOrderDetail(ROOT, decodeURIComponent(segments[2]));
      if (!detail) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, detail);
    }
    if (req.method === 'GET' && segments[1] === 'pending') return sendJson(res, 200, api.getPending(ROOT));
    if (req.method === 'GET' && segments[1] === 'sent') return sendJson(res, 200, api.getSent(ROOT));
    if (req.method === 'GET' && segments[1] === 'quarantine') return sendJson(res, 200, api.getQuarantine(ROOT));
    if (req.method === 'GET' && segments[1] === 'audit') return sendJson(res, 200, api.getAudit(ROOT, query.ticket));
    if (req.method === 'GET' && segments[1] === 'rules') return sendJson(res, 200, api.getRules(ROOT));
    if (req.method === 'GET' && segments[1] === 'health') return sendJson(res, 200, api.getHealth(ROOT));
    if (req.method === 'GET' && segments[1] === 'tests' && segments[2] === 'list') {
      return sendJson(res, 200, ALL_TESTS.map((t) => t.id));
    }

    if (req.method === 'POST' && segments[1] === 'approve') {
      const body = await readBody(req);
      if (!body.ticket_id) return sendJson(res, 400, { ok: false, error: 'ticket_id required' });
      const result = api.approveTicket(ROOT, body.ticket_id, body.approved_by);
      return sendJson(res, result.status || (result.ok ? 200 : 400), result);
    }

    if (req.method === 'POST' && segments[1] === 'tests' && segments[2]) {
      const testId = segments[2].toUpperCase();
      if (testId === 'ALL') {
        const results = ALL_TESTS.map((t) => runTest(t.id, ROOT, t.id === 'D' ? collectApiPayloadsForPiiScan() : undefined));
        return sendJson(res, 200, { results });
      }
      if (!ALL_TESTS.some((t) => t.id === testId)) return sendJson(res, 404, { error: `unknown test ${testId}` });
      const extra = testId === 'D' ? collectApiPayloadsForPiiScan() : undefined;
      const result = runTest(testId, ROOT, extra);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: 'no such route' });
  } catch (err) {
    sendJson(res, 500, { error: err.message, stack: err.stack });
  }
}

function startServer(port = 3000) {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (parsed.pathname.startsWith('/api/')) return handleApi(req, res, parsed);
    if (req.method === 'GET' && (parsed.pathname === '/' || parsed.pathname === '/index.html')) {
      const html = renderPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, () => {
    console.log(`Meridian Freight verification dashboard: http://localhost:${port}`);
    console.log('Run "node run.js all" in another terminal to process tickets, then use this page to inspect and approve.');
  });
  return server;
}

// ---------------------------------------------------------------------------
// Page (static shell; all data loads via fetch from /api/*)
// ---------------------------------------------------------------------------
function renderPage() {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Meridian Freight - Verification Dashboard</title>
<style>${STYLE}</style>
</head><body>
<div id="app">
  <header>
    <div class="brand">Meridian Freight <span class="brand-sub">Breakdown Pipeline &mdash; Verification Dashboard</span></div>
    <div class="header-right">
      <span id="as-of" class="muted-text"></span>
      <label class="auto-refresh"><input type="checkbox" id="auto-refresh-toggle"> auto-refresh</label>
      <button class="btn btn-ghost" onclick="App.refreshActive()">Refresh</button>
    </div>
  </header>

  <nav class="tabs">
    ${['overview', 'work-orders', 'pending', 'sent', 'quarantine', 'audit', 'rules', 'verify', 'health']
      .map((t) => `<button class="tab-btn" data-tab="${t}" onclick="App.showTab('${t}')">${TAB_LABELS[t]}</button>`).join('')}
  </nav>

  <main id="content"><div class="loading">Loading...</div></main>
</div>
<script>${CLIENT_JS}</script>
</body></html>`;
}

const TAB_LABELS = {
  overview: 'Overview', 'work-orders': 'Work Orders', pending: 'Pending Approval', sent: 'Sent Messages',
  quarantine: 'Quarantine', audit: 'Audit Trail', rules: 'Dispatcher Rules', verify: 'Verification', health: 'Health',
};

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
header { padding: 14px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; position: sticky; top: 0; background: var(--bg); z-index: 5; }
.brand { font-size: 16px; font-weight: 700; }
.brand-sub { font-weight: 400; color: var(--text-dim); font-size: 12px; margin-left: 8px; }
.header-right { display: flex; align-items: center; gap: 14px; }
.auto-refresh { font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; }
nav.tabs { display: flex; gap: 2px; padding: 8px 20px 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab-btn { background: none; border: none; color: var(--text-dim); padding: 9px 14px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
main { padding: 20px 24px 60px; max-width: 1280px; margin: 0 auto; }
.loading { color: var(--text-dim); padding: 40px; text-align: center; }
.btn { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-ghost { background: transparent; }
.btn:disabled { opacity: .5; cursor: default; }
.stats { display: flex; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 22px; flex-wrap: wrap; }
.stat { flex: 1 1 140px; background: var(--panel); padding: 14px 18px; }
.stat-value { font-size: 24px; font-weight: 700; }
.stat-value.warn { color: var(--warn); } .stat-value.bad { color: var(--bad); } .stat-value.ok { color: var(--ok); }
.stat-label { color: var(--text-dim); font-size: 11.5px; margin-top: 2px; text-transform: uppercase; letter-spacing: .03em; }
section { margin-bottom: 26px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin: 0 0 12px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; vertical-align: top; }
th { color: var(--text-dim); font-weight: 500; background: var(--panel-2); position: sticky; top: 0; }
tr:last-child td { border-bottom: none; }
tr.clickable { cursor: pointer; } tr.clickable:hover { background: var(--panel-2); }
code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
.muted-text { color: var(--text-dim); }
.empty { color: var(--text-dim); font-style: italic; padding: 16px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 10.5px; font-weight: 700; letter-spacing: .02em; white-space: nowrap; }
.badge-ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.badge-bad { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
.badge-warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.badge-muted { background: color-mix(in srgb, var(--muted) 25%, transparent); color: var(--text-dim); }
.badge-accent { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
.card-warn { border-left: 3px solid var(--warn); }
.card-title { font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.reason { font-size: 12.5px; margin: 4px 0; color: var(--text-dim); }
.reason strong { color: var(--text); }
.remediation { margin-top: 8px; font-size: 12.5px; color: var(--text-dim); }
.body-text { background: var(--panel-2); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; margin: 8px 0; }
.context-line { color: var(--text-dim); font-size: 12px; margin-bottom: 4px; }
details summary { cursor: pointer; color: var(--accent); font-size: 12px; }
.cites { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
pre { white-space: pre-wrap; font-size: 11.5px; background: var(--panel-2); padding: 10px; border-radius: 6px; }
.controls-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
input[type=text] { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; width: 220px; }
.audit-group { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; padding: 8px 12px; }
.audit-group summary { color: var(--text); font-weight: 500; }
.audit-table { border: none; margin-top: 8px; }
.audit-table td { border-bottom: 1px solid var(--border); font-size: 12px; }
.step-name { color: var(--accent); font-weight: 600; white-space: nowrap; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 50; overflow-y: auto; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; max-width: 900px; width: 100%; padding: 22px; }
.modal-close { float: right; background: none; border: none; color: var(--text-dim); font-size: 18px; cursor: pointer; }
.test-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
.test-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.check-row { display: flex; gap: 8px; font-size: 12.5px; padding: 3px 0; align-items: flex-start; }
.check-icon { width: 16px; flex-shrink: 0; }
.check-icon.pass { color: var(--ok); } .check-icon.fail { color: var(--bad); } .check-icon.info { color: var(--text-dim); }
.evidence { color: var(--text-dim); font-size: 11.5px; margin-left: 24px; }
footer.page-footer { text-align: center; color: var(--text-dim); font-size: 11.5px; padding: 24px; }
`;

const CLIENT_JS = `
const App = {
  active: 'overview',
  autoTimer: null,
  cache: {},

  esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; },

  async fetchJSON(u, opts) {
    const r = await fetch(u, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { body });
    return body;
  },

  showTab(tab) {
    this.active = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    this.render(tab);
  },

  refreshActive() { this.render(this.active); },

  async render(tab) {
    const content = document.getElementById('content');
    content.innerHTML = '<div class="loading">Loading...</div>';
    try {
      const renderer = this.renderers[tab];
      await renderer.call(this, content);
    } catch (err) {
      content.innerHTML = '<div class="empty">Error loading ' + this.esc(tab) + ': ' + this.esc(err.message) + '</div>';
    }
  },

  badge(text, kind) { return '<span class="badge badge-' + kind + '">' + this.esc(text) + '</span>'; },
  verdictBadge(v) {
    const kind = { PASS: 'ok', FAIL: 'bad', NOT_APPLICABLE: 'muted', INSUFFICIENT_DATA: 'warn' }[v] || 'muted';
    return this.badge(v, kind);
  },

  renderers: {
    async overview(el) {
      const o = await App.fetchJSON('/api/overview');
      document.getElementById('as-of').textContent = o.as_of ? ('as-of: ' + o.as_of) : '';
      el.innerHTML = \`
        <div class="stats">
          \${App.stat(o.total_unique_valid_tickets, 'Unique valid tickets')}
          \${App.stat(o.work_orders_created, 'Work orders created')}
          \${App.stat(o.tickets_quarantined, 'Quarantined', o.tickets_quarantined > 0 ? 'warn' : 'ok')}
          \${App.stat(o.pending_client_approvals, 'Pending approvals', o.pending_client_approvals > 0 ? 'warn' : 'ok')}
          \${App.stat(o.messages_sent, 'Messages sent')}
          \${App.stat(o.needs_human_review, 'Needs human review', o.needs_human_review > 0 ? 'warn' : 'ok')}
        </div>
        <section>
          <h2>Last Pipeline Run</h2>
          <div class="card">
            <div>Last run: <strong>\${App.esc(o.last_run_at || 'never')}</strong></div>
            <div class="muted-text" style="margin-top:4px">\${o.last_run_alert_count} alert(s) raised on the last run - see the Health tab for detail.</div>
          </div>
        </section>
        <section>
          <h2>What this means</h2>
          <div class="card muted-text">
            Every number above is read live from <code>outputs/*.jsonl</code> and <code>state/ledger.json</code>.
            Run <code>node run.js all</code> in a terminal, then click Refresh - nothing here is cached or mocked.
          </div>
        </section>\`;
    },

    async 'work-orders'(el) {
      const rows = await App.fetchJSON('/api/work-orders');
      if (!rows.length) { el.innerHTML = '<div class="empty">No work orders yet. Run <code>node run.js all</code>.</div>'; return; }
      el.innerHTML = '<section><h2>Work Orders (' + rows.length + ')</h2><table><thead><tr>' +
        '<th>Work Order</th><th>Ticket</th><th>Broken Vehicle</th><th>Client</th><th>Route</th><th>Status</th><th>Replacement</th>' +
        '</tr></thead><tbody>' + rows.map(App.woRow).join('') + '</tbody></table></section>';
      rows.forEach(w => {
        const tr = document.getElementById('wo-' + w.ticket_id);
        if (tr) tr.addEventListener('click', () => App.openWorkOrder(w.ticket_id));
      });
    },

    async pending(el) {
      const rows = await App.fetchJSON('/api/pending');
      if (!rows.length) { el.innerHTML = '<div class="empty">No messages pending approval.</div>'; return; }
      el.innerHTML = '<section><h2>Pending Approval (' + rows.length + ')</h2>' + rows.map(App.pendingCard).join('') + '</section>';
    },

    async sent(el) {
      const rows = await App.fetchJSON('/api/sent');
      if (!rows.length) { el.innerHTML = '<div class="empty">No messages sent yet. Approve one from the Pending Approval tab.</div>'; return; }
      el.innerHTML = '<section><h2>Sent Messages (' + rows.length + ')</h2><table><thead><tr>' +
        '<th>Ticket</th><th>Recipient</th><th>Approved By</th><th>Sent At</th><th>Body</th>' +
        '</tr></thead><tbody>' + rows.map(r => '<tr><td>' + App.esc(r.ticket_id) + '</td><td>' + App.esc(r.recipient) +
        '</td><td>' + App.esc(r.approved_by) + '</td><td>' + App.esc(r.sent_at) + '</td><td><details><summary>view</summary><pre>' +
        App.esc(r.body) + '</pre></details></td></tr>').join('') + '</tbody></table>' +
        '<div class="muted-text" style="margin-top:8px">Uniqueness check: ' + (new Set(rows.map(r=>r.ticket_id)).size === rows.length ? App.badge('one message per ticket - no duplicates', 'ok') : App.badge('DUPLICATE TICKETS DETECTED', 'bad')) + '</div></section>';
    },

    async quarantine(el) {
      const rows = await App.fetchJSON('/api/quarantine');
      if (!rows.length) { el.innerHTML = '<div class="empty">Nothing quarantined.</div>'; return; }
      el.innerHTML = '<section><h2>Quarantined (' + rows.length + ') - held for review, never dropped</h2>' +
        rows.map(App.quarantineCard).join('') + '</section>';
    },

    async audit(el) {
      const rows = await App.fetchJSON('/api/audit');
      const byTicket = new Map();
      rows.forEach(r => { if (!byTicket.has(r.ticket_id)) byTicket.set(r.ticket_id, []); byTicket.get(r.ticket_id).push(r); });
      const tickets = [...byTicket.keys()];
      el.innerHTML = '<section><h2>Audit Trail (' + tickets.length + ' tickets, ' + rows.length + ' steps)</h2>' +
        '<div class="controls-row"><input type="text" id="audit-filter" placeholder="Filter by ticket id..." oninput="App.filterAudit()"></div>' +
        '<div id="audit-groups">' + tickets.map(t => App.auditGroup(t, byTicket.get(t))).join('') + '</div></section>';
    },

    async rules(el) {
      const rows = await App.fetchJSON('/api/rules');
      el.innerHTML = '<section><h2>Dispatcher Rules (encoded from dispatcher_interview.txt + client emails)</h2>' +
        rows.map(App.ruleCard).join('') + '</section>';
    },

    async verify(el) {
      el.innerHTML = '<section><h2>Verification / Tests</h2>' +
        '<div class="controls-row"><button class="btn btn-primary" onclick="App.runAllTests()">Run all tests</button>' +
        '<span id="test-summary" class="muted-text"></span></div>' +
        '<div id="test-results">' + App.testDescriptions() + '</div></section>';
    },

    async health(el) {
      const h = await App.fetchJSON('/api/health');
      el.innerHTML = \`
        <section><h2>Production Health</h2>
        <div class="stats">
          \${App.stat(h.processed, 'Processed')}
          \${App.stat(h.dispatched, 'Dispatched clean')}
          \${App.stat(h.needs_review, 'Needs review', h.needs_review>0?'warn':'ok')}
          \${App.stat(h.escalated_no_vehicle, 'Escalated (no vehicle)', h.escalated_no_vehicle>0?'bad':'ok')}
          \${App.stat(h.quarantined, 'Quarantined', h.quarantined>0?'warn':'ok')}
          \${App.stat(h.errors_last_run, 'Errors (last run)', h.errors_last_run>0?'bad':'ok')}
        </div>
        <div class="card">
          <div>Last run: <strong>\${App.esc(h.last_run_at || 'never')}</strong> &middot; \${h.alerts_last_run} alert(s)</div>
          <div style="margin-top:8px">Idempotency: \${App.badge(h.idempotency_status, 'accent')}</div>
          <div style="margin-top:8px">PII safety: \${App.badge(h.pii_safety_status, h.pii_violations===0?'ok':'bad')}
            <span class="muted-text">(live scan of outputs/ + audit/, run just now)</span></div>
        </div></section>\`;
    },
  },

  stat(value, label, tone) {
    return '<div class="stat"><div class="stat-value' + (tone ? ' ' + tone : '') + '">' + this.esc(value) + '</div><div class="stat-label">' + this.esc(label) + '</div></div>';
  },

  woRow(w) {
    const statusTone = w.status === 'ESCALATED_NO_VEHICLE' ? 'bad' : (w.needs_human_review ? 'warn' : 'ok');
    let replCell = '<span class="muted-text">none - escalated</span>';
    if (w.replacement) {
      replCell = App.esc(w.replacement.registration) + ' <span class="muted-text">from ' + App.esc(w.replacement.from_hub) + '</span>';
      if (w.replacement.derived_checks && w.replacement.derived_checks.length) {
        const tone = w.replacement.has_borderline_assumption ? 'warn' : 'muted';
        replCell += ' ' + App.badge(w.replacement.derived_checks.map(c => c.rule_id).join(',') + ' assumed', tone);
      }
      if (w.replacement.unknowns && w.replacement.unknowns.length) {
        replCell += ' ' + App.badge(w.replacement.unknowns.length + ' unknown', 'warn');
      }
    }
    return '<tr class="clickable" id="wo-' + App.esc(w.ticket_id) + '">' +
      '<td><code>' + App.esc(w.work_order_id) + '</code></td>' +
      '<td>' + App.esc(w.ticket_id) + '</td>' +
      '<td>' + App.esc(w.vehicle_reg) + '</td>' +
      '<td>' + App.esc(w.client) + '</td>' +
      '<td>' + App.esc(w.origin_hub) + ' &rarr; ' + App.esc(w.destination) + '</td>' +
      '<td>' + App.badge(w.status, statusTone) + '</td>' +
      '<td>' + replCell + '</td></tr>';
  },

  pendingCard(m) {
    return '<div class="card">' +
      '<div class="card-title"><span>' + App.esc(m.ticket_id) + ' &rarr; ' + App.esc(m.recipient) + '</span>' +
      '<button class="btn btn-primary" onclick="App.approve(\\'' + m.ticket_id + '\\', this)">Approve &amp; Send</button></div>' +
      '<div class="context-line">' + App.esc(m.context.client) + ' &middot; ' + App.esc(m.context.route.origin_hub) + ' &rarr; ' +
      App.esc(m.context.route.destination) + ' &middot; replacement: ' + App.esc(m.context.replacement) + '</div>' +
      (m.context.actionable_constraints.length ? '<div class="muted-text" style="font-size:12px;margin-top:4px">Constraints: ' +
        m.context.actionable_constraints.map(c => '[' + c.rule_id + '] ' + App.esc(c.because)).join(' &middot; ') + '</div>' : '') +
      '<pre class="body-text">' + App.esc(m.body) + '</pre>' +
      '<details><summary>Citations (' + m.citations.length + ')</summary><div class="cites">' +
      m.citations.map(c => '<code>' + App.esc(c) + '</code>').join(' ') + '</div></details>' +
      '<div id="approve-status-' + App.esc(m.ticket_id) + '"></div></div>';
  },

  async approve(ticketId, btn) {
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const result = await App.fetchJSON('/api/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ticket_id: ticketId, approved_by: 'dashboard-user' }) });
      const status = document.getElementById('approve-status-' + ticketId);
      if (status) status.innerHTML = '<div class="muted-text" style="margin-top:6px">' +
        (result.already_sent ? 'Already sent earlier (no duplicate created).' : 'Sent.') +
        ' approved_by=' + App.esc(result.approved_by) + ' sent_at=' + App.esc(result.sent_at) + '</div>';
      btn.textContent = 'Sent';
      setTimeout(() => App.render('pending'), 900);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Approve & Send';
      alert('Approve failed: ' + err.message);
    }
  },

  quarantineCard(q) {
    return '<div class="card card-warn">' +
      '<div class="card-title">' + App.esc(q.quarantine_id) + (q.occurrences > 1 ? ' ' + App.badge(q.occurrences + ' occurrences', 'muted') : '') + '</div>' +
      '<div class="reasons">' + q.reasons.map(r => '<div class="reason"><strong>' + App.esc(r.code) + '</strong> - ' + App.esc(r.detail) + '</div>').join('') + '</div>' +
      (q.remediation.length ? '<div class="remediation"><strong>Fix:</strong> ' + q.remediation.map(App.esc.bind(App)).join(' ') + '</div>' : '') +
      '<details><summary>Raw record (as received, before any decision was made)</summary><pre>' + App.esc(JSON.stringify(q.raw_record, null, 2)) + '</pre></details></div>';
  },

  auditGroup(ticketId, rows) {
    return '<details class="audit-group" data-ticket="' + App.esc(ticketId) + '"><summary>' + App.esc(ticketId) +
      ' <span class="muted-text">(' + rows.length + ' steps)</span></summary><table class="audit-table"><tbody>' +
      rows.map(r => {
        const { ticket_id, seq, step, verdict, rule_id, because, reason, ...rest } = r;
        const summary = because || reason || Object.entries(rest).filter(([k,v]) => v !== undefined && v !== null && v !== '').map(([k,v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ');
        return '<tr><td class="step-name">' + App.esc(step) + '</td><td>' + (verdict ? App.verdictBadge(verdict) : '') + ' ' + App.esc(rule_id||'') + '</td><td class="muted-text">' + App.esc(summary) + '</td></tr>';
      }).join('') + '</tbody></table></details>';
  },

  filterAudit() {
    const q = document.getElementById('audit-filter').value.trim().toLowerCase();
    document.querySelectorAll('.audit-group').forEach(g => {
      g.style.display = (!q || g.dataset.ticket.toLowerCase().includes(q)) ? '' : 'none';
    });
  },

  ruleCard(r) {
    return '<div class="card">' +
      '<div class="card-title"><span><code>' + App.esc(r.id) + '</code> ' + App.esc(r.name) + ' ' + (r.hard ? App.badge('HARD','bad') : App.badge('soft','muted')) + '</span>' +
      '<span class="muted-text">' + r.tickets_affected + ' ticket(s) affected</span></div>' +
      '<div style="margin:6px 0">' + App.esc(r.statement) + '</div>' +
      '<div class="muted-text" style="font-size:12px">' + App.esc(r.rationale) + '</div>' +
      '<div class="cites" style="margin-top:8px">' + r.citations.map(c => '<code>' + App.esc(c) + '</code>').join(' ') + '</div>' +
      (r.assumptions.length ? '<div class="muted-text" style="font-size:12px;margin-top:6px">Assumptions: ' + r.assumptions.map(a => a.id + (a.confidence ? ' (' + a.confidence + ' confidence)' : '')).join(', ') + '</div>' : '') +
      '<div class="muted-text" style="font-size:12px;margin-top:6px">Evaluated ' + r.times_evaluated + ' time(s) this run &middot; verdicts: ' +
      Object.entries(r.verdict_breakdown).map(([k,v]) => k+':'+v).join(', ') + '</div></div>';
  },

  testDescriptions() {
    return ALL_TEST_META.map(t => '<div class="test-card" id="test-' + t.id + '"><div class="test-header">' +
      '<strong>' + t.id + '. ' + App.esc(t.name) + '</strong>' +
      '<button class="btn" onclick="App.runOneTest(\\'' + t.id + '\\')">Run</button></div>' +
      '<div id="test-body-' + t.id + '" class="muted-text" style="margin-top:6px">Not run yet this session.</div></div>').join('');
  },

  async runOneTest(id) {
    const bodyEl = document.getElementById('test-body-' + id);
    bodyEl.innerHTML = 'Running...';
    try {
      const r = await App.fetchJSON('/api/tests/' + id, { method: 'POST' });
      bodyEl.innerHTML = App.renderTestResult(r);
    } catch (err) { bodyEl.innerHTML = '<span class="check-icon fail">FAIL</span> ' + App.esc(err.message); }
  },

  async runAllTests() {
    document.getElementById('test-summary').textContent = 'Running all 7 tests...';
    try {
      const { results } = await App.fetchJSON('/api/tests/all', { method: 'POST' });
      results.forEach(r => { const el = document.getElementById('test-body-' + r.id); if (el) el.innerHTML = App.renderTestResult(r); });
      const passed = results.filter(r => r.pass).length;
      document.getElementById('test-summary').innerHTML = App.badge(passed + '/' + results.length + ' PASS', passed===results.length?'ok':'bad');
    } catch (err) { document.getElementById('test-summary').textContent = 'Error: ' + err.message; }
  },

  renderTestResult(r) {
    const head = '<div>' + App.badge(r.pass ? 'PASS' : 'FAIL', r.pass ? 'ok' : 'bad') + ' ' + App.esc(r.summary) +
      (r.duration_ms !== undefined ? ' <span class="muted-text">(' + r.duration_ms + 'ms)</span>' : '') + '</div>';
    const rows = (r.details || []).map(c => {
      const icon = c.informational ? 'i' : (c.pass ? 'OK' : 'XX');
      const cls = c.informational ? 'info' : (c.pass ? 'pass' : 'fail');
      const ev = (!c.pass || c.informational) && c.evidence ? '<div class="evidence">' + App.esc(JSON.stringify(c.evidence)) + '</div>' : '';
      return '<div class="check-row"><span class="check-icon ' + cls + '">' + icon + '</span><span>' + App.esc(c.desc) + '</span></div>' + ev;
    }).join('');
    return head + '<div style="margin-top:8px">' + rows + '</div>';
  },

  async openWorkOrder(ticketId) {
    const d = await App.fetchJSON('/api/work-orders/' + encodeURIComponent(ticketId));
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
    const dec = d.decision;
    const checksHtml = (checks) => checks.map(c => '<div class="check-row"><span>' + App.verdictBadge(c.verdict) + '</span><span><code>' + App.esc(c.rule_id) + '</code> ' + App.esc(c.because) + '</span></div>').join('');
    backdrop.innerHTML = '<div class="modal">' +
      '<button class="modal-close" onclick="this.closest(\\'.modal-backdrop\\').remove()">&times;</button>' +
      '<h2 style="margin-top:0">' + App.esc(ticketId) + ' - full decision trail</h2>' +
      '<div class="card"><strong>Broken vehicle:</strong> ' + App.esc(dec.vehicle_reg) + ' &middot; ' + App.esc(dec.classification.issue_key) +
      ' (' + App.esc(dec.classification.class) + ', recovery: ' + App.esc(dec.classification.recovery) + ')</div>' +
      '<div class="card"><strong>Route:</strong> ' + App.esc(dec.route.origin_hub) + ' &rarr; ' + App.esc(dec.route.destination) +
      ' &middot; ' + dec.route.km_from_origin_hub + ' km from origin &middot; client: ' + App.esc(dec.client) + '</div>' +
      '<div class="card"><strong>Replacement sourcing:</strong> ' + App.esc(dec.replacement.sourcing.basis) + '</div>' +
      (dec.replacement.outcome === 'SELECTED' ?
        '<div class="card"><strong>Selected: ' + App.esc(dec.replacement.selected.registration) + ' from ' + App.esc(dec.replacement.selected.from_hub) + '</strong>' +
        '<div style="margin-top:8px">' + checksHtml(dec.replacement.selected.checks.filter(c => c.verdict !== 'NOT_APPLICABLE')) + '</div>' +
        '<details style="margin-top:8px"><summary>Show NOT_APPLICABLE checks too (' + dec.replacement.selected.checks.filter(c=>c.verdict==='NOT_APPLICABLE').length + ')</summary>' + checksHtml(dec.replacement.selected.checks.filter(c => c.verdict === 'NOT_APPLICABLE')) + '</details></div>'
        : '<div class="card card-warn"><strong>ESCALATED:</strong> ' + App.esc(dec.replacement.escalation.reason) + '</div>') +
      (dec.plan_checks.filter(c=>c.verdict!=='NOT_APPLICABLE').length ? '<div class="card"><strong>Client / delivery rules applied</strong><div style="margin-top:8px">' + checksHtml(dec.plan_checks.filter(c=>c.verdict!=='NOT_APPLICABLE')) + '</div></div>' : '') +
      '<div class="card"><strong>Citations (' + dec.citations.length + ')</strong><div class="cites">' + dec.citations.map(c=>'<code>'+App.esc(c)+'</code>').join(' ') + '</div></div>' +
      '<div class="card"><strong>Audit trail for this ticket (' + d.audit_trail.length + ' steps)</strong><table class="audit-table" style="margin-top:8px"><tbody>' +
      d.audit_trail.map(r => '<tr><td class="step-name">' + App.esc(r.step) + '</td><td>' + (r.verdict?App.verdictBadge(r.verdict):'') + ' ' + App.esc(r.rule_id||'') + '</td></tr>').join('') +
      '</tbody></table></div></div>';
    document.body.appendChild(backdrop);
  },

  toggleAutoRefresh(on) {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (on) this.autoTimer = setInterval(() => this.refreshActive(), 15000);
  },
};

const ALL_TEST_META = ${JSON.stringify([
  { id: 'A', name: 'Duplicate / idempotency test' },
  { id: 'B', name: 'Double-run test (pipeline run twice back-to-back)' },
  { id: 'C', name: 'Quarantine test (broken records)' },
  { id: 'D', name: 'PII leak scan' },
  { id: 'E', name: 'Dispatcher rule test' },
  { id: 'F', name: 'Replacement eligibility test' },
  { id: 'G', name: 'Surprise-file test' },
])};

document.getElementById('auto-refresh-toggle').addEventListener('change', (e) => App.toggleAutoRefresh(e.target.checked));
App.showTab('overview');
`;

module.exports = { startServer };
