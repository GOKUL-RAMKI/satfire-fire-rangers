// End-to-end: every SAMPLE scenario goes through the same gate -> Dozier -> join -> classify path as
// live data, and must land on its intended class and tier.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSample, sampleResources } from "../backend/sampleData.ts";
import { runEngine } from "../shared/engine.ts";
import { featuresInBbox } from "../shared/spatial.ts";

const s = loadSample(process.cwd());
const { res, index } = sampleResources(s);
const { gate, events } = runEngine(s.rows, res, index);
const bySite = (siteKey: string) => {
  const e = events.find((x) => x.siteKey === siteKey);
  assert.ok(e, `no event for ${siteKey}`);
  return e;
};

test("sample gate: bad rows rejected with reasons, MODIS merged, duplicate caught", () => {
  assert.deepEqual(
    gate.rejections.map((r) => r.reason).sort(),
    ["duplicate", "implausible_band", "invalid_location", "malformed_timestamp", "malformed_timestamp", "missing_band"],
  );
  assert.equal(gate.merged, 1);
});

const expected: [string, string, string | null, string][] = [
  ["FAC-001", "industrial_fire", "code_red", "industrial_fire"],
  ["FAC-003", "industrial_fire", "alert", "industrial_fire"],
  ["FAC-009", "industrial_fire", "watch", "industrial_watch"],
  ["FAC-002", "persistent_source", null, "persistent_source"],
  ["FAC-005", "persistent_source", null, "persistent_source"],
  ["FAC-015", "persistent_source", null, "persistent_source_unverified"],
  ["POLY-AGRI-LDH", "agricultural_fire", null, "agri_in_season"],
  ["POLY-AGRI-KNL", "agricultural_fire", null, "agri_in_season"],
  ["POLY-FOR-SIM", "wildfire", null, "wildfire"],
  ["POLY-FOR-UK", "wildfire", null, "wildfire"],
  ["FAC-004", "mining", null, "mining"],
  ["FAC-010", "mining", null, "mining"],
];
for (const [site, label, tier, rule] of expected)
  test(`scenario ${site} -> ${label} / ${tier ?? "no tier"}`, () => {
    const e = bySite(site);
    assert.equal(e.classification.label, label);
    assert.equal(e.classification.tier, tier);
    assert.equal(e.classification.winningRule, rule);
  });

test("scenario: unmapped, provisional and other", () => {
  assert.equal(bySite("CELL-20.37-72.93").classification.label, "unmapped_industrial_candidate");
  assert.equal(bySite("CELL-19.72-85.32").classification.label, "provisional");
  assert.equal(bySite("CELL-23.01-80.01").classification.label, "other");
});

test("scenario details: Code Red via the explicit rule, SAR supports but is not in the trigger", () => {
  const p = bySite("FAC-001");
  assert.equal(p.classification.codeRedRule.satisfied, true);
  assert.equal(p.sar.status, "supports");
  assert.equal(p.sar.sample, true);
  assert.ok(p.detections.some((d) => d.corroboratedBy.length === 1));
  assert.equal(bySite("CELL-20.37-72.93").sar.status, "sar_baseline_unavailable");
});

test("scenario details: extinguished agri event, wildfire spread bearing, seasonal baseline marker", () => {
  assert.equal(bySite("POLY-AGRI-KNL").lifecycle, "extinguished");
  assert.equal(bySite("POLY-AGRI-KNL").classification.season?.baseline, "osm_crop_tag");
  assert.ok(bySite("POLY-AGRI-LDH").classification.flags.includes("seasonal_baseline=regional_default"));
  const sim = bySite("POLY-FOR-SIM");
  assert.ok(sim.wildfireRoute && sim.wildfireRoute.bearingDeg !== null && sim.wildfireRoute.bearingDeg > 20 && sim.wildfireRoute.bearingDeg < 70);
});

test("cold start routes baseline-dependent calls to review, not wildfire routing", () => {
  assert.equal(bySite("FAC-015").classification.needsReview, true);
  assert.equal(bySite("POLY-FOR-SIM").classification.needsReview, false);
  assert.ok(bySite("POLY-FOR-SIM").classification.flags.includes("cold_start_manual_review"));
});

test("sample thermal data is physically consistent: no I4 above saturation", () => {
  for (const r of s.rows) if (r.bright_ti4 && Number(r.bright_ti4) > 0) assert.ok(Number(r.bright_ti4) <= 367);
});

test("viewport query returns intersecting polygons and caps the set", () => {
  const all = featuresInBbox(index, [60, 5, 100, 38], 2000);
  assert.equal(all.features.length, s.polygons.features.length);
  assert.equal(all.truncated, false);
  assert.equal(featuresInBbox(index, [0, 0, 1, 1], 2000).features.length, 0);
  const capped = featuresInBbox(index, [60, 5, 100, 38], 5);
  assert.equal(capped.features.length, 5);
  assert.equal(capped.truncated, true);
});
