import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRules, classify, type ClassifyInput } from "../shared/classify.ts";
import { dozierUnmix, forwardModel, I4_SAT_K } from "../shared/dozier.ts";
import { computeSiteHistory } from "../shared/history.ts";
import { analyseKinematics } from "../shared/kinematics.ts";
import { lifecycleOf, linkDetections } from "../shared/lifecycle.ts";
import { parseAcqTime, runQualityGate } from "../shared/qualityGate.ts";
import { tagOf } from "../shared/osmTags.ts";
import { agriSeason, inKilnSeason } from "../shared/season.ts";
import { buildPolygonIndex, compareMatches, eventContext, joinPoint } from "../shared/spatial.ts";
import { isNarrowTfRange, tfText } from "../src/lib/format.ts";
import type { Detection, DozierResult, FacilityMatch, FirmsRow, HistoryRecord, Kinematics, PolygonCollection, SiteContext, SiteHistory } from "../shared/types.ts";

const A = 0.39 * 0.36 * 1e6;

// ---------------------------------------------------------------- Dozier

test("dozier recovers T_f and p from a forward-modelled unsaturated pixel", () => {
  const { b4, b5 } = forwardModel(1250, 0.02, 300, A);
  assert.ok(b4 < I4_SAT_K, "flare pixel should not saturate I4");
  const r = dozierUnmix(b4, b5);
  assert.equal(r.status, "ok");
  assert.ok(Math.abs((r.tfCentralC as number) - 1250) < 2);
  assert.ok(Math.abs((r.pCentralPct as number) - 0.02) < 0.0005);
  // the honest range is reported, not collapsed
  assert.ok(r.tfRangeC && r.tfRangeC[0] < r.tfRangeC[1]);
  assert.ok(r.flags.includes("background_default"));
});

test("dozier reports the background band as a range and flags a wide one", () => {
  const { b4, b5 } = forwardModel(1200, 1.0, 300, A);
  const r = dozierUnmix(b4, Math.min(b5, 379));
  assert.ok(r.tfRangeC && r.tfRangeC[1] > r.tfRangeC[0]);
  const flare = dozierUnmix(...(Object.values(forwardModel(1250, 0.02, 300, A)).slice(0, 2) as [number, number]));
  assert.ok(flare.flags.includes("range_wide"));
});

test("dozier flags saturation and treats the result as a lower bound", () => {
  const { b5 } = forwardModel(900, 0.3, 300, A);
  const r = dozierUnmix(I4_SAT_K, b5);
  assert.ok(r.saturated);
  assert.ok(r.status === "saturated_lower_bound" || r.status === "unsolvable");
});

test("dozier never defaults a missing or implausible band", () => {
  assert.equal(dozierUnmix(null, 300).status, "invalid");
  assert.equal(dozierUnmix(0, 300).status, "invalid");
  assert.equal(dozierUnmix(310, 150).status, "invalid");
});

test("dozier returns unsolvable rather than a guess when the pixel is not warmer than background", () => {
  const r = dozierUnmix(295, 294);
  assert.equal(r.status, "unsolvable");
  assert.equal(r.tfCentralC, null);
});

// ---------------------------------------------------------------- quality gate

const row = (over: Partial<FirmsRow> = {}): FirmsRow => ({
  latitude: "22.38",
  longitude: "70.01",
  bright_ti4: "355.70",
  bright_ti5: "300.70",
  scan: "0.39",
  track: "0.36",
  acq_date: "2026-04-21",
  acq_time: "0748",
  satellite: "N",
  instrument: "VIIRS",
  confidence: "n",
  frp: "8.6",
  daynight: "D",
  source: "VIIRS_SNPP_NRT",
  ...over,
});
const NOW = new Date("2026-04-24T00:00:00Z");

test("gate rejects every malformed row with a reason and never defaults", () => {
  const g = runQualityGate(
    [
      row(),
      row({ bright_ti5: "" }),
      row({ bright_ti4: "0" }),
      row({ acq_time: "2575" }),
      row({ acq_date: "2026-02-30" }),
      row({ latitude: "95" }),
      row({ frp: "abc" }),
      row({ acq_date: "2027-01-01" }),
      row(),
    ],
    "sample",
    NOW,
  );
  assert.equal(g.detections.length, 1);
  assert.deepEqual(
    g.rejections.map((r) => r.reason),
    ["missing_band", "implausible_band", "malformed_timestamp", "malformed_timestamp", "invalid_location", "invalid_frp", "future_timestamp", "duplicate"],
  );
  assert.equal(g.duplicates, 1);
});

