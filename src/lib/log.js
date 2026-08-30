'use strict';
/**
 * Structured logger with a PII gate on the way out.
 *
 * Everything printed to stdout or written to logs/ passes through `redact.scrubDeep`
 * first. The scoring rule counts a *visible log* as an outbound surface, so the
 * scrubber is wired into the transport rather than left to each call site to
 * remember.
 */
const fs = require('fs');
const path = require('path');
const { scrubDeep, findViolations } = require('../pii/redact');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor({ level = 'info', file = null, quiet = false } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.file = file;
    this.quiet = quiet;
    this.counts = { debug: 0, info: 0, warn: 0, error: 0 };
    this.alerts = [];
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  log(level, event, detail = {}) {
    this.counts[level] = (this.counts[level] || 0) + 1;
    if ((LEVELS[level] ?? 0) < this.level) return;

    const safe = scrubDeep(detail);
    const line = { level, event, ...safe };

    if (this.file) fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    if (this.quiet) return;

    const tag = { debug: 'debug', info: ' info', warn: ' WARN', error: 'ERROR' }[level];
    const rest = Object.entries(safe)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    process.stdout.write(`[${tag}] ${event}${rest ? ' ' + rest : ''}\n`);
  }

  debug(e, d) { this.log('debug', e, d); }
  info(e, d) { this.log('info', e, d); }
  warn(e, d) { this.log('warn', e, d); }
  error(e, d) { this.log('error', e, d); }

  /**
   * An alert is a warn that also gets collected for the run summary and for
   * `outputs/alerts.jsonl`. Quarantines and format changes raise these: the brief
   * says broken records must be quarantined *with an alert*, never dropped silently.
   */
  alert(code, detail = {}) {
    const safe = scrubDeep(detail);
    this.alerts.push({ code, ...safe });
    this.log('warn', `ALERT ${code}`, safe);
  }

  /** Direct user-facing output (reports, query answers). Still PII-gated. */
  say(text) {
    const s = String(text);
    const violations = findViolations(s);
    if (violations.length) {
      // Refuse to print rather than leak. This should be unreachable; if it fires,
      // it is a bug upstream and we want it loud and safe.
      process.stdout.write(`[BLOCKED] output withheld: would expose ${violations.join(',')}\n`);
      return;
    }
    process.stdout.write(s + '\n');
  }
}

module.exports = { Logger, LEVELS };
