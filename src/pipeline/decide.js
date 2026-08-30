'use strict';
/**
 * Per-ticket decision: enrich, apply the rulebook, pick a replacement, and produce
 * a decision record that a human can reconstruct end to end without reading code.
 */
const { selectReplacement } = require('./replacement');
const { planSla, planVertexGate, planOrionColdChain, checkDriver, monthOf, hourOf, evaluateVehicle } = require('../rules/engine');
const { vehicleStateAsOf } = require('../resolve/vehicles');

/** Map the free-text issue onto a recovery posture. */
const ISSUE_CLASSES = {
  'brake failure warning': { class: 'SAFETY_CRITICAL', recovery: 'TOW_TO_WORKSHOP', roadside_viable: false },
  'engine overheating': { class: 'IMMOBILISING', recovery: 'TOW_TO_WORKSHOP', roadside_viable: false },
  'turbo failure': { class: 'IMMOBILISING', recovery: 'TOW_TO_WORKSHOP', roadside_viable: false },
  'gearbox jam': { class: 'IMMOBILISING', recovery: 'TOW_TO_WORKSHOP', roadside_viable: false },
  'clutch slipping': { class: 'DEGRADED', recovery: 'ROADSIDE_THEN_TRANSFER', roadside_viable: true },
  'fuel line leak': { class: 'SAFETY_CRITICAL', recovery: 'ROADSIDE_THEN_TRANSFER', roadside_viable: true },
  'radiator leak': { class: 'DEGRADED', recovery: 'ROADSIDE_THEN_TRANSFER', roadside_viable: true },
  'electrical failure': { class: 'DEGRADED', recovery: 'ROADSIDE_THEN_TRANSFER', roadside_viable: true },
  'suspension damage': { class: 'DEGRADED', recovery: 'TOW_TO_WORKSHOP', roadside_viable: false },
  'tyre burst': { class: 'DEGRADED', recovery: 'ROADSIDE_THEN_TRANSFER', roadside_viable: true },
};

function classifyIssue(issue) {
  const key = String(issue || '').trim().toLowerCase();
  if (ISSUE_CLASSES[key]) return { issue_key: key, ...ISSUE_CLASSES[key], known: true };
  return {
    issue_key: key || null,
    class: 'UNSPECIFIED',
    recovery: 'TOW_TO_WORKSHOP',
    roadside_viable: false,
    known: false,
    note: 'Issue text not in the known taxonomy; defaulted to the conservative recovery (tow) rather than guessing that a roadside fix would hold.',
  };
}

/**
 * Build the incident index used by rule R-006 (Apex rotation): which vehicles have
 * had an incident on which client's run, from the ticket corpus itself.
 */
function buildIncidentIndex(acceptedTickets) {
  const index = new Map();
  for (const a of acceptedTickets) {
    const key = a.validation.resolved.reg_key;
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      ticket_id: a.ticket.ticket_id,
      client: a.ticket.client,
      when: a.ticket.created_at,
      citation: a.ticket._ingest.citation,
    });
  }
  for (const list of index.values()) list.sort((a, b) => a.when.localeCompare(b.when) || a.ticket_id.localeCompare(b.ticket_id));
  return index;
}

/** Decide one ticket. Pure: same inputs, same output, every time. */
function decideTicket(ctx, accepted, incidents) {
  const t = accepted.ticket;
  const v = accepted.validation.resolved.vehicle;
  const driver = accepted.validation.resolved.driver || null;

  const route = {
    origin_hub: t.origin_hub,
    destination: t.destination,
    client: t.client,
    when: t.created_at,
    km_from_origin_hub: t.km_from_origin_hub,
    exclude_reg_key: accepted.validation.resolved.reg_key,
  };

  const classification = classifyIssue(t.issue);
  const replacement = selectReplacement(ctx, route, incidents);
  const sla = planSla(ctx, route);
  const vertexGate = planVertexGate(ctx, route);
  const orionCold = planOrionColdChain(ctx, route);
  const driverCheck = checkDriver(ctx, driver, route);

  // The failed vehicle itself: which rules would now bar it from re-dispatch. This
  // is what tells the workshop whether it is a repair-and-return or a grounding.
  const failedVehicleChecks = evaluateVehicle(ctx, v, { ...route, exclude_reg_key: null }, incidents);
  // Same as-of-the-ticket snapshot the checks above actually reasoned about, so the
  // reported "last workshop visit" / "open jugaad" never shows a later, not-yet-
  // happened maintenance event that the rule evaluation itself correctly ignored.
  const vAsOf = vehicleStateAsOf(v, route.when);

  const planChecks = [...sla.checks, vertexGate, orionCold, driverCheck];
  const actionable = planChecks.filter((c) => c.verdict === 'FAIL');

  const actions = buildActions({ classification, replacement, sla, vertexGate, orionCold, driverCheck, route });

  return {
    ticket_id: t.ticket_id,
    vehicle_reg: v.registration,
    vehicle_reg_key: v.reg_key,
    client: t.client,
    severity: t.severity,
    created_at: t.created_at,
    occurrences_in_queue: accepted.occurrences,
    classification,
    route: {
      origin_hub: route.origin_hub,
      destination: route.destination,
      km_from_origin_hub: route.km_from_origin_hub,
      month: monthOf(route.when),
      hour: hourOf(route.when),
    },
    replacement,
    sla: { planning_hours: sla.sla_hours, quoted_hours: sla.quoted_hours },
    plan_checks: planChecks,
    actionable_constraints: actionable.map((c) => ({ rule_id: c.rule_id, rule_name: c.rule_name, because: c.because, citations: c.citations })),
    failed_vehicle: {
      registration: v.registration,
      blocking_rules: failedVehicleChecks.blocking.map((b) => ({ rule_id: b.rule_id, because: b.because })),
      unknown_rules: failedVehicleChecks.unknown.map((u) => ({ rule_id: u.rule_id, because: u.because })),
      open_jugaad: vAsOf.open_jugaad ? { date: vAsOf.open_jugaad.date, citation: vAsOf.open_jugaad.citation } : null,
      last_workshop_visit: vAsOf.last_workshop_visit,
      odometer_trusted: v.odometer_trusted !== false,
    },
    actions,
    // A selection that rests on a hard rule returning INSUFFICIENT_DATA (no fully
    // clean candidate existed, so the least-bad option was used - see
    // rankCandidates/eligible_with_caveats) is not a routine dispatch: the system
    // does not actually know the vehicle satisfies every hard rule, it only knows
    // nothing contradicts it. That is a judgment call a human should see, not a
    // silent DISPATCHED status indistinguishable from a fully-clean pick.
    needs_human: replacement.outcome === 'NO_ELIGIBLE_VEHICLE'
      || actionable.length > 0
      || (replacement.outcome === 'SELECTED' && replacement.selected.unknowns.length > 0),
    // Every citation this decision rests on, de-duplicated and sorted.
    citations: collectCitations({ accepted, v, replacement, planChecks }),
    assumptions_used: collectAssumptions({ replacement, planChecks }),
  };
}