test("gate caps confidence on high scan angle and holds low confidence as provisional", () => {
  const g = runQualityGate([row({ scan: "0.72", confidence: "h" }), row({ acq_time: "2012", confidence: "l" })], "sample", NOW);
  assert.equal(g.detections[0].confidence, "n");
  assert.ok(g.detections[0].gateFlags.includes("high_scan_angle"));
  assert.ok(g.detections[0].gateFlags.includes("confidence_capped"));
  assert.equal(g.detections[1].gateStatus, "provisional");
});

test("gate merges MODIS seen in the same pass window into the VIIRS detection", () => {
  const modis = row({ instrument: "MODIS", source: "MODIS_NRT", satellite: "Aqua", brightness: "330", bright_t31: "305", bright_ti4: undefined, bright_ti5: undefined, confidence: "85", acq_time: "0815", latitude: "22.383", longitude: "70.012" });
  const g = runQualityGate([row(), modis], "sample", NOW);
  assert.equal(g.detections.length, 1);
  assert.equal(g.merged, 1);
  assert.equal(g.detections[0].corroboratedBy.length, 1);
});

test("acq_time parse is strict", () => {
  assert.equal(parseAcqTime("2026-04-21", "845"), "2026-04-21T08:45:00Z");
  assert.equal(parseAcqTime("2026-04-21", "2400"), null);
  assert.equal(parseAcqTime("21-04-2026", "0845"), null);
  assert.equal(parseAcqTime("2026-04-21", "08:45"), null);
});

// ---------------------------------------------------------------- season

test("seasonal prior uses the regional default calendar unless OSM has a crop tag", () => {
  const punjabApril = agriSeason("2026-04-22T07:30:00Z", 31.15, 75.34);
  assert.equal(punjabApril.inSeason, true);
  assert.equal(punjabApril.baseline, "regional_default");
  assert.equal(agriSeason("2026-07-15T07:30:00Z", 31.15, 75.34).inSeason, false);
  const rice = agriSeason("2026-04-22T07:30:00Z", 31.15, 75.34, { crop: "rice" });
  assert.equal(rice.baseline, "osm_crop_tag");
  assert.equal(rice.inSeason, false);
  assert.equal(inKilnSeason("2026-08-10T00:00:00Z"), false);
  assert.equal(inKilnSeason("2026-01-10T00:00:00Z"), true);
});

// ---------------------------------------------------------------- lifecycle / kinematics

let seq = 0;
const det = (lat: number, lon: number, t: string, over: Partial<Detection> = {}): Detection => ({
  id: `d${seq++}`,
  dataset: "sample",
  sensor: "VIIRS_SNPP",
  instrument: "VIIRS",
  acqTime: t,
  lat,
  lon,
  brightI4K: 340,
  brightI5K: 305,
  frpMW: 10,
  scanKm: 0.39,
  trackKm: 0.36,
  confidence: "n",
  dayNight: "D",
  staticSourceFlag: null,
  gateStatus: "ok",
  gateFlags: [],
  dozier: dozierUnmix(340, 305),
  corroboratedBy: [],
  match: null,
  runnerUps: [],
  bufferM: 50,
  ...over,
});

test("one missed overpass does not split or close an event", () => {
  const groups = linkDetections([det(20, 86, "2026-04-21T08:00:00Z"), det(20.001, 86.001, "2026-04-22T08:00:00Z")]);
  assert.equal(groups.length, 1); // 24 h gap (a missed night pass) still links
  assert.equal(lifecycleOf("2026-04-22T08:00:00Z", new Date("2026-04-23T09:00:00Z")).lifecycle, "quiet");
  assert.equal(lifecycleOf("2026-04-22T08:00:00Z", new Date("2026-04-25T09:00:00Z")).lifecycle, "extinguished");
});

