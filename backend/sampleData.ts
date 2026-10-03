// Loads the SAMPLE dataset from data/sample/ (Node only). Used by the backend, scripts and tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineResources } from "../shared/engine.ts";
import { buildPolygonIndex, type LandcoverPoint, type PolygonIndex } from "../shared/spatial.ts";
import type { Facility, FirmsRow, HistoryRecord, PolygonCollection, SarCheck } from "../shared/types.ts";

export interface SampleBundle {
  rows: FirmsRow[];
  referenceNow: string;
  polygons: PolygonCollection;
  facilities: Facility[];
  history: HistoryRecord[];
  landcover: LandcoverPoint[];
  sar: (SarCheck & { siteKey: string })[];
}

export function loadSample(root: string): SampleBundle {
  const dir = join(root, "data", "sample");
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  const raw = read<{ rows: FirmsRow[]; referenceNow: string }>("firms_raw.json");
  return {
    rows: raw.rows,
    referenceNow: raw.referenceNow,
    polygons: read<PolygonCollection>("landuse_polygons.geojson"),
    facilities: read<Facility[]>("facilities.json"),
    history: read<HistoryRecord[]>("site_history.json"),
    landcover: read<LandcoverPoint[]>("landcover.json"),
    sar: read<(SarCheck & { siteKey: string })[]>("sentinel1_sample.json"),
  };
}

export function sampleResources(s: SampleBundle, extra: Partial<EngineResources> = {}): { res: EngineResources; index: PolygonIndex } {
  const index = buildPolygonIndex(s.polygons, extra.attributionVersion ?? 1);
  return {
    index,
    res: {
      dataset: "sample",
      now: new Date(s.referenceNow),
      spatialBackend: "memory",
      attributionVersion: 1,
      polygonSource: "SAMPLE polygons (data/sample/landuse_polygons.geojson)",
      polygonSample: true,
      facilities: s.facilities,
      landcover: s.landcover,
      history: s.history,
      historySource: "SAMPLE site history (data/sample/site_history.json)",
      historySample: true,
      baselines: null,
      sar: s.sar,
      reviews: [],
      ...extra,
    },
  };
}