/** The concrete steps a dispatcher would take, in order, each tied to a rule. */
function buildActions({ classification, replacement, sla, vertexGate, orionCold, driverCheck, route }) {
  const actions = [];
  actions.push({
    step: 1,
    action: classification.recovery === 'TOW_TO_WORKSHOP' ? 'Arrange tow to the nearest workshop' : 'Dispatch roadside assistance',
    because: `${classification.issue_key || 'unspecified issue'} classified ${classification.class}`,
    rule_id: null,
  });

  if (replacement.outcome === 'SELECTED') {
    actions.push({
      step: 2,
      action: `Send replacement ${replacement.selected.registration} from ${replacement.selected.from_hub}`,
      because: replacement.sourcing.basis,
      rule_id: replacement.sourcing.rule_id,
    });
  } else {
    actions.push({
      step: 2,
      action: 'ESCALATE: no eligible replacement vehicle',
      because: replacement.escalation.reason,
      rule_id: 'R-010',
    });
  }

  if (orionCold.verdict === 'FAIL') {
    actions.push({ step: actions.length + 1, action: 'Transfer the load directly to the replacement vehicle; do not stage it at a hub overnight', because: orionCold.because, rule_id: orionCold.rule_id });
  }
  if (vertexGate.verdict === 'FAIL') {
    actions.push({ step: actions.length + 1, action: 'Hold at the last halt and deliver at 08:00; record as SCHEDULED_MORNING_DELIVERY, never as a failed delivery; inform the client coordinator this evening', because: vertexGate.because, rule_id: vertexGate.rule_id });
  }
  if (driverCheck.verdict === 'FAIL') {
    actions.push({ step: actions.length + 1, action: 'Pair the driver for this night run or move the dispatch to daytime', because: driverCheck.because, rule_id: driverCheck.rule_id });
  }
  const monsoon = sla.checks.find((c) => c.rule_id === 'R-009' && c.verdict === 'FAIL');
  if (monsoon) {
    actions.push({ step: actions.length + 1, action: `Quote the padded ETA (${sla.quoted_hours} h) to the client, not the standard figure`, because: monsoon.because, rule_id: 'R-009' });
  }
  return actions;
}

function collectCitations({ accepted, v, replacement, planChecks }) {
  const cites = [
    accepted.ticket._ingest.citation,
    ...(v.source_rows || []),
    ...(v.last_workshop_visit ? [v.last_workshop_visit.citation] : []),
    ...(v.open_jugaad ? [v.open_jugaad.citation] : []),
    ...(v.last_brake_work ? [v.last_brake_work.citation] : []),
    ...(replacement.outcome === 'SELECTED' ? replacement.selected.citations : replacement.sourcing.citations),
    ...planChecks.filter((c) => c.verdict !== 'NOT_APPLICABLE').flatMap((c) => c.citations),
  ].filter(Boolean);
  return [...new Set(cites)].sort();
}

function collectAssumptions({ replacement, planChecks }) {
  const a = [
    ...(replacement.sourcing.assumptions || []),
    ...(replacement.outcome === 'SELECTED'
      ? replacement.selected.checks.filter((c) => c.verdict !== 'NOT_APPLICABLE').flatMap((c) => c.assumptions)
      : []),
    ...planChecks.filter((c) => c.verdict !== 'NOT_APPLICABLE').flatMap((c) => c.assumptions),
    'ASM-002', // every recency window is evaluated as-of a fixed date
  ].filter(Boolean);
  return [...new Set(a)].sort();
}

module.exports = { decideTicket, buildIncidentIndex, classifyIssue, ISSUE_CLASSES };