test("kinematics separates a static flare from a radially expanding fire", () => {
  const flare = analyseKinematics([det(22, 70, "2026-04-21T08:00:00Z"), det(22.0003, 70, "2026-04-21T20:00:00Z"), det(22, 70.0003, "2026-04-22T08:00:00Z")]);
  assert.equal(flare.expanding, false);
  assert.equal(flare.pattern, "static-compact");
  const off = 0.0034; // ~375 m
  const fire = analyseKinematics([
    det(20, 86, "2026-04-21T08:00:00Z"),
    det(20, 86, "2026-04-21T20:00:00Z"), det(20 + off, 86, "2026-04-21T20:00:00Z"), det(20 - off, 86, "2026-04-21T20:00:00Z"),
    det(20, 86 + off, "2026-04-22T08:00:00Z"), det(20, 86 - off, "2026-04-22T08:00:00Z"), det(20 + off, 86, "2026-04-22T08:00:00Z"), det(20 - off, 86, "2026-04-22T08:00:00Z"),
  ]);
  assert.equal(fire.expanding, true);
  assert.equal(fire.pattern, "radial-expansion");
  assert.equal(fire.overpasses, 3);
});

// ---------------------------------------------------------------- classifier

const ctx = (over: Partial<SiteContext> = {}): SiteContext => ({
  tag: "industrial",
  tagSource: "osm_polygon",
  match: {
    polygonId: "P1", facilityId: "F1", name: "Test refinery", tag: "industrial", distanceM: 0, rank: 1, cpcbCategory: "Red",
    source: "test", refreshedAt: "2026-01-01T00:00:00Z", mappedSince: "2015-01-01T00:00:00Z", attributionVersion: 1, osmTags: {},
  },
  runnerUps: [],
  worldCover: null,
  worldCoverSource: "unavailable",
  spatialBackend: "memory",
  attributionVersion: 1,
  facilityType: "Oil refinery",
  kiln: false,
  polygonSource: "test",
  polygonSample: false,
  ...over,
});
const hist = (deviationX: number | null, pattern: SiteHistory["pattern"] = "CONSISTENT"): SiteHistory => ({
  siteKey: "F1", source: "test", sample: false, records: 100, activeDays: 100, spanDays: 360, firstSeen: null, lastSeen: null,
  monthsActive: 12, monthHistogram: Array(12).fill(8), pattern, recurrence: "", historySpreadM: 100, baselineFrpMW: deviationX === null ? null : 10,
  baselineSource: "median", currentFrpMW: 10, deviationX, coldStart: deviationX === null, coldStartReason: deviationX === null ? "no prior detections at this site" : null, series: [],
});
const kin = (over: Partial<Kinematics> = {}): Kinematics => ({
  pattern: "static-compact", expanding: false, pixels: 3, overpasses: 3, spreadM: 100, elongation: 1, pixelGrowth: 1, spreadGrowthM: 0, spreadBearingDeg: null, overpassSeries: [], ...over,
});
const dz = (tf: number | null, p: number | null, saturated = false): DozierResult => ({
  status: tf === null ? "unsolvable" : saturated ? "saturated_lower_bound" : "ok", saturated, tfCentralC: tf, pCentralPct: p,
  tfRangeC: tf === null ? null : [tf, tf], pRangePct: p === null ? null : [p, p], backgroundK: 300, backgroundSigmaK: 4, backgroundSource: "default_300K", flags: [],
});
const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
  dozier: dz(1250, 0.02), heldByGate: false, staticSourceFlag: false, context: ctx(), history: hist(1), kinematics: kin(),
  when: "2026-04-22T08:00:00Z", lat: 22, lon: 70, osmTags: {},
  sar: { status: "not_requested", coherenceDrop: null, preDate: null, postDate: null, detail: "", sample: false }, review: null, ...over,
});

test("routine flare on baseline is a persistent source (central solve gate, deviation a)", () => {
  const c = classify(input({}));
  assert.equal(c.label, "persistent_source");
  assert.equal(c.tier, null);
});

test("persistent signature at a cold-start site is never auto-whitelisted", () => {
  const c = classify(input({ history: hist(null) }));
  assert.equal(c.winningRule, "persistent_source_unverified");
  assert.ok(c.flags.includes("cold_start_manual_review"));
  assert.equal(c.needsReview, true);
});

test("expanding baseline-breaking industrial fire outranks everything and reaches Alert; all signals -> Code Red", () => {
  const alert = classify(input({ dozier: dz(1100, 0.8), history: hist(3.5), kinematics: kin({ expanding: true, overpasses: 2, pattern: "radial-expansion" }) }));
  assert.equal(alert.label, "industrial_fire");
  assert.equal(alert.tier, "alert");
  const red = classify(input({ dozier: dz(null, null, true), history: hist(8), kinematics: kin({ expanding: true, overpasses: 4, pattern: "radial-expansion" }) }));
  assert.equal(red.tier, "code_red");
  assert.equal(red.codeRedRule.satisfied, true);
});

