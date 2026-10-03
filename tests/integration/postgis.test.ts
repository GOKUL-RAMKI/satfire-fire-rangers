// Integration: PostGIS and the in-memory join must agree on every sample detection (nearest match,
// runner-ups, unmapped) and inserts must be idempotent. Needs DATABASE_URL (npm run db:up && db:init).
// Run: DATABASE_URL=postgres://satfire:satfire_dev@localhost:5433/satfire npm run test:integration

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadSample } from "../../backend/sampleData.ts";
import { attributionVersion, createPool, insertDetections, joinDetections, loadPolygons } from "../../backend/postgis.ts";
import { runQualityGate } from "../../shared/qualityGate.ts";
import { bufferFor, buildPolygonIndex, joinPoint } from "../../shared/spatial.ts";

const url = process.env.DATABASE_URL;
const s = loadSample(process.cwd());
const pool = url ? createPool(url) : null;

before(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM firms_detections WHERE dataset='sample'`);
  await loadPolygons(pool, "sample", s.polygons);
});
after(async () => {
  await pool?.end();
});

test("PostGIS nearest-first join matches the in-memory join on every sample detection", { skip: !pool && "DATABASE_URL not set" }, async () => {
  const gate = runQualityGate(s.rows, "sample", new Date(s.referenceNow));
  for (const d of gate.detections) d.bufferM = bufferFor(d);
  await insertDetections(pool!, gate.detections);
  const version = await attributionVersion(pool!);
  const db = await joinDetections(pool!, gate.detections.map((d) => d.id), version);
  const index = buildPolygonIndex(s.polygons);
  let matched = 0;
  let unmapped = 0;
  for (const d of gate.detections) {
    const mem = joinPoint(index, d.lat, d.lon, d.bufferM);
    const pg = db.get(d.id) ?? [];
    assert.deepEqual(pg.map((m) => m.polygonId), mem.map((m) => m.polygonId), `polygon ranking differs for ${d.id}`);
    for (let i = 0; i < pg.length; i++) {
      // spheroid (PostGIS) vs local projection (memory): agree within 1 m + 1 %
      assert.ok(Math.abs(pg[i].distanceM - mem[i].distanceM) <= 1 + 0.01 * pg[i].distanceM, `distance differs for ${d.id}`);
    }
    if (pg.length) matched++;
    else unmapped++;
  }
  assert.ok(matched > 50 && unmapped >= 3, `matched ${matched}, unmapped ${unmapped}`);
});

test("detection inserts are idempotent on (sensor, acq_time, lat, lon)", { skip: !pool && "DATABASE_URL not set" }, async () => {
  const gate = runQualityGate(s.rows, "sample", new Date(s.referenceNow));
  const before = (await pool!.query(`SELECT count(*)::int AS n FROM firms_detections WHERE dataset='sample'`)).rows[0].n;
  const inserted = await insertDetections(pool!, gate.detections);
  const afterN = (await pool!.query(`SELECT count(*)::int AS n FROM firms_detections WHERE dataset='sample'`)).rows[0].n;
  assert.equal(inserted, 0);
  assert.equal(afterN, before);
});

test("the spatial index is on geography, the type the queries use", { skip: !pool && "DATABASE_URL not set" }, async () => {
  const r = await pool!.query(`SELECT indexdef FROM pg_indexes WHERE indexname IN ('idx_landuse_geog','idx_det_geog')`);
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) assert.match(row.indexdef, /geography/);
});
