'use strict';
/**
 * Replacement vehicle selection.
 *
 * Rule R-010 decides *which hub* sends, and it is deliberately counter-intuitive:
 * within 50 km of the origin hub the origin hub sends, even when another hub is
 * nearer, because the small hubs are held in reserve for premium dispatches.
 * The obvious "nearest hub" implementation is the wrong answer, and the dispatcher says
 * so explicitly - so the sourcing decision is made first and separately from
 * eligibility, and it is cited.
 */
const { evaluateVehicle, ruleById, result } = require('../rules/engine');

/**
 * Decide which hubs may source the replacement, in priority order.
 * Returns { hubs[], basis, citations[], assumptions[], derived }.
 */
function sourcingHubs(ctx, route) {
  const rule = ruleById(ctx, 'R-010');
  const threshold = rule.params.threshold_km;
  const km = route.km_from_origin_hub;

  if (km <= threshold) {
    return {
      hubs: [route.origin_hub],
      basis: `breakdown is ${km} km from ${route.origin_hub}, within the ${threshold} km threshold, so the origin hub sends`,
      rule_id: rule.id,
      citations: rule.citations,
      assumptions: [],
      derived: false,
      exclusive: true, // R-010 is hard: no other hub may be used without a human waiver
    };
  }

  // Beyond the threshold: nearest hub with an eligible vehicle. "Nearest" needs a
  // distance matrix that does not exist in the bundle - see ASM-007.
  const distances = ctx.config.hubs.distances[route.origin_hub] || {};
  const ordered = [route.origin_hub].concat(
    Object.entries(distances)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([hub]) => hub)
  );
  return {
    hubs: ordered,
    basis: `breakdown is ${km} km from ${route.origin_hub}, beyond the ${threshold} km threshold, so the nearest hub with an eligible vehicle sends`,
    rule_id: rule.id,
    citations: rule.citations,
    assumptions: rule.assumptions,
    derived: true, // hub ordering rests on an estimated distance table
    exclusive: false,
  };
}

/**
 * Rank eligible candidates.
 * Ordering is fully deterministic - the final tie-break is the registration - so
 * the same queue always produces the same vehicle choice.
 */
function rankCandidates(candidates, route) {
  const orionMinYear = route.client === 'Orion Pharma';
  return [...candidates].sort((a, b) => {
    // 1. Fully eligible before eligible-with-unknowns.
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    // 2. Prefer a choice that does not rest on a derived/assumed value.
    if (a.derived_used !== b.derived_used) return a.derived_used ? 1 : -1;
    // 3. For Orion, newer is safer against their RC gate check.
    if (orionMinYear && (a.vehicle.year || 0) !== (b.vehicle.year || 0)) {
      return (b.vehicle.year || 0) - (a.vehicle.year || 0);
    }
    // 4. Prefer a vehicle with maintenance history over one with none - a blank
    //    history is an absence of evidence, not evidence of health.
    if ((a.vehicle.maintenance_count > 0) !== (b.vehicle.maintenance_count > 0)) {
      return a.vehicle.maintenance_count > 0 ? -1 : 1;
    }
    // 5. Newest, then registration.
    if ((a.vehicle.year || 0) !== (b.vehicle.year || 0)) return (b.vehicle.year || 0) - (a.vehicle.year || 0);
    return a.reg_key.localeCompare(b.reg_key);
  });
}

/**
 * Select a replacement vehicle for a breakdown.
 *
 * Returns a decision object that always explains itself, including the case where
 * no vehicle is eligible - which is a legitimate answer, not a failure. The
 * pipeline escalates that to a human rather than relaxing a hard rule on its own.
 */