test("SAR never gates Code Red", () => {
  const base = { dozier: dz(null, null, true), history: hist(8), kinematics: kin({ expanding: true, overpasses: 4, pattern: "radial-expansion" as const }) };
  const noSar = classify(input(base));
  const againstSar = classify(input({ ...base, sar: { status: "does_not_support", coherenceDrop: 0.01, preDate: null, postDate: null, detail: "", sample: true } }));
  assert.equal(noSar.tier, "code_red");
  assert.equal(againstSar.tier, "code_red");
  assert.ok(!againstSar.codeRedRule.checks.some((c) => c.name.toLowerCase().includes("sar")));
});

test("operator confirmation escalates Alert to Code Red and Watch to Alert; rejection clears the tier", () => {
  const alertIn = input({ dozier: dz(1100, 0.8), history: hist(3.5), kinematics: kin({ expanding: true, overpasses: 2, pattern: "radial-expansion" }) });
  const review = { dataset: "sample" as const, eventId: "E", decision: "confirm" as const, label: "industrial_fire" as const, note: "", by: "op", at: "t" };
  assert.equal(classify({ ...alertIn, review }).tier, "code_red");
  assert.equal(classify({ ...alertIn, review: { ...review, decision: "reject" } }).tier, null);
  const watchIn = input({ dozier: dz(900, 0.3), history: hist(2.5) });
  assert.equal(classify(watchIn).tier, "watch");
  assert.equal(classify({ ...watchIn, review }).tier, "alert");
});

test("hot heat with no map match becomes unmapped_industrial_candidate at Alert priority", () => {
  const c = classify(input({ context: ctx({ tag: null, tagSource: "none", match: null }), dozier: dz(1100, 0.4) }));
  assert.equal(c.label, "unmapped_industrial_candidate");
  assert.equal(c.tier, "alert");
});

test("rural working lands map to farmland; urban green stays out", () => {
  for (const lu of ["farm", "farmyard", "meadow", "orchard", "vineyard", "grass", "plant_nursery"]) assert.equal(tagOf({ landuse: lu }), "farmland");
  assert.equal(tagOf({ landuse: "park" }), null);
  assert.equal(tagOf({ landuse: "garden" }), null);
  assert.equal(tagOf({ landuse: "farmland" }), "farmland");
});

test("weak-thermal unmapped shape is held as other without Alert; saturated and night stay candidates", () => {
  const unmapped = ctx({ tag: null, tagSource: "none", match: null });
  const single = kin({ pattern: "single-pixel", pixels: 1, overpasses: 1 });
  const weak = { ...dz(950, 0.05), flags: ["background_default", "daytime_reflected_solar", "range_wide"] };
  const c = classify(input({ context: unmapped, dozier: weak, kinematics: single }));
  assert.equal(c.label, "other");
  assert.equal(c.tier, null);
  assert.equal(c.needsReview, true);
  assert.equal(c.reviewPriority, "low");
  assert.ok(c.flags.includes("unmapped_weak_thermal"));
  const sat = classify(input({ context: unmapped, dozier: dz(null, null, true), kinematics: single }));
  assert.equal(sat.label, "unmapped_industrial_candidate");
  assert.equal(sat.tier, "alert");
  const night = { ...dz(950, 0.05), flags: ["background_default", "range_wide"] };
  const nc = classify(input({ context: unmapped, dozier: night, kinematics: single }));
  assert.equal(nc.label, "unmapped_industrial_candidate");
  assert.equal(nc.tier, "alert");
  assert.equal(nc.reviewPriority, "low");
});

test("review priority ranks alert-level review above routine review", () => {
  const alert = classify(input({ dozier: dz(1100, 0.8), history: hist(null), kinematics: kin({ expanding: true, overpasses: 2, pattern: "radial-expansion" }) }));
  assert.equal(alert.tier, "alert");
  assert.equal(alert.needsReview, true);
  assert.equal(alert.reviewPriority, "high");
  const prov = classify(input({ heldByGate: true }));
  assert.equal(prov.reviewPriority, "medium");
});

test("unsolvable non-saturated or gate-held detections are provisional", () => {
  assert.equal(classify(input({ dozier: dz(null, null) })).label, "provisional");
  assert.equal(classify(input({ heldByGate: true })).label, "provisional");
});

