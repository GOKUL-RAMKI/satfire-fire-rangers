// Phase 4 evidence-based classification.
//
// `applyRules` is the checklist §5 reference classifier (precedence, cold-start handling, provisional
// and unmapped early returns, persistent_source_unverified never auto-whitelisted, every fired rule
// logged) with these documented extensions (agents.md "Deviations from the reference code"):
//   a) thermal gates use the central Dozier solve, not the lower bound of the background band
//   b) `industrial_watch`: hot industrial heat that is not a baseline-breaking expanding fire and not a
//      routine source -> Industrial fire at Watch tier (the reference sent it to "other", leaving the
//      plan's Watch tier unreachable)
//   c) agricultural rule accepts field-bound single/compact detections, not only linear-field
//   d) brick-kiln seasonal check: kiln heat outside the operating season is never whitelisted
//   e) wildfire accepts radial as well as irregular expansion inside forest
//   f) detections held by the quality gate (low confidence) are classified provisional
// Thresholds are starting rules to be tuned on data (Phase 8).

import { CLASS_ACTIONS, PRECEDENCE, RULE_TO_CLASS } from "./labels.ts";
import { agriSeason, inKilnSeason } from "./season.ts";
import type {
  Classification,
  ClassKey,
  DozierResult,
  Kinematics,
  Review,
  RuleId,
  RuleTrace,
  SarCheck,
  ScoreBreakdown,
  SeasonInfo,
  Severity,
  SiteContext,
  SiteHistory,
  Tier,
} from "./types.ts";

export const RULES = {
  hotC: 800,
  tinyPct: 0.1, // percent of pixel
  breakX: 3, // baseline deviation for Alert
  watchX: 1.5,
  routineX: 1.5,
  miningMaxC: 400,
  codeRedX: 5,
  codeRedOverpasses: 3,
};

export interface ClassifyInput {
  dozier: DozierResult;
  heldByGate: boolean;
  /** Some (but not all) of the event's detections were held by the quality gate. */
  partialHold?: boolean;
  staticSourceFlag: boolean;
  context: SiteContext;
  history: SiteHistory;
  kinematics: Kinematics;
  when: string;
  lat: number;
  lon: number;
  osmTags: Record<string, string>;
  sar: SarCheck;
  review: Review | null;
}

interface RuleOutcome {
  label: ClassKey;
  winningRule: RuleId | null;
  fired: RuleId[];
  flags: string[];
  trace: RuleTrace[];
}

