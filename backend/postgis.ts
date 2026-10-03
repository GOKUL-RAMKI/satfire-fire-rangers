// PostGIS spatial layer: idempotent detection inserts, the checklist's LATERAL nearest-first join,
// versioned attribution, polygon bulk load and re-attribution.

import pg from "pg";
import { polygonsOf } from "../shared/geo.ts";
import type { Dataset, Detection, FacilityMatch, PolygonCollection } from "../shared/types.ts";

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
}

export async function attributionVersion(pool: pg.Pool): Promise<number> {
  const r = await pool.query(`SELECT value FROM meta WHERE key='attribution_version'`);
  return Number(r.rows[0]?.value ?? 1);
}

export async function polygonCount(pool: pg.Pool, dataset: Dataset): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM osm_landuse WHERE dataset=$1`, [dataset]);
  return r.rows[0].n;
}

/** Idempotent on (sensor, acq_time, lat, lon): retries and concurrent workers cannot create duplicates. */
export async function insertDetections(pool: pg.Pool, detections: Detection[]): Promise<number> {
  let inserted = 0;
  for (const d of detections) {
    const r = await pool.query(
      `INSERT INTO firms_detections (det_key, dataset, sensor, acq_time, lat, lon, frp_mw, confidence, daynight, scan_km, track_km,
         gate_status, tf_range_c, p_range_pct, status, dozier, buffer_m, geom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::numrange,$14::numrange,$15,$16,$17, ST_SetSRID(ST_MakePoint($6,$5),4326))
       ON CONFLICT DO NOTHING -- (sensor, acq_time, lat, lon) key, or the derived det_key
       `,
      [
        d.id, d.dataset, d.sensor, d.acqTime, d.lat, d.lon, d.frpMW, d.confidence, d.dayNight, d.scanKm, d.trackKm, d.gateStatus,
        d.dozier.tfRangeC ? `[${d.dozier.tfRangeC[0]},${d.dozier.tfRangeC[1]}]` : null,
        d.dozier.pRangePct ? `[${d.dozier.pRangePct[0]},${d.dozier.pRangePct[1]}]` : null,
        d.dozier.status, d.dozier, d.bufferM,
      ],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

// nearest facility wins (rank 1); rank 2-3 are runner-ups stored on the event; no rows = unmapped
const JOIN_SQL = `
SELECT f.det_key, m.poly_id, m.tag, m.facility_id, m.facility_name, m.cpcb_category, m.source, m.refreshed_at,
       m.mapped_since, m.osm_tags, m.distance_m,
       ROW_NUMBER() OVER (PARTITION BY f.det_key ORDER BY m.distance_m, m.poly_id) AS rank
FROM firms_detections f
LEFT JOIN LATERAL (
  SELECT o.poly_id, o.tag, o.facility_id, o.facility_name, o.cpcb_category, o.source, o.refreshed_at, o.mapped_since, o.osm_tags,
         ST_Distance(f.geom::geography, o.geom::geography) AS distance_m
  FROM osm_landuse o
  WHERE o.dataset = f.dataset AND ST_DWithin(f.geom::geography, o.geom::geography, f.buffer_m)
  ORDER BY distance_m, o.poly_id LIMIT 3
) m ON TRUE
WHERE f.det_key = ANY($1)`;

export async function joinDetections(pool: pg.Pool, keys: string[], version: number): Promise<Map<string, FacilityMatch[]>> {
  const out = new Map<string, FacilityMatch[]>();
  for (const k of keys) out.set(k, []);
  if (!keys.length) return out;
  const res = await pool.query(JOIN_SQL, [keys]);
  for (const r of res.rows) {
    if (!r.poly_id) continue;
    out.get(r.det_key)?.push({
      polygonId: r.poly_id,
      facilityId: r.facility_id,
      name: r.facility_name,
      tag: r.tag,
      distanceM: Math.round(Number(r.distance_m) * 10) / 10,
      rank: Number(r.rank),
      cpcbCategory: r.cpcb_category,
      source: r.source,
      refreshedAt: new Date(r.refreshed_at).toISOString(),
      mappedSince: r.mapped_since ? new Date(r.mapped_since).toISOString() : null,
      attributionVersion: version,
      osmTags: r.osm_tags ?? {},
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.rank - b.rank);
  // versioned attribution record
  for (const [k, list] of out)
    for (const m of list)
      await pool.query(
        `INSERT INTO detection_attribution (det_key, poly_id, rank, distance_m, attribution_version) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (det_key, attribution_version, rank) DO NOTHING`,
        [k, m.polygonId, m.rank, m.distanceM, version],
      );
  return out;
}

export async function setSiteKeys(pool: pg.Pool, pairs: { detKey: string; siteKey: string }[]): Promise<void> {
  for (const p of pairs) await pool.query(`UPDATE firms_detections SET site_key=$2 WHERE det_key=$1`, [p.detKey, p.siteKey]);
}

/** Bulk-load polygons for a dataset, bump the attribution version and re-attribute stored detections. */
export async function loadPolygons(pool: pg.Pool, dataset: Dataset, fc: PolygonCollection): Promise<{ loaded: number; version: number; reattributed: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM osm_landuse WHERE dataset=$1`, [dataset]);
    const cur = Number((await client.query(`SELECT value FROM meta WHERE key='attribution_version'`)).rows[0]?.value ?? 1);
    const version = cur + 1;
    // Batched UNNEST inserts: a national layer is ~225k polygons, and one
    // round-trip per row would take the better part of an hour on localhost.
    const BATCH = 1000;
    for (let i = 0; i < fc.features.length; i += BATCH) {
      const chunk = fc.features.slice(i, i + BATCH);
      const polyId: string[] = [];
      const tag: string[] = [];
      const facilityId: (string | null)[] = [];
      const facilityName: (string | null)[] = [];
      const cpcb: (string | null)[] = [];
      const source: string[] = [];
      const refreshedAt: string[] = [];
      const mappedSince: (string | null)[] = [];
      const osmTags: string[] = [];
      const geom: string[] = [];
      for (const f of chunk) {
        const p = f.properties;
        polyId.push(p.id);
        tag.push(p.tag);
        facilityId.push(p.facilityId);
        facilityName.push(p.name);
        cpcb.push(p.cpcbCategory);
        source.push(p.source);
        refreshedAt.push(p.refreshedAt);
        mappedSince.push(p.mappedSince);
        osmTags.push(JSON.stringify(p.osmTags));
        geom.push(JSON.stringify({ type: "MultiPolygon", coordinates: polygonsOf(f.geometry) }));
      }
      await client.query(
        `INSERT INTO osm_landuse (poly_id, dataset, tag, facility_id, facility_name, cpcb_category, source, refreshed_at, mapped_since, osm_tags, attribution_version, geom)
         SELECT p, $2, t, f, fn, c, s, r::timestamptz, m::timestamptz, o::jsonb, $11,
                ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(g),4326))
         FROM unnest($1::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $12::text[])
           AS u(p, t, f, fn, c, s, r, m, o, g)`,
        [polyId, dataset, tag, facilityId, facilityName, cpcb, source, refreshedAt, mappedSince, osmTags, version, geom],
      );
    }
    await client.query(`UPDATE meta SET value=$1 WHERE key='attribution_version'`, [String(version)]);
    await client.query("COMMIT");
    const keys = (await pool.query(`SELECT det_key FROM firms_detections WHERE dataset=$1`, [dataset])).rows.map((r) => r.det_key as string);
    await joinDetections(pool, keys, version);
    return { loaded: fc.features.length, version, reattributed: keys.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
