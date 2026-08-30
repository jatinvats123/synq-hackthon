# Meridian Freight — Breakdown Automation

Forward-deployment challenge submission. Node.js, zero external dependencies —
nothing to `npm install`. Runs on any machine with Node 18+.

## Run it

Drop the client bundle (`fleet_master.csv`, `drivers_roster.csv`,
`meridian_trips.csv`, `maintenance_log.xlsx`, `dispatcher_interview.txt`,
`emails/`, `tickets.json`) into the repo root — these are gitignored on purpose
(see `.gitignore`: the roster carries names, phone numbers, licence numbers and
Aadhaar numbers for 60 people, and git history can't be redacted after the fact).

```bash
node run.js all
```

That's the one command. It ingests every source, resolves entities, validates
and de-duplicates the ticket queue, applies the dispatcher's rulebook, selects a
replacement vehicle, and writes:

- `outputs/work_orders.jsonl` — one row per unique valid ticket
- `outputs/comms_pending.jsonl` — drafted client messages awaiting approval
- `outputs/comms_sent.jsonl` — written only after a human approves (see below)
- `outputs/quarantine.jsonl` — broken records, held with reasons, never dropped
- `audit/audit.jsonl` — one row per pipeline step per ticket

Run it again — outputs are byte-identical. State lives in `state/ledger.json`,
keyed by `ticket_id`, so a duplicate or a re-run never creates a second work
order or a second sent message.

## Approve and send client messages

```bash
node run.js all --approve
```

Walks through every pending message in the terminal, showing the full context
and citations behind it. Nothing is ever auto-approved. Re-running `node run.js
all` afterward does not re-prompt or re-send anything already approved.

## Watch it live

```bash
node run.js dashboard
```

Opens a server at **http://localhost:3000** (or `--port <n>`). Reads
`outputs/`, `audit/`, and the ledger fresh on every request — no mock data, no
cache. Sections: Overview, Work Orders (click a row for the full decision
trail), Pending Approval (with an Approve button), Sent Messages, Quarantine,
Audit Trail (filterable by ticket id), Dispatcher Rules, Verification, and
Health. The dashboard's Approve button and `--approve` use the exact same
ledger code path — one way to send a message, not two.

## Other commands

```bash
node run.js reset              # wipe the ledger, start over
node run.js pii-scan           # report name-shaped tokens the redactor may be missing
node run.js selftest           # run the full verification suite, print PASS/FAIL, exit 1 on any failure
node run.js all --tickets <path> [--as-of YYYY-MM-DD] [--data-dir <path>]
```

## Verification suite

`node run.js selftest` (or the Verification tab in the dashboard) runs seven
tests against real pipeline code and real or realistically-shaped data — nothing
here is decorative:

| | Test | What it proves |
|---|---|---|
| A | Duplicate / idempotency | A ticket fed 3x collapses to exactly one work order, one draft, one audit row; stable across a second run |
| B | Double-run | The live system run twice back-to-back produces byte-identical `outputs/` + `audit/` |
| C | Quarantine | A batch of broken/garbage records is quarantined with correct reasons, no crash, nothing dropped |
| D | PII leak scan | Every output file, log file, and dashboard API payload is scanned for phone/Aadhaar/DL/email/name patterns |
| E | Dispatcher rules | Every one of the 13 rules is confirmed live in the audit trail, plus targeted assertions against real tickets (Shakti 36h, Vertex gate hours, Orion year/cold-chain, night-driver pairing, etc.) |
| F | Replacement eligibility | Every selected replacement is independently re-checked: no hard rule fails, every fired check cites a real source record, unresolved unknowns are flagged for human review |
| G | Surprise-file | A differently-shaped ticket file (wrapped object, camelCase fields, DD/MM/YYYY dates, a duplicate id, a broken record) is processed without crashing |

Tests A, C, and G run in an isolated temp directory (`src/verify/sandbox.js`) —
they never touch the live ledger a judge is inspecting.

## Architecture

```
src/lib/        hand-rolled CSV/XLSX readers, structured logger, deterministic JSON writer
src/pii/        redaction (pattern-based + data-derived name registry), never hard-coded names
src/ingest/     one adapter per source file; format-tolerant ticket reader for the surprise file
src/resolve/    entity resolution (vehicles across 3 registration formats, email de-duplication)
src/context/    builds the queryable context layer from every source, applies config/precedence.json
src/rules/      the dispatcher's 13 rules as an engine (PASS/FAIL/NOT_APPLICABLE/INSUFFICIENT_DATA)
src/pipeline/   validate → decide → replacement → ledger → emit (outputs + audit), orchestrator, approval
src/verify/     the verification suite + its sandbox
src/dashboard/  read-only API layer + the single-page verification dashboard
config/         rulebook.json, assumptions.json, precedence.json, hubs.json — data, not code
run.js          the one entry point
```

## What's disclosed, not hidden

`config/assumptions.json` lists every place the data doesn't contain what a rule
needs — most importantly, **no source anywhere contains a service due date**, so
the "overdue service" rule (R-011) proxies it from the last workshop visit plus
an assumed interval. That assumption is precisely scoped: it's flagged per
check, not as a blanket "this pick is arbitrary" badge, and a dedicated
verification test (F) confirms every *other* hard rule a selection depends on
is grounded in a real citation. Two selections in the current queue are
genuinely borderline on that one assumption; both are flagged explicitly in the
Work Orders view.