export function applyRules(input: ClassifyInput, season: SeasonInfo | null): RuleOutcome {
  const { dozier: d, context: c, history: h, kinematics: k } = input;
  const flags: string[] = [];
  const hot = d.saturated || (d.tfCentralC ?? 0) >= RULES.hotC;
  const tiny = (d.pCentralPct ?? 100) < RULES.tinyPct;
  const coldStart = h.deviationX === null;
  const dev = h.deviationX ?? 0;
  if (coldStart) flags.push("cold_start_manual_review");
  // Mixed-confidence events are still classified (only all-held events are provisional),
  // but the uncertainty must travel with the outcome and force a review.
  if (input.partialHold) flags.push("partial_gate_hold");
  const kilnOffSeason = c.kiln && !inKilnSeason(input.when);
  if (kilnOffSeason) flags.push("kiln_off_season");

  const ind = c.tag === "industrial";
  const fieldBound = !k.expanding && (k.pattern === "single-pixel" || k.pattern === "static-compact");
  const checks: [RuleId, boolean, string][] = [];
  const t = (tf: number | null) => (tf === null ? "—" : `${Math.round(tf)} °C`);

  const early = (label: ClassKey, ...extraFlags: (string | undefined)[]): RuleOutcome => ({
    label,
    winningRule: null,
    fired: [],
    flags: [...flags, ...extraFlags.filter((f): f is string => Boolean(f))],
    trace: [],
  });
  // A hot unmapped pixel whose temperature is itself uncertain — single static daytime
  // pixel, unsaturated, wide Dozier range — is held for review WITHOUT Alert tier.
  // Saturated pixels carry real energy however wide the range, and nighttime pixels have
  // no solar contamination, so both stay unmapped candidates (e.g. the Vapi sample).
  const weakUnmappedShape =
    c.tag === null &&
    hot &&
    !d.saturated &&
    !k.expanding &&
    (k.pixels <= 1) &&
    d.flags.includes("daytime_reflected_solar") &&
    d.flags.includes("range_wide");
  // Provisional holds never silently drop the industrial signal: a hot, unmapped
  // detection held for low confidence stays provisional (never auto-escalated) but
  // carries the flag so reviewers see what it would otherwise have become.
  if (input.heldByGate) return early("provisional", "held_low_confidence", c.tag === null && hot ? "hot_unmapped_while_provisional" : undefined);
  if (d.tfCentralC === null && !d.saturated) return early("provisional", `dozier_${d.status}`);
  if (weakUnmappedShape) return early("other", "unmapped_weak_thermal");
  if (c.tag === null && hot) {
    // Live mode has no land-cover fallback, so an unmapped call there rests on
    // polygon absence alone — say so explicitly instead of looking certain.
    const unverified = c.worldCoverSource === "unavailable" ? "spatial_unverified_no_landcover" : undefined;
    return early("unmapped_industrial_candidate", unverified);
  }

  const industrialFire = ind && k.expanding && hot && (coldStart || dev >= RULES.breakX);
  checks.push([
    "industrial_fire",
    industrialFire,
    `industrial=${ind}, expanding=${k.expanding}, hot=${hot} (Tf ${t(d.tfCentralC)}${d.saturated ? ", saturated" : ""}), deviation ${coldStart ? "cold start" : `${dev}×`} (needs ≥${RULES.breakX}× or cold start)`,
  ]);

  const watch =
    ind && hot && !industrialFire && (k.expanding || kilnOffSeason || (coldStart ? !tiny : dev >= RULES.watchX));
  checks.push([
    "industrial_watch",
    watch,
    `industrial=${ind}, hot=${hot}, expanding=${k.expanding}, deviation ${coldStart ? "cold start" : `${dev}×`} (≥${RULES.watchX}×), tiny=${tiny}${kilnOffSeason ? ", kiln off-season" : ""}`,
  ]);

  const wildfire = c.tag === "forest" && (k.pattern === "irregular-expansion" || k.pattern === "radial-expansion");
  checks.push(["wildfire", wildfire, `forest=${c.tag === "forest"}, pattern=${k.pattern}`]);

  const agri = c.tag === "farmland" && (k.pattern === "linear-field" || fieldBound);
  const inSeason = season?.inSeason ?? false;
  checks.push([
    "agri_off_season",
    agri && !inSeason,
    `farmland=${c.tag === "farmland"}, pattern=${k.pattern}, in season=${inSeason}${season ? ` (${season.baseline})` : ""}`,
  ]);

  const mining =
    c.tag === "quarry" && h.pattern === "LONG_SMEAR" && !d.saturated && (d.tfCentralC ?? Infinity) < RULES.miningMaxC;
  checks.push(["mining", mining, `quarry=${c.tag === "quarry"}, history=${h.pattern}, Tf ${t(d.tfCentralC)} (<${RULES.miningMaxC} °C), saturated=${d.saturated}`]);

  const persistentShape = ind && !k.expanding && hot && tiny && !kilnOffSeason;
  const persistent = persistentShape && !coldStart && dev < RULES.routineX;
  checks.push([
    "persistent_source",
    persistent,
    `industrial=${ind}, static=${!k.expanding}, hot=${hot}, p ${d.pCentralPct ?? "—"} % (<${RULES.tinyPct}), deviation ${coldStart ? "cold start" : `${dev}×`} (<${RULES.routineX}×)`,
  ]);
  checks.push([
    "persistent_source_unverified",
    persistentShape && coldStart,
    `persistent signature at a site with no baseline — never auto-whitelisted`,
  ]);
  checks.push(["agri_in_season", agri && inSeason, `farmland=${c.tag === "farmland"}, pattern=${k.pattern}, in season=${inSeason}`]);

  const fired = checks.filter(([, f]) => f).map(([r]) => r);
  const winningRule = PRECEDENCE.find((r) => fired.includes(r)) ?? null;
  return {
    label: winningRule ? RULE_TO_CLASS[winningRule] : "other",
    winningRule,
    fired,
    flags,
    trace: PRECEDENCE.map((r) => {
      const found = checks.find(([id]) => id === r);
      return { rule: r, fired: found?.[1] ?? false, detail: found?.[2] ?? "" };
    }),
  };
}