test("precedence: safety-critical rule wins and every fired rule is logged", () => {
  const r = applyRules(input({ dozier: dz(1100, 0.8), history: hist(3.5), kinematics: kin({ expanding: true, pattern: "radial-expansion" }) }), null);
  assert.equal(r.winningRule, "industrial_fire");
  assert.ok(r.trace.length === 9);
});

test("agricultural: field-bound single pixel (deviation c), in and off season", () => {
  const farm = ctx({ tag: "farmland", match: null, tagSource: "worldcover" });
  const inS = classify(input({ context: farm, dozier: dz(400, 3), kinematics: kin({ pattern: "single-pixel", pixels: 1, overpasses: 1 }), lat: 31.15, lon: 75.34 }));
  assert.equal(inS.winningRule, "agri_in_season");
  assert.ok(inS.flags.includes("seasonal_baseline=regional_default"));
  const off = classify(input({ context: farm, dozier: dz(400, 3), kinematics: kin({ pattern: "single-pixel", pixels: 1, overpasses: 1 }), lat: 31.15, lon: 75.34, when: "2026-07-15T08:00:00Z" }));
  assert.equal(off.winningRule, "agri_off_season");
  assert.equal(off.needsReview, true);
});

test("wildfire accepts radial or irregular expansion in forest (deviation e); mining needs long smear and low heat", () => {
  const forest = ctx({ tag: "forest", match: null, tagSource: "worldcover" });
  assert.equal(classify(input({ context: forest, dozier: dz(null, null, true), kinematics: kin({ expanding: true, pattern: "radial-expansion" }) })).label, "wildfire");
  assert.equal(classify(input({ context: forest, dozier: dz(null, null, true), kinematics: kin({ expanding: true, pattern: "irregular-expansion" }) })).label, "wildfire");
  const quarry = ctx({ tag: "quarry" });
  assert.equal(classify(input({ context: quarry, dozier: dz(250, 0.5), history: hist(1, "LONG_SMEAR") })).label, "mining");
  assert.equal(classify(input({ context: quarry, dozier: dz(250, 0.5), history: hist(1, "CONSISTENT") })).label, "other");
});

test("cold-start quarry heat with a mining shape is mining but always reviewed", () => {
  const quarry = ctx({ tag: "quarry" });
  const shape = kin({ pattern: "static-compact", pixels: 3, overpasses: 1 });
  const c = classify(input({ context: quarry, dozier: dz(250, 0.5), history: hist(null), kinematics: shape }));
  assert.equal(c.winningRule, "mining_cold_start");
  assert.equal(c.label, "mining");
  assert.equal(c.tier, null);
  assert.equal(c.needsReview, true);
  assert.ok((c.reviewReason ?? "").includes("without a baseline"));
  // dispersed footprints are excluded (could be wind-blown burns over the mine)
  const disp = classify(input({ context: quarry, dozier: dz(250, 0.5), history: hist(null), kinematics: kin({ pattern: "dispersed", pixels: 11, overpasses: 2 }) }));
  assert.notEqual(disp.winningRule, "mining_cold_start");
  // hot quarry heat is not mining-shaped
  const hot = classify(input({ context: quarry, dozier: dz(900, 0.3), history: hist(null), kinematics: shape }));
  assert.notEqual(hot.winningRule, "mining_cold_start");
  // the LONG_SMEAR rule still wins when history exists
  const known = classify(input({ context: quarry, dozier: dz(250, 0.5), history: hist(1, "LONG_SMEAR"), kinematics: shape }));
  assert.equal(known.winningRule, "mining");
});

test("provisional flavor mirrors the hold reason", () => {
  assert.equal(classify(input({ heldByGate: true })).provisionalKind, "low_confidence");
  assert.equal(classify(input({ dozier: dz(null, null) })).provisionalKind, "unsolvable_cool");
  const modis = { ...dz(null, null), status: "not_applicable" as const };
  assert.equal(classify(input({ dozier: modis, allModis: true })).provisionalKind, "modis_only");
  assert.equal(classify(input({})).provisionalKind, null);
});

test("kiln heat outside the operating season is not whitelisted (deviation d)", () => {
  const c = classify(input({ context: ctx({ kiln: true }), when: "2026-08-10T08:00:00Z" }));
  assert.equal(c.winningRule, "industrial_watch");
  assert.ok(c.flags.includes("kiln_off_season"));
});