function selectReplacement(ctx, route, incidents) {
  const sourcing = sourcingHubs(ctx, route);
  const allVehicles = [...ctx.vehicles.values()].sort((a, b) => a.reg_key.localeCompare(b.reg_key));

  const perHub = [];
  let chosen = null;
  let chosenHub = null;

  for (const hub of sourcing.hubs) {
    const atHub = allVehicles.filter((v) => v.home_hub === hub);
    const evaluated = atHub.map((v) => ({ ...evaluateVehicle(ctx, v, route, incidents), vehicle: v }));
    const usable = evaluated.filter((e) => e.eligible || e.eligible_with_caveats);
    const ranked = rankCandidates(usable, route);

    perHub.push({
      hub,
      considered: evaluated.length,
      eligible: evaluated.filter((e) => e.eligible).length,
      eligible_with_caveats: evaluated.filter((e) => e.eligible_with_caveats).length,
      rejected: evaluated.filter((e) => !e.eligible && !e.eligible_with_caveats).length,
      // Why each rejection happened, aggregated - useful when the answer is "none".
      rejection_reasons: tallyRejections(evaluated),
    });

    if (ranked.length && !chosen) {
      chosen = ranked[0];
      chosenHub = hub;
      if (sourcing.exclusive) break; // R-010 forbids looking past the origin hub
    }
    if (sourcing.exclusive) break;
  }

  if (!chosen) {
    // No eligible vehicle. If R-010 confined us to the origin hub, say what a
    // waiver would cost: name the nearest alternative and the rule it would break.
    const fallback = sourcing.exclusive ? findWaiverOption(ctx, route, incidents) : null;
    return {
      outcome: 'NO_ELIGIBLE_VEHICLE',
      sourcing,
      hubs_examined: perHub,
      selected: null,
      escalation: {
        reason: sourcing.exclusive
          ? `No eligible vehicle at the origin hub (${route.origin_hub}), and rule R-010 confines sourcing to the origin hub for a breakdown ${route.km_from_origin_hub} km out.`
          : `No eligible vehicle at any hub reachable under rule R-010.`,
        requires: 'human decision',
        waiver_option: fallback,
        rule_that_would_be_waived: sourcing.exclusive ? 'R-010' : null,
      },
    };
  }

  return {
    outcome: 'SELECTED',
    sourcing,
    hubs_examined: perHub,
    selected: {
      reg_key: chosen.reg_key,
      registration: chosen.registration,
      vehicle_id: chosen.vehicle.vehicle_id,
      from_hub: chosenHub,
      year: chosen.vehicle.year,
      bs_stage: chosen.vehicle.bs_stage,
      engine_heater: chosen.vehicle.engine_heater,
      capacity_tonnes: chosen.vehicle.capacity_tonnes,
      fully_eligible: chosen.eligible,
      // Precise, not blanket: which specific checks (if any) rest on an assumption,
      // and whether that assumption is actually close to flipping the verdict for
      // this vehicle. See src/rules/engine.js evaluateVehicle for why this replaced
      // a single "rests_on_assumption" boolean.
      rests_on_assumption: chosen.derived_used,
      derived_checks: chosen.derived_checks,
      has_borderline_assumption: chosen.has_borderline_assumption,
      unknowns: chosen.unknown.map((u) => ({ rule_id: u.rule_id, because: u.because })),
      checks: chosen.checks,
      citations: dedupe([
        ...sourcing.citations,
        ...chosen.checks.filter((c) => c.verdict !== 'NOT_APPLICABLE').flatMap((c) => c.citations),
        chosen.vehicle.year_citation,
        chosen.vehicle.bs_stage_citation,
      ].filter(Boolean)),
    },
  };
}

/** What the nearest non-origin hub could offer, for a human weighing a waiver. */
function findWaiverOption(ctx, route, incidents) {
  const distances = ctx.config.hubs.distances[route.origin_hub] || {};
  const ordered = Object.entries(distances).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const allVehicles = [...ctx.vehicles.values()].sort((a, b) => a.reg_key.localeCompare(b.reg_key));
  for (const [hub, km] of ordered) {
    const atHub = allVehicles.filter((v) => v.home_hub === hub);
    const evaluated = atHub.map((v) => ({ ...evaluateVehicle(ctx, v, route, incidents), vehicle: v }));
    const ranked = rankCandidates(evaluated.filter((e) => e.eligible), route);
    if (ranked.length) {
      return {
        hub,
        approx_distance_km: km,
        registration: ranked[0].registration,
        note: 'This vehicle is eligible on every rule except that sourcing it breaks R-010, which reserves other hubs for premium dispatches. Approving it is a deliberate trade, not an automatic fallback.',
        assumptions: ['ASM-007'],
      };
    }
  }
  return null;
}

function tallyRejections(evaluated) {
  const tally = {};
  for (const e of evaluated) {
    for (const b of e.blocking) tally[b.rule_id] = (tally[b.rule_id] || 0) + 1;
    for (const u of e.unknown) tally[`${u.rule_id}:unknown`] = (tally[`${u.rule_id}:unknown`] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function dedupe(arr) {
  return [...new Set(arr)].sort();
}

module.exports = { selectReplacement, sourcingHubs, rankCandidates };
