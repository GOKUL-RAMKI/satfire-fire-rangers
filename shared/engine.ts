// End-to-end engine over FIRMS rows: quality gate (+ Dozier at ingestion) -> spatial join ->
// event linking -> history -> kinematics -> classification. The backend swaps the in-memory join for
// PostGIS when a database is configured; everything else is this code.

import { buildEvents } from "./buildEvents.ts";
import { haversineM } from "./geo.ts";
import { runQualityGate, type GateResult } from "./qualityGate.ts";
import { bufferFor, joinPoint, worldCoverAt, type LandcoverPoint, type PolygonIndex } from "./spatial.ts";
import type { Dataset, Detection, Facility, FacilityMatch, FirmsRow, HistoryRecord, Review, SarCheck, SatEvent } from "./types.ts";

export interface EngineResources {
  dataset: Dataset;
  now: Date;
  spatialBackend: "postgis" | "memory";
  attributionVersion: number;
  polygonSource: string;
  polygonSample: boolean;
  facilities: Facility[];
  landcover: LandcoverPoint[] | null;
  history: HistoryRecord[];
  historySource: string;
  historySample: boolean;
  baselines: Record<string, { baselineFrpMW: number }> | null;
  sar: (SarCheck & { siteKey: string })[] | null;
  reviews: Review[];
}

export type JoinFn = (d: Detection) => FacilityMatch[];

export function memoryJoin(index: PolygonIndex): JoinFn {
  return (d) => joinPoint(index, d.lat, d.lon, d.bufferM);
}

/** Sets the fence-line buffer, then attributes every pixel (rank 1 = match, 2-3 = runner-ups). */
export function attribute(detections: Detection[], matchesFor: (d: Detection) => FacilityMatch[]): void {
  for (const d of detections) {
    d.bufferM = bufferFor(d);
    const hits = matchesFor(d);
    d.match = hits[0] ?? null;
    d.runnerUps = hits.slice(1);
  }
}

const SAR_NOT_AVAILABLE: SarCheck = {
  status: "not_available",
  coherenceDrop: null,
  preDate: null,
  postDate: null,
  detail: "Live Sentinel-1 fetch and coherence processing are roadmap; no post-event SAR result for this event.",
  sample: false,
};

export function assembleEvents(detections: Detection[], res: EngineResources): SatEvent[] {
  const facilityById = new Map(res.facilities.map((f) => [f.id, f]));
  // index history once: by site key, plus unmapped CELL-* records for the proximity fallback
  const bySite = new Map<string, HistoryRecord[]>();
  const cellRecords: HistoryRecord[] = [];
  for (const r of res.history) {
    const list = bySite.get(r.siteKey);
    if (list) list.push(r);
    else bySite.set(r.siteKey, [r]);
    if (r.siteKey.startsWith("CELL-")) cellRecords.push(r);
  }
  return buildEvents(detections, {
    dataset: res.dataset,
    now: res.now,
    spatialBackend: res.spatialBackend,
    attributionVersion: res.attributionVersion,
    polygonSource: res.polygonSource,
    polygonSample: res.polygonSample,
    facilityTypeOf: (id) => {
      const f = id ? facilityById.get(id) : undefined;
      return { type: f?.type ?? null, kiln: f?.kiln ?? false };
    },
    worldCoverAt: (lat, lon) => {
      if (!res.landcover) return { worldCover: null, source: "unavailable", place: null };
      const wc = worldCoverAt(res.landcover, lat, lon);
      const place = res.landcover.find((p) => p.place && haversineM(lat, lon, p.lat, p.lon) <= p.radiusKm * 1000)?.place ?? null;
      return { worldCover: wc, source: res.dataset === "sample" ? "sample" : "live", place };
    },
    historyFor: ({ siteKey, lat, lon, match }) => ({
      records: match
        ? (bySite.get(siteKey) ?? [])
        : [...new Set([...(bySite.get(siteKey) ?? []), ...cellRecords.filter((r) => haversineM(lat, lon, r.lat, r.lon) <= 1500)])],
      source: res.historySource,
      sample: res.historySample,
      baselineOverride: res.baselines?.[siteKey] ? { frpMW: res.baselines[siteKey].baselineFrpMW, source: "isolation_forest" } : null,
    }),
    sarFor: ({ siteKey }) => {
      if (!res.sar) return SAR_NOT_AVAILABLE;
      const s = res.sar.find((x) => x.siteKey === siteKey);
      if (!s) return { ...SAR_NOT_AVAILABLE, sample: true, detail: "No Sentinel-1 sample result for this site." };
      const { siteKey: _k, ...check } = s;
      void _k;
      return check;
    },
    reviewFor: (eventId) => res.reviews.find((r) => r.eventId === eventId && r.dataset === res.dataset) ?? null,
  });
}

/** Synchronous in-memory run (scripts, tests, backtest). */
export function runEngine(rows: FirmsRow[], res: EngineResources, index: PolygonIndex): { gate: GateResult; events: SatEvent[] } {
  const gate = runQualityGate(rows, res.dataset, res.now);
  attribute(gate.detections, memoryJoin(index));
  return { gate, events: assembleEvents(gate.detections, res) };
}