// ---------------------------------------------------------------- Chirimiri follow-ups (overlap priority, thermal veto, Code Red runner-ups)

const polyFeature = (id: string, tag: "industrial" | "quarry" | "forest" | "farmland", cpcb: "Red" | null = null) => ({
  type: "Feature" as const,
  id,
  properties: {
    id, tag, facilityId: tag === "industrial" ? "F-MINE" : null, name: tag === "industrial" ? "Chirimiri Coal Mine" : null,
    cpcbCategory: cpcb, source: "test", refreshedAt: "2026-01-01T00:00:00Z", mappedSince: null as string | null, osmTags: {},
  },
  geometry: {
    type: "Polygon" as const,
    coordinates: [[[80.49, 22.49], [80.51, 22.49], [80.51, 22.51], [80.49, 22.51], [80.49, 22.49]]],
  },
});

test("spatial join breaks 0 m ties by tag priority: industrial beats forest regardless of polygon id", () => {
  // Forest id sorts first lexically, so pure poly_id order would pick it (the old bug).
  const collection: PolygonCollection = { type: "FeatureCollection", features: [polyFeature("A-FOREST", "forest"), polyFeature("Z-MINE", "industrial", "Red")] };
  const hits = joinPoint(buildPolygonIndex(collection), 22.5, 80.5, 150);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].tag, "industrial");
  assert.equal(hits[0].rank, 1);
  assert.equal(hits[1].tag, "forest");
  // Distance still dominates: a nearer forest beats a farther mine.
  const near = { ...hits[1], distanceM: 0 };
  const far = { ...hits[0], distanceM: 50 };
  assert.ok(compareMatches(near, far) < 0);
});

test("eventContext majority tie-break prefers industrial over forest at equal pixel counts", () => {
  const forestHit: FacilityMatch = { polygonId: "A-FOREST", facilityId: null, name: null, tag: "forest", distanceM: 0, rank: 1, cpcbCategory: null, source: "test", refreshedAt: "2026-01-01T00:00:00Z", mappedSince: null, attributionVersion: 1, osmTags: {} };
  const mineHit: FacilityMatch = { ...forestHit, polygonId: "Z-MINE", facilityId: "F-MINE", name: "Chirimiri Coal Mine", tag: "industrial", cpcbCategory: "Red" };
  const opts = { worldCover: null, worldCoverSource: "unavailable" as const, spatialBackend: "memory" as const, attributionVersion: 1, polygonSource: "test", polygonSample: false, facilityTypeOf: () => ({ type: null, kiln: false }) };
  const dForest = det(22.5, 80.5, "2026-04-21T08:00:00Z", { match: forestHit, runnerUps: [] });
  const dMine = det(22.5, 80.5, "2026-04-21T20:00:00Z", { match: mineHit, runnerUps: [] });
  assert.equal(eventContext([dForest, dMine], opts).tag, "industrial");
});

test("wildfire vetoes unsaturated smoldering heat but keeps saturated and genuinely hot open flame", () => {
  const forest = ctx({ tag: "forest", match: null, tagSource: "worldcover" });
  const expanding = kin({ expanding: true, pattern: "radial-expansion", overpasses: 3, pixels: 9 });
  const smolder = classify(input({ context: forest, dozier: dz(313, 0.5), kinematics: expanding }));
  assert.notEqual(smolder.winningRule, "wildfire");
  assert.ok(smolder.flags.includes("wildfire_thermal_veto"));
  assert.ok(smolder.evidenceAgainst.some((e) => e.includes("vetoed as wildfire")));
  const hot = classify(input({ context: forest, dozier: dz(900, 0.5), kinematics: expanding }));
  assert.equal(hot.winningRule, "wildfire");
  const saturated = classify(input({ context: forest, dozier: dz(null, null, true), kinematics: expanding }));
  assert.equal(saturated.winningRule, "wildfire");
});

