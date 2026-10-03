// In-memory spatial join with the same semantics as the PostGIS query in db/schema.sql:
//   ST_DWithin(detection, polygon, buffer) on geography, ordered by distance, top 3,
//   rank 1 wins, ranks 2-3 are runner-ups, no rows = unmapped.
// The fence-line buffer shrinks from 50 m to the fire radius implied by the Dozier area estimate.

import { fireRadiusM } from "./dozier.ts";
import { bboxOf, haversineM, pointPolygonDistanceM, polygonsOf } from "./geo.ts";
import type {
  Detection,
  FacilityMatch,
  LandTag,
  PolygonCollection,
  PolygonFeature,
  SiteContext,
} from "./types.ts";

export const SPATIAL = { maxBufferM: 50, nominalPixelM: 375, topN: 3 };

export interface PolygonIndex {
  features: { f: PolygonFeature; polys: number[][][][]; bbox: [number, number, number, number] }[];
  /** coarse grid (GRID_DEG cells) -> indices of features whose bbox touches the cell */
  grid: Map<string, number[]>;
  attributionVersion: number;
}

const GRID_DEG = 0.05; // ~5 km; much larger than the 50 m buffer
const cell = (x: number, y: number) => `${Math.floor(x / GRID_DEG)}:${Math.floor(y / GRID_DEG)}`;

export function buildPolygonIndex(collection: PolygonCollection, attributionVersion = 1): PolygonIndex {
  const features = collection.features.map((f) => {
    const polys = polygonsOf(f.geometry);
    return { f, polys, bbox: bboxOf(polys) };
  });
  const grid = new Map<string, number[]>();
  features.forEach(({ bbox }, i) => {
    // pad by one cell so a point within the buffer of the bbox edge still finds the feature
    for (let x = Math.floor(bbox[0] / GRID_DEG) - 1; x <= Math.floor(bbox[2] / GRID_DEG) + 1; x++)
      for (let y = Math.floor(bbox[1] / GRID_DEG) - 1; y <= Math.floor(bbox[3] / GRID_DEG) + 1; y++) {
        const k = `${x}:${y}`;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
  });
  return { attributionVersion, features, grid };
}

/** Buffer for the boundary match: the Dozier fire radius, capped at 50 m; 50 m when p is unknown or saturated. */
export function bufferFor(d: Detection): number {
  const p = d.dozier.pRangePct?.[1];
  if (d.dozier.saturated || p === undefined || p === null) return SPATIAL.maxBufferM;
  const area = (d.scanKm ?? SPATIAL.nominalPixelM / 1000) * (d.trackKm ?? SPATIAL.nominalPixelM / 1000) * 1e6;
  return Math.round(Math.min(SPATIAL.maxBufferM, fireRadiusM(p, area)) * 10) / 10;
}

export function joinPoint(index: PolygonIndex, lat: number, lon: number, bufferM: number): FacilityMatch[] {
  const padLat = bufferM / 111320 + 1e-6;
  const padLon = bufferM / (111320 * Math.cos((lat * Math.PI) / 180)) + 1e-6;
  const hits: FacilityMatch[] = [];
  for (const i of index.grid.get(cell(lon, lat)) ?? []) {
    const { f, polys, bbox } = index.features[i];
    if (lon < bbox[0] - padLon || lon > bbox[2] + padLon || lat < bbox[1] - padLat || lat > bbox[3] + padLat) continue;
    const dist = Math.min(...polys.map((rings) => pointPolygonDistanceM(lat, lon, rings)));
    if (dist > bufferM) continue;
    const p = f.properties;
    hits.push({
      polygonId: p.id,
      facilityId: p.facilityId,
      name: p.name,
      tag: p.tag,
      distanceM: Math.round(dist * 10) / 10,
      rank: 0,
      cpcbCategory: p.cpcbCategory,
      source: p.source,
      refreshedAt: p.refreshedAt,
      mappedSince: p.mappedSince,
      attributionVersion: index.attributionVersion,
      osmTags: p.osmTags,
    });
  }
  return hits
    .sort((a, b) => a.distanceM - b.distanceM || a.polygonId.localeCompare(b.polygonId))
    .slice(0, SPATIAL.topN)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}

// ---------------------------------------------------------------- WorldCover (sample layer)

export interface LandcoverPoint {
  lat: number;
  lon: number;
  radiusKm: number;
  worldCoverClass: string;
  place?: string;
}

const WORLDCOVER_TAG: Record<string, LandTag | null> = {
  "Tree cover": "forest",
  Cropland: "farmland",
  "Built-up": null, // industrial-like but unmapped: no polygon means no facility anchor
};

export function worldCoverAt(points: LandcoverPoint[], lat: number, lon: number): string | null {
  let best: LandcoverPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = haversineM(lat, lon, p.lat, p.lon);
    if (d <= p.radiusKm * 1000 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best?.worldCoverClass ?? null;
}

/** Event-level context: majority vote of rank-1 matches across the event's pixels, nearest breaks ties. */
export function eventContext(
  detections: Detection[],
  opts: {
    worldCover: string | null;
    worldCoverSource: "sample" | "unavailable";
    spatialBackend: "postgis" | "memory";
    attributionVersion: number;
    polygonSource: string;
    polygonSample: boolean;
    facilityTypeOf: (facilityId: string | null) => { type: string | null; kiln: boolean };
  },
): SiteContext {
  const votes = new Map<string, { m: FacilityMatch; n: number }>();
  for (const d of detections) {
    if (!d.match) continue;
    const v = votes.get(d.match.polygonId);
    if (v) {
      v.n++;
      if (d.match.distanceM < v.m.distanceM) v.m = d.match;
    } else votes.set(d.match.polygonId, { m: d.match, n: 1 });
  }
  const ranked = [...votes.values()].sort((a, b) => b.n - a.n || a.m.distanceM - b.m.distanceM);
  const winner = ranked[0]?.m ?? null;
  const others = new Map<string, FacilityMatch>();
  for (const d of detections)
    for (const m of [d.match, ...d.runnerUps])
      if (m && m.polygonId !== winner?.polygonId) {
        const prev = others.get(m.polygonId);
        if (!prev || m.distanceM < prev.distanceM) others.set(m.polygonId, m);
      }
  const runnerUps = [...others.values()]
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, SPATIAL.topN - 1)
    .map((m, i) => ({ ...m, rank: i + 2 }));

  let tag: LandTag | null = winner?.tag ?? null;
  let tagSource: SiteContext["tagSource"] = winner ? "osm_polygon" : "none";
  if (!winner && opts.worldCover && WORLDCOVER_TAG[opts.worldCover] !== undefined) {
    tag = WORLDCOVER_TAG[opts.worldCover];
    tagSource = tag ? "worldcover" : "none";
  }
  const fac = opts.facilityTypeOf(winner?.facilityId ?? null);
  return {
    tag,
    tagSource,
    match: winner ? { ...winner, rank: 1 } : null,
    runnerUps,
    worldCover: opts.worldCover,
    worldCoverSource: opts.worldCoverSource,
    spatialBackend: opts.spatialBackend,
    attributionVersion: opts.attributionVersion,
    facilityType: fac.type,
    kiln: fac.kiln || winner?.osmTags.man_made === "kiln" || winner?.osmTags.industrial === "brickyard",
    polygonSource: opts.polygonSource,
    polygonSample: opts.polygonSample,
  };
}
