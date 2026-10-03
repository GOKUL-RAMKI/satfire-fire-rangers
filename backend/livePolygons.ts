// Live polygon/facility layer: the national Geofabrik extract when present,
// otherwise the tracked Overpass focus-region files. WRI synthetic facility
// polygons merge on top in both cases (they are skipped where an OSM polygon
// already anchors the site).
// Node-only: the backend, scripts and tests use this; nothing here ships to the browser.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildPolygonIndex, joinPoint } from "../shared/spatial.ts";
import type { Facility, PolygonCollection, PolygonFeature } from "../shared/types.ts";

export interface LiveLayer {
  polygons: PolygonCollection;
  facilities: Facility[];
  /** Human-readable provenance for status output. */
  source: string;
  national: boolean;
  refreshedAt: string | null;
}

const EMPTY: PolygonCollection = { type: "FeatureCollection", features: [] };

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

// The national file is ~250 MB; re-parsing it on every pipeline run would add
// seconds each time, so it is cached until its mtime/size changes.
let cache: { key: string; layer: LiveLayer } | null = null;

export function loadLiveLayer(root: string): LiveLayer {
  const nationalFc = join(root, "data", "runtime", "osm", "landuse_india.geojson");
  const nationalFac = join(root, "data", "runtime", "osm", "facilities_india.json");
  const nationalWri = join(root, "data", "runtime", "osm", "facilities_wri.json");
  const focusFc = join(root, "data", "osm", "landuse.geojson");
  const focusFac = join(root, "data", "osm", "facilities.json");

  const useNational = existsSync(nationalFc);
  const key = useNational
    ? [nationalFc, nationalFac, nationalWri].map((p) => {
        try {
          const s = statSync(p);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return "missing";
        }
      }).join("|")
    : [focusFc, focusFac, nationalWri].map((p) => {
        try {
          const s = statSync(p);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return "missing";
        }
      }).join("|");
  if (cache && cache.key === key) return cache.layer;

  const polygons = useNational ? readJson<PolygonCollection>(nationalFc, EMPTY) : readJson<PolygonCollection>(focusFc, EMPTY);
  const facilities = useNational ? readJson<Facility[]>(nationalFac, []) : readJson<Facility[]>(focusFac, []);
  const source = useNational
    ? "Geofabrik india extract via GDAL (data/runtime/osm/landuse_india.geojson)"
    : "OpenStreetMap bulk load (data/osm/landuse.geojson)";

  // WRI second anchor: synthetic plant polygons + facility records, merged in.
  // A synthetic polygon is dropped where an OSM polygon already anchors the site.
  const wri = readJson<{ polygons: PolygonCollection; facilities: Facility[] }>(nationalWri, { polygons: EMPTY, facilities: [] });
  if (wri.polygons.features.length || wri.facilities.length) {
    const index = buildPolygonIndex(polygons, 1);
    const kept = wri.polygons.features.filter((f) => {
      const g = f.geometry;
      const coords = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
      const lat = coords.reduce((s, p) => s + p[1], 0) / coords.length;
      const lon = coords.reduce((s, p) => s + p[0], 0) / coords.length;
      return joinPoint(index, lat, lon, 500).length === 0;
    });
    (polygons.features as PolygonFeature[]).push(...kept);
    const have = new Set(facilities.map((f) => f.id));
    for (const f of wri.facilities) if (!have.has(f.id)) facilities.push(f);
  }

  const layer: LiveLayer = {
    polygons,
    facilities,
    source,
    national: useNational,
    refreshedAt: polygons.features.map((f) => f.properties.refreshedAt).sort().at(-1) ?? null,
  };
  cache = { key, layer };
  return layer;
}

export function clearLiveLayerCache(): void {
  cache = null;
}