test("Code Red spatial signal sees a CPCB Red runner-up behind a non-Red primary", () => {
  const red = { ...ctx().match as FacilityMatch, polygonId: "P2", name: "Neighbour Red plant", cpcbCategory: "Red" as const, rank: 2, distanceM: 0 };
  const orange = { ...ctx().match as FacilityMatch, cpcbCategory: "Orange" as const };
  const fire = { dozier: dz(1100, 0.8), history: hist(8), kinematics: kin({ expanding: true, overpasses: 4, pattern: "radial-expansion" }) };
  // Runner-up Red at 0 m satisfies the spatial check even though the primary is Orange.
  const viaRunnerUp = classify(input({ ...fire, context: ctx({ match: orange, runnerUps: [red] }) }));
  assert.equal(viaRunnerUp.tier, "code_red");
  assert.equal(viaRunnerUp.codeRedRule.satisfied, true);
  assert.ok(viaRunnerUp.codeRedRule.checks.find((c) => c.name === "spatial")?.detail.includes("runner-up"));
  // No Red anywhere -> Alert, not Code Red.
  const noRed = classify(input({ ...fire, context: ctx({ match: orange, runnerUps: [] }) }));
  assert.equal(noRed.tier, "alert");
  assert.equal(noRed.codeRedRule.satisfied, false);
  // A Red runner-up across the fence (5 m, not inside) does not count.
  const acrossFence = classify(input({ ...fire, context: ctx({ match: orange, runnerUps: [{ ...red, distanceM: 5 }] }) }));
  assert.equal(acrossFence.codeRedRule.satisfied, false);
});

test("degenerate Dozier range is explained as display precision, never collapsed to a bare number", () => {
  const narrow: DozierResult = { ...dz(313.1, 0.05), tfRangeC: [313.1, 313.1], backgroundSource: "default_300K", flags: ["background_default", "range_narrow"] };
  assert.equal(isNarrowTfRange(narrow), true);
  assert.ok(tfText(narrow).includes("313"));
  assert.ok(tfText(narrow).includes("313–313"));
  assert.ok(tfText(narrow).includes("below 0.1"));
  assert.ok(tfText(narrow).includes("default 300 K"));
  assert.equal(isNarrowTfRange({ ...narrow, tfRangeC: [300.1, 313.1] }), false);
});

test("live WorldCover fallback tags unmatched sites exactly like sample points", () => {
  const opts = { worldCover: "Cropland", worldCoverSource: "live" as const, spatialBackend: "memory" as const, attributionVersion: 1, polygonSource: "test", polygonSample: false, facilityTypeOf: () => ({ type: null, kiln: false }) };
  const d = det(31.15, 75.34, "2026-04-22T07:30:00Z", { match: null, runnerUps: [] });
  const c = eventContext([d], opts);
  assert.equal(c.tag, "farmland");
  assert.equal(c.tagSource, "worldcover");
  assert.equal(c.worldCoverSource, "live");
  // ... and the fallback drains `other` through the rules (off-season field-bound heat).
  const off = classify(
    input({ context: ctx({ tag: "farmland", match: null, tagSource: "worldcover", worldCover: "Cropland", worldCoverSource: "live" }), dozier: dz(400, 3), kinematics: kin({ pattern: "single-pixel", pixels: 1, overpasses: 1 }), lat: 31.15, lon: 75.34, when: "2026-07-15T08:00:00Z" }),
  );
  assert.equal(off.winningRule, "agri_off_season");
  assert.equal(off.needsReview, true);
});

// ---------------------------------------------------------------- history

test("history excludes the current event, detects patterns, and cold-starts young sites", () => {
  const recs: HistoryRecord[] = [];
  for (let m = 0; m < 12; m++)
    for (let d = 1; d <= 8; d++) recs.push({ siteKey: "S", acqTime: new Date(Date.UTC(2025, 4 + m, d, 8)).toISOString(), lat: 22, lon: 70, frpMW: 10 });
  recs.push({ siteKey: "S", acqTime: "2026-04-22T08:00:00Z", lat: 22, lon: 70, frpMW: 500 }); // the event itself
  const h = computeSiteHistory({ siteKey: "S", records: recs, eventStart: "2026-04-21T00:00:00Z", currentFrpMW: 30, mappedSince: null, source: "t", sample: false });
  assert.equal(h.pattern, "CONSISTENT");
  assert.equal(h.deviationX, 3);
  assert.ok(recs.some((r) => r.acqTime >= "2026-04-21") && h.lastSeen! < "2026-04-21");
  const young = computeSiteHistory({ siteKey: "S", records: recs, eventStart: "2026-04-21T00:00:00Z", currentFrpMW: 30, mappedSince: "2026-03-01T00:00:00Z", source: "t", sample: false });
  assert.equal(young.coldStart, true);
  assert.equal(young.deviationX, null);
});
