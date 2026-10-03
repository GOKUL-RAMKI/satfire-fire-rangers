// Assembles classified events from gated, Dozier-solved, spatially attributed detections.
// Shared by the backend pipeline and scripts/classify-batch.ts (backtest), so there is one
// implementation of the rules.

import { classify, severityOf } from "./classify.ts";
import { computeSiteHistory, perOverpassFrp } from "./history.ts";
import { analyseKinematics } from "./kinematics.ts";
import { lifecycleOf, linkDetections } from "./lifecycle.ts";
import { eventContext } from "./spatial.ts";
import type { Dataset, Detection, FacilityMatch, HistoryRecord, Review, SarCheck, SatEvent } from "./types.ts";

export interface BuildEventsDeps {
  dataset: Dataset;
  now: Date;
  spatialBackend: "postgis" | "memory";
  attributionVersion: number;
  polygonSource: string;
  polygonSample: boolean;
  facilityTypeOf: (facilityId: string | null) => { type: string | null; kiln: boolean };
  worldCoverAt: (lat: number, lon: number) => { worldCover: string | null; source: "sample" | "unavailable"; place: string | null };
  historyFor: (args: { siteKey: string; lat: number; lon: number; match: FacilityMatch | null; eventStart: string }) => {
    records: HistoryRecord[];
    source: string;
    sample: boolean;
    baselineOverride: { frpMW: number; source: "isolation_forest" } | null;
  };
  sarFor: (args: { siteKey: string; eventStart: string; lastDetected: string }) => SarCheck;
  reviewFor: (eventId: string) => Review | null;
}

const NOT_REQUESTED: SarCheck = {
  status: "not_requested",
  coherenceDrop: null,
  preDate: null,
  postDate: null,
  detail: "Post-event SAR is requested only for events escalating toward industrial fire.",
  sample: false,
};

export function buildEvents(detections: Detection[], deps: BuildEventsDeps): SatEvent[] {
  const groups = linkDetections(detections);
  const usedIds = new Map<string, number>();
  const events: SatEvent[] = [];

  for (const dets of groups) {
    const lat = dets.reduce((s, d) => s + d.lat, 0) / dets.length;
    const lon = dets.reduce((s, d) => s + d.lon, 0) / dets.length;
    const wc = deps.worldCoverAt(lat, lon);
    const context = eventContext(dets, {
      worldCover: wc.worldCover,
      worldCoverSource: wc.source,
      spatialBackend: deps.spatialBackend,
      attributionVersion: deps.attributionVersion,
      polygonSource: deps.polygonSource,
      polygonSample: deps.polygonSample,
      facilityTypeOf: deps.facilityTypeOf,
    });
    const m = context.match;
    const siteKey = m?.facilityId ?? m?.polygonId ?? `CELL-${dets[0].lat.toFixed(2)}-${dets[0].lon.toFixed(2)}`;
    const firstDetected = dets[0].acqTime;
    const lastDetected = dets[dets.length - 1].acqTime;
    const baseId = `EVT-${siteKey}-${firstDetected.slice(0, 10).replaceAll("-", "")}`;
    const n = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, n);
    const id = n === 1 ? baseId : `${baseId}-${n}`;

    const viirs = dets.filter((d) => d.instrument === "VIIRS");
    const peak = [...(viirs.length ? viirs : dets)].sort((a, b) => b.frpMW - a.frpMW)[0];
    const currentFrp = Math.max(...perOverpassFrp(dets));
    const h = deps.historyFor({ siteKey, lat, lon, match: m, eventStart: firstDetected });
    const history = computeSiteHistory({
      siteKey,
      records: h.records,
      eventStart: firstDetected,
      currentFrpMW: currentFrp,
      mappedSince: m?.mappedSince ?? null,
      source: h.source,
      sample: h.sample,
      baselineOverride: h.baselineOverride,
    });
    const kinematics = analyseKinematics(dets);
    const review = deps.reviewFor(id);
    const heldCount = dets.filter((d) => d.gateStatus === "provisional").length;
    const base = {
      dozier: peak.dozier,
      heldByGate: heldCount === dets.length,
      partialHold: heldCount > 0 && heldCount < dets.length,
      staticSourceFlag: dets.some((d) => d.staticSourceFlag === true),
      context,
      history,
      kinematics,
      when: lastDetected,
      lat,
      lon,
      osmTags: m?.osmTags ?? {},
      review,
    };
    let sar = NOT_REQUESTED;
    let classification = classify({ ...base, sar });
    if (classification.label === "industrial_fire" || classification.label === "unmapped_industrial_candidate") {
      sar = deps.sarFor({ siteKey, eventStart: firstDetected, lastDetected });
      classification = classify({ ...base, sar });
    }
    const lc = lifecycleOf(lastDetected, deps.now);
    events.push({
      id,
      dataset: deps.dataset,
      siteKey,
      placeName: m?.name ?? wc.place ?? `Unmapped location (${lat.toFixed(3)}, ${lon.toFixed(3)})`,
      lat,
      lon,
      firstDetected,
      lastDetected,
      lifecycle: lc.lifecycle,
      quietHours: lc.quietHours,
      detections: dets,
      observationCount: dets.length,
      peakFrpMW: Math.round(Math.max(...dets.map((d) => d.frpMW)) * 10) / 10,
      dozier: peak.dozier,
      context,
      history,
      kinematics,
      classification,
      severity: severityOf(classification.label, classification.tier),
      sar,
      review,
      wildfireRoute:
        classification.label === "wildfire"
          ? { bearingDeg: kinematics.spreadBearingDeg, recipients: ["NDRF", "State Forest Department"] }
          : null,
    });
  }
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
  return events.sort((a, b) => rank[a.severity] - rank[b.severity] || Date.parse(b.lastDetected) - Date.parse(a.lastDetected));
}