function codeRedRule(input: ClassifyInput) {
  const { dozier: d, context: c, history: h, kinematics: k } = input;
  const hot = d.saturated || (d.tfCentralC ?? 0) >= RULES.hotC;
  const dev = h.deviationX;
  const checks = [
    {
      name: "thermal",
      ok: hot && dev !== null && dev >= RULES.codeRedX,
      detail: `hot=${hot}, deviation ${dev === null ? "cold start" : `${dev}×`} (needs ≥${RULES.codeRedX}×)`,
    },
    {
      name: "spatial",
      ok: c.tag === "industrial" && c.match?.distanceM === 0 && c.match?.cpcbCategory === "Red",
      detail: `inside mapped facility=${c.match?.distanceM === 0}, CPCB ${c.match?.cpcbCategory ?? "—"} (needs Red)`,
    },
    {
      name: "kinematic",
      ok: k.expanding && k.overpasses >= RULES.codeRedOverpasses,
      detail: `expanding=${k.expanding} over ${k.overpasses} overpasses (needs ≥${RULES.codeRedOverpasses})`,
    },
    { name: "historical", ok: !h.coldStart, detail: h.coldStart ? "no baseline (cold start)" : `baseline ${h.baselineFrpMW} MW` },
  ];
  // SAR is post-event confirmation only and is deliberately NOT part of this trigger.
  return { satisfied: checks.every((x) => x.ok), checks };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function score(label: ClassKey, input: ClassifyInput, season: SeasonInfo | null): ScoreBreakdown {
  const { dozier: d, context: c, history: h, kinematics: k, sar } = input;
  const hot = d.saturated || (d.tfCentralC ?? 0) >= RULES.hotC;
  const tiny = (d.pCentralPct ?? 100) < RULES.tinyPct;
  const tf = d.tfCentralC;

  let thermal = 0.3;
  if (label === "industrial_fire") thermal = hot && !tiny ? 1 : hot ? 0.6 : 0.3;
  else if (label === "persistent_source") thermal = hot && tiny ? 1 : 0.5;
  else if (label === "agricultural_fire") thermal = d.saturated ? 0.6 : tf !== null && tf >= 250 && tf <= 650 ? 1 : 0.4;
  else if (label === "wildfire") thermal = d.saturated || (tf !== null && tf >= 450) ? 0.9 : 0.5;
  else if (label === "mining") thermal = tf !== null && tf < RULES.miningMaxC && !d.saturated ? 1 : 0.3;
  else if (label === "unmapped_industrial_candidate") thermal = 0.8;
  if (d.flags.includes("range_wide")) thermal *= 0.6;
  else if (d.flags.includes("partial_range")) thermal *= 0.8;
  if (input.staticSourceFlag && label === "persistent_source") thermal = Math.max(thermal, 0.9);

  const expectedTag: Partial<Record<ClassKey, string>> = {
    industrial_fire: "industrial",
    persistent_source: "industrial",
    wildfire: "forest",
    agricultural_fire: "farmland",
    mining: "quarry",
  };
  let spatial = 0.2;
  if (expectedTag[label] && c.tag === expectedTag[label]) {
    spatial = c.tagSource === "worldcover" ? 0.6 : c.match?.distanceM === 0 ? 1 : 0.8;
    if (c.polygonSample) spatial *= 0.9;
  } else if (label === "unmapped_industrial_candidate") spatial = 0.3;

  let historical = 0.2;
  if (label === "industrial_fire")
    historical = h.coldStart ? 0.3 : (h.deviationX ?? 0) >= RULES.codeRedX ? 1 : (h.deviationX ?? 0) >= RULES.breakX ? 0.8 : 0.5;
  else if (label === "persistent_source") historical = h.coldStart ? 0 : h.pattern === "CONSISTENT" ? 1 : 0.5;
  else if (label === "mining") historical = h.pattern === "LONG_SMEAR" ? 1 : 0.3;
  else if (label === "agricultural_fire")
    historical = season?.inSeason ? (season.baseline === "osm_crop_tag" ? 1 : 0.5) : 0.2;
  else if (label === "wildfire") historical = h.pattern === "NONE" || h.coldStart ? 1 : 0.5;

  let kinematic = 0.3;
  if (label === "industrial_fire") kinematic = k.expanding ? (k.overpasses >= RULES.codeRedOverpasses ? 1 : 0.7) : 0.4;
  else if (label === "wildfire") kinematic = k.expanding ? 1 : 0.4;
  else if (label === "agricultural_fire") kinematic = k.pattern === "linear-field" ? 1 : !k.expanding ? 0.7 : 0.3;
  else if (label === "persistent_source" || label === "mining") kinematic = !k.expanding ? 1 : 0.2;

  const verification = sar.status === "supports" ? 1 : 0;

  const s = {
    thermal: Math.round(30 * clamp01(thermal)),
    spatial: Math.round(25 * clamp01(spatial)),
    historical: Math.round(20 * clamp01(historical)),
    kinematic: Math.round(15 * clamp01(kinematic)),
    verification: Math.round(10 * verification),
  };
  return { ...s, total: s.thermal + s.spatial + s.historical + s.kinematic + s.verification };
}

function evidence(input: ClassifyInput, season: SeasonInfo | null) {
  const { dozier: d, context: c, history: h, kinematics: k, sar } = input;
  const hot = d.saturated || (d.tfCentralC ?? 0) >= RULES.hotC;
  const f: string[] = [];
  const a: string[] = [];
  if (d.saturated) f.push("I4 saturated — T_f is a lower bound; classification leans on saturation, FRP and footprint");
  if (d.tfCentralC !== null)
    f.push(`Dozier central solve T_f ≈ ${Math.round(d.tfCentralC)} °C, p ≈ ${d.pCentralPct} % (range ${d.tfRangeC?.[0]}–${d.tfRangeC?.[1]} °C, ${d.pRangePct?.[0]}–${d.pRangePct?.[1]} %)`);
  if (d.flags.includes("range_wide")) a.push("Dozier range is wide across the background band — thermal evidence down-weighted");
  if (d.flags.includes("background_default")) a.push("Background fixed at 300 K default (no neighbour pixels in FIRMS) — flagged");
  if (d.flags.includes("daytime_reflected_solar")) a.push("Daytime pass: I4 includes reflected sunlight");
  if (c.match) f.push(`${c.match.distanceM === 0 ? "Inside" : `${c.match.distanceM} m from`} ${c.match.name ?? c.match.polygonId} (${c.tag}, ${c.match.source})`);
  else if (c.tagSource === "worldcover") f.push(`No mapped polygon; WorldCover class "${c.worldCover}" → ${c.tag}`);
  else if (c.tag === null && hot) f.push("Hot signature with no map match — basis for the unmapped industrial candidate call");
  else a.push("No mapped land-use polygon or land-cover class at this location");
  if (c.tag === null && c.worldCoverSource === "unavailable")
    a.push("No land-cover fallback in live mode — the unmapped call rests on polygon absence alone");
  if (input.partialHold) a.push("Mixed confidence: some pixels held by the quality gate — classification is less certain");
  if (input.heldByGate && c.tag === null && hot)
    a.push("Hot unmapped signature held provisional for low confidence — review as potential industrial heat, never auto-escalated");
  if (
    c.tag === null && hot && !d.saturated && !k.expanding && k.pixels <= 1 &&
    d.flags.includes("daytime_reflected_solar") && d.flags.includes("range_wide")
  )
    a.push("Weak-thermal unmapped shape (single static daytime pixel, wide Dozier range) — held for review without Alert tier");
  if (c.runnerUps.length) a.push(`Ambiguous attribution: ${c.runnerUps.length} runner-up polygon(s) within buffer`);
  if (h.coldStart) a.push(`Cold start: ${h.coldStartReason} — routed to manual review`);
  else f.push(`Site history ${h.pattern}: ${h.activeDays} active days, baseline ${h.baselineFrpMW} MW, current ${h.currentFrpMW} MW (${h.deviationX}×)`);
  f.push(`Kinematics: ${k.pattern}, ${k.pixels} pixel(s) over ${k.overpasses} overpass(es)${k.expanding ? ", expanding" : ", not expanding"}`);
  if (season) (season.inSeason ? f : a).push(`Seasonal prior (${season.baseline}): ${season.inSeason ? "in" : "outside"} ${season.region} burning window ${season.windows}`);
  if (input.staticSourceFlag) f.push("FIRMS static-source flag set");
  if (sar.status === "supports") f.push(`Sentinel-1 post-event check supports the thermal classification${sar.sample ? " (sample data)" : ""}`);
  else if (sar.status === "does_not_support") a.push(`Sentinel-1 post-event check does not support the thermal classification${sar.sample ? " (sample data)" : ""}`);
  else if (sar.status === "sar_baseline_unavailable") a.push("sar_baseline_unavailable — relying on thermal and spatial evidence");
  return { f, a };
}

export function severityOf(label: ClassKey, tier: Tier | null): Severity {
  // Note: unmapped candidates carry tier=alert, so they return HIGH via the tier
  // branch above. The label branch below only applies after operator rejection
  // (tier cleared) or if a future rule emits the label without a tier.
  if (tier === "code_red") return "CRITICAL";
  if (tier === "alert") return "HIGH";
  if (tier === "watch" || label === "wildfire") return "MEDIUM";
  if (label === "provisional" || label === "other" || label === "unmapped_industrial_candidate") return "LOW";
  return "INFO";
}

export function classify(input: ClassifyInput): Classification {
  const season =
    input.context.tag === "farmland" ? agriSeason(input.when, input.lat, input.lon, input.osmTags) : null;
  const r = applyRules(input, season);
  const cr = codeRedRule(input);
  const review = input.review;

  let tier: Tier | null = null;
  let tierReason = "No alert tier for this class.";
  if (r.winningRule === "industrial_fire") {
    tier = "alert";
    tierReason = "Baseline-breaking heat with footprint growth — sent to operators for verification.";
    if (cr.satisfied) {
      tier = "code_red";
      tierReason = "Explicit rule: thermal, spatial, kinematic and historical signals all agree.";
    }
  } else if (r.winningRule === "industrial_watch") {
    tier = "watch";
    tierReason = "Heat above baseline or unclear fit at an industrial site — logged and monitored.";
  } else if (r.label === "unmapped_industrial_candidate") {
    tier = "alert";
    tierReason = "Industrial-like signature with no map match — same review priority as a matched industrial fire.";
  }
  if (review && tier) {
    if (review.decision === "reject") {
      tier = null;
      tierReason = `Rejected by operator ${review.by} at ${review.at}.`;
    } else if (tier === "alert") {
      tier = "code_red";
      tierReason = `Operator ${review.by} confirmed at ${review.at}.`;
    } else if (tier === "watch") {
      tier = "alert";
      tierReason = `Operator ${review.by} confirmed at ${review.at}; escalated to Alert.`;
    }
  }

  const reviewReasons: string[] = [];
  if (r.label === "provisional") reviewReasons.push("provisional detection");
  if (r.flags.includes("hot_unmapped_while_provisional"))
    reviewReasons.push("hot unmapped signature held for low confidence");
  if (r.flags.includes("partial_gate_hold")) reviewReasons.push("mixed-confidence pixels (partial gate hold)");
  if (r.label === "other" && r.flags.includes("unmapped_weak_thermal"))
    reviewReasons.push("weak-thermal unmapped signature (single static daytime pixel, wide Dozier range)");
  else if (r.label === "other") reviewReasons.push("fits no class");
  if (r.label === "unmapped_industrial_candidate") reviewReasons.push("unmapped industrial-like heat");
  if (r.fired.includes("persistent_source_unverified") && r.winningRule === "persistent_source_unverified")
    reviewReasons.push("persistent signature without a baseline (never auto-whitelisted)");
  if (r.winningRule === "agri_off_season") reviewReasons.push("agricultural pattern outside the burning season");
  // cold start matters where a baseline decides the outcome (never auto-whitelist a site without one);
  // wildfire / agricultural calls do not rest on a site baseline
  const baselineDependent = r.label === "industrial_fire" || r.label === "persistent_source" || r.label === "mining";
  if (r.flags.includes("cold_start_manual_review") && baselineDependent && !reviewReasons.length)
    reviewReasons.push(`cold-start site (${input.history.coldStartReason ?? "no baseline"})`);
  if (r.flags.includes("kiln_off_season")) reviewReasons.push("kiln heat outside operating season");
  const needsReview = !review && reviewReasons.length > 0;

  // Triage order for the review queue. A hot unmapped alert is normally highest
  // priority — except the weak-thermal shape (single static pixel, daytime and/or
  // wide Dozier range, never saturated), which sorts last but is still reviewed.
  let reviewPriority: "high" | "medium" | "low" | null = null;
  if (needsReview) {
    const weakThermal =
      !input.dozier.saturated &&
      !input.kinematics.expanding &&
      input.kinematics.pixels <= 1 &&
      (input.dozier.flags.includes("daytime_reflected_solar") || input.dozier.flags.includes("range_wide"));
    reviewPriority =
      tier === "alert" || tier === "code_red"
        ? r.label === "unmapped_industrial_candidate" && weakThermal
          ? "low"
          : "high"
        : r.flags.includes("unmapped_weak_thermal")
          ? "low"
          : "medium";
  }

  const ev = evidence(input, season);
  return {
    label: r.label,
    winningRule: r.winningRule,
    fired: r.fired,
    flags: [...r.flags, ...(season?.baseline === "regional_default" ? ["seasonal_baseline=regional_default"] : [])],
    ruleTrace: r.trace,
    tier,
    tierReason,
    codeRedRule: cr,
    needsReview,
    reviewReason: needsReview ? reviewReasons.join("; ") : null,
    reviewPriority,
    action: CLASS_ACTIONS[r.label],
    confidence: score(r.label, input, season),
    evidenceFor: ev.f,
    evidenceAgainst: ev.a,
    season,
  };
}
