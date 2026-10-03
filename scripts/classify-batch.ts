// Batch classifier for backtests and offline analysis. Reads one JSON request on stdin, runs the SAME
// engine as the live pipeline (shared/engine.ts), writes one JSON response on stdout.
//
// Request:
//   { "rows": FirmsRow[], "now": ISO, "useSample"?: boolean,
//     "polygonsPath"?: string, "facilitiesPath"?: string, "history"?: HistoryRecord[],
//     "baselines"?: { [siteKey]: { baselineFrpMW } } }
//   useSample=true -> sample polygons, facilities, WorldCover, history and SAR (self-consistency run).
//   Otherwise polygonsPath (default data/osm/landuse.geojson) and the supplied history are used.
// Response:
//   { "events": [{ id, siteKey, placeName, lat, lon, firstDetected, lastDetected, label, tier,
//                  winningRule, fired, needsReview, detectionIds, peakFrpMW, baselineFrpMW,
//                  baselineSource, deviationX }], "rejections": [...] }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSample, sampleResources } from "../backend/sampleData.ts";
import { runEngine } from "../shared/engine.ts";
import { buildPolygonIndex } from "../shared/spatial.ts";
import type { Facility, FirmsRow, HistoryRecord, PolygonCollection } from "../shared/types.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Request {
  rows: FirmsRow[];
  now: string;
  useSample?: boolean;
  polygonsPath?: string;
  facilitiesPath?: string;
  history?: HistoryRecord[];
  baselines?: Record<string, { baselineFrpMW: number }>;
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
const now = new Date(req.now);

let run;
if (req.useSample) {
  const s = loadSample(root);
  const { res, index } = sampleResources(s, { now, baselines: req.baselines ?? null });
  run = runEngine(req.rows, res, index);
} else {
  const polygonsPath = req.polygonsPath ?? join(root, "data", "osm", "landuse.geojson");
  const polygons: PolygonCollection = existsSync(polygonsPath)
    ? JSON.parse(readFileSync(polygonsPath, "utf8"))
    : { type: "FeatureCollection", features: [] };
  const facilities: Facility[] = req.facilitiesPath && existsSync(req.facilitiesPath) ? JSON.parse(readFileSync(req.facilitiesPath, "utf8")) : [];
  run = runEngine(
    req.rows,
    {
      dataset: "live",
      now,
      spatialBackend: "memory",
      attributionVersion: 1,
      polygonSource: polygonsPath,
      polygonSample: false,
      facilities,
      landcover: null,
      history: req.history ?? [],
      historySource: "supplied history (FIRMS archive before the evaluation window)",
      historySample: false,
      baselines: req.baselines ?? null,
      sar: null,
      reviews: [],
    },
    buildPolygonIndex(polygons),
  );
}

process.stdout.write(
  JSON.stringify({
    events: run.events.map((e) => ({
      id: e.id,
      siteKey: e.siteKey,
      placeName: e.placeName,
      lat: e.lat,
      lon: e.lon,
      firstDetected: e.firstDetected,
      lastDetected: e.lastDetected,
      label: e.classification.label,
      tier: e.classification.tier,
      winningRule: e.classification.winningRule,
      fired: e.classification.fired,
      needsReview: e.classification.needsReview,
      detectionIds: e.detections.map((d) => d.id),
      peakFrpMW: e.peakFrpMW,
      baselineFrpMW: e.history.baselineFrpMW,
      baselineSource: e.history.baselineSource,
      deviationX: e.history.deviationX,
    })),
    rejections: run.gate.rejections,
  }),
);
