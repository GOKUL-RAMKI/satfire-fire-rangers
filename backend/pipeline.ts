// Pipeline orchestration per dataset (live FIRMS or SAMPLE):
//   FIRMS rows -> quality gate (+ Dozier at ingestion) -> spatial join (PostGIS or in-memory)
//   -> events (history, kinematics, classification) -> alerts written to the store FIRST
//   -> SITREP (template, LLM phrasing optional) -> webhook dispatch with retry.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { assembleEvents, attribute, type EngineResources } from "../shared/engine.ts";
import { CLASS_LABELS, TIER_LABELS } from "../shared/labels.ts";
import { runQualityGate } from "../shared/qualityGate.ts";
import { generateSitrep } from "../shared/sitrep.ts";
import { bufferFor, buildPolygonIndex, joinPoint } from "../shared/spatial.ts";
import type {
  AlertKind,
  AlertRecord,
  Dataset,
  Facility,
  FirmsRow,
  GateRejection,
  HistoryRecord,
  PipelineRunStats,
  PipelineStatus,
  PolygonCollection,
  Review,
  SatEvent,
} from "../shared/types.ts";
import type { Config } from "./config.ts";
import type { Dispatcher } from "./dispatch.ts";
import { fetchFirms } from "./firms.ts";
import type { Phraser } from "./llm.ts";
import { attributionVersion, insertDetections, joinDetections, loadPolygons, polygonCount, setSiteKeys } from "./postgis.ts";
import { loadSample, type SampleBundle } from "./sampleData.ts";
import { alertId, type Store } from "./store.ts";

interface DatasetState {
  rows: FirmsRow[];
  events: SatEvent[];
  rejections: GateRejection[];
  stats: PipelineRunStats | null;
  referenceNow: string;
}

const EMPTY_FC: PolygonCollection = { type: "FeatureCollection", features: [] };

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function createPipeline(deps: {
  cfg: Config;
  store: Store;
  pool: pg.Pool | null;
  phraser: Phraser;
  dispatcher: Dispatcher;
  log?: (m: string) => void;
}) {
  const { cfg, store, pool, phraser, dispatcher } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const sample: SampleBundle = loadSample(cfg.root);
  const states = new Map<Dataset, DatasetState>();
  let lastSuccessfulPull: string | null = null;
  let running: Promise<void> | null = null;

  const livePolygonsPath = join(cfg.root, "data", "osm", "landuse.geojson");
  const polygonsFor = (dataset: Dataset): { fc: PolygonCollection; source: string; sample: boolean; refreshedAt: string | null } => {
    if (dataset === "sample")
      return { fc: sample.polygons, source: "SAMPLE polygons (data/sample/landuse_polygons.geojson)", sample: true, refreshedAt: sample.polygons.features[0]?.properties.refreshedAt ?? null };
    const fc = readJson<PolygonCollection>(livePolygonsPath, EMPTY_FC);
    return {
      fc,
      source: fc.features.length ? "OpenStreetMap bulk load (data/osm/landuse.geojson)" : "No live polygons loaded (run npm run osm:load)",
      sample: false,
      refreshedAt: fc.features.map((f) => f.properties.refreshedAt).sort().at(-1) ?? null,
    };
  };
  const facilitiesFor = (dataset: Dataset): Facility[] =>
    dataset === "sample" ? sample.facilities : readJson<Facility[]>(join(cfg.root, "data", "osm", "facilities.json"), []);
  const baselinesFor = (dataset: Dataset): Record<string, { baselineFrpMW: number }> | null => {
    const file = readJson<{ sample?: boolean; baselines?: Record<string, { baselineFrpMW: number }> } | null>(
      join(cfg.root, "data", "derived", dataset === "sample" ? "site_baselines.json" : "site_baselines_live.json"),
      null,
    );
    if (!file?.baselines) return null;
    if (dataset === "sample" && file.sample !== true) return null;
    return file.baselines;
  };

  async function ensurePolygonsInDb(dataset: Dataset) {
    if (!pool) return;
    const fc = polygonsFor(dataset).fc;
    if (fc.features.length && (await polygonCount(pool, dataset)) !== fc.features.length) {
      const r = await loadPolygons(pool, dataset, fc);
      log(`postgis: bulk-loaded ${r.loaded} ${dataset} polygons (attribution v${r.version}, ${r.reattributed} detections re-attributed)`);
    }
  }

  async function initialAlertStatus(dataset: Dataset, kind: AlertKind): Promise<AlertRecord["dispatch"]["status"]> {
    if (kind === "watch") return "not_dispatched";
    if (dataset === "sample" && !cfg.dispatchSampleAlerts) return "suppressed_sample";
    if (!cfg.webhookUrl) return "not_configured";
    return "pending";
  }

  async function ensureAlerts(dataset: Dataset, events: SatEvent[]): Promise<void> {
    for (const e of events) {
      const kinds: AlertKind[] = [];
      if (e.classification.tier) kinds.push(e.classification.tier);
      if (e.classification.label === "wildfire" && e.lifecycle !== "extinguished") kinds.push("wildfire_route");
      for (const kind of kinds) {
        const template = generateSitrep(e);
        const record: AlertRecord = {
          id: alertId(dataset, e.id, kind),
          dataset,
          eventId: e.id,
          kind,
          label: e.classification.label,
          placeName: e.placeName,
          lat: e.lat,
          lon: e.lon,
          createdAt: new Date().toISOString(),
          summary:
            kind === "wildfire_route"
              ? `Wildfire — route coordinates to NDRF / State Forest Department; spread ${e.kinematics.spreadBearingDeg === null ? "direction not yet resolved (growing in place)" : `toward ${e.kinematics.spreadBearingDeg}°`}; evidence score ${e.classification.confidence.total}/100`
              : `${CLASS_LABELS[e.classification.label]} — ${TIER_LABELS[kind as "watch" | "alert" | "code_red"]}; evidence score ${e.classification.confidence.total}/100; ${e.classification.tierReason}`,
          sitrep: { text: template, phrasing: "template", note: "Template written with the alert record." },
          dispatch: { status: await initialAlertStatus(dataset, kind), attempts: 0, lastError: null, lastAttemptAt: null, nextAttemptAt: null, sentAt: null },
        };
        // DB-first: the record exists before any phrasing or webhook call
        const { inserted, alert } = await store.insertAlert(record);
        if (!inserted) continue;
        if (kind === "alert" || kind === "code_red") {
          const phrased = await phraser.phrase(template, [e.context.match?.name ?? "", e.id]);
          alert.sitrep = phrased;
          await store.updateAlert(alert);
        }
        dispatcher.enqueue(alert);
        log(`alert: ${alert.id} recorded (${alert.dispatch.status})`);
      }
    }
  }

  async function assemble(dataset: Dataset, rows: FirmsRow[], firmsError: string | null, started: number): Promise<void> {
    const now = dataset === "sample" ? new Date(sample.referenceNow) : new Date();
    const gate = runQualityGate(rows, dataset, now);
    const poly = polygonsFor(dataset);
    let version = 1;
    let backend: "postgis" | "memory" = "memory";
    if (pool) {
      await ensurePolygonsInDb(dataset);
      version = await attributionVersion(pool);
      for (const d of gate.detections) d.bufferM = bufferFor(d);
      await insertDetections(pool, gate.detections);
      const matches = await joinDetections(pool, gate.detections.map((d) => d.id), version);
      attribute(gate.detections, (d) => matches.get(d.id) ?? []);
      backend = "postgis";
    } else {
      const index = buildPolygonIndex(poly.fc, version);
      attribute(gate.detections, (d) => joinPoint(index, d.lat, d.lon, d.bufferM));
    }

    const reviews: Review[] = await store.listReviews();
    const history: HistoryRecord[] = dataset === "sample" ? sample.history : await store.history("live");
    const res: EngineResources = {
      dataset,
      now,
      spatialBackend: backend,
      attributionVersion: version,
      polygonSource: poly.source,
      polygonSample: poly.sample,
      facilities: facilitiesFor(dataset),
      landcover: dataset === "sample" ? sample.landcover : null,
      history,
      historySource: dataset === "sample" ? "SAMPLE site history (data/sample/site_history.json)" : `Stored live detections (${store.kind})`,
      historySample: dataset === "sample",
      baselines: baselinesFor(dataset),
      sar: dataset === "sample" ? sample.sar : null,
      reviews,
    };
    const events = assembleEvents(gate.detections, res);

    if (dataset === "live") {
      const records = events.flatMap((e) => e.detections.map((d) => ({ siteKey: e.siteKey, acqTime: d.acqTime, lat: d.lat, lon: d.lon, frpMW: d.frpMW })));
      if (pool) await setSiteKeys(pool, events.flatMap((e) => e.detections.map((d) => ({ detKey: d.id, siteKey: e.siteKey }))));
      else await store.appendHistory("live", records);
    }
    const ranAt = new Date().toISOString();
    if (gate.rejections.length) await store.logRejections(dataset, ranAt, gate.rejections);
    await ensureAlerts(dataset, events);

    states.set(dataset, {
      rows,
      events,
      rejections: gate.rejections,
      referenceNow: now.toISOString(),
      stats: {
        at: ranAt,
        durationMs: Date.now() - started,
        rows: rows.length,
        accepted: gate.detections.length,
        rejected: gate.rejections.length,
        provisional: gate.detections.filter((d) => d.gateStatus === "provisional").length,
        merged: gate.merged,
        duplicates: gate.duplicates,
        events: events.length,
        firmsError,
      },
    });
  }

  async function run(dataset: Dataset, opts: { refetch?: boolean } = {}): Promise<void> {
    const started = Date.now();
    if (dataset === "sample") return assemble("sample", sample.rows, null, started);
    if (!cfg.firmsKey) {
      return void states.set("live", { rows: [], events: [], rejections: [], referenceNow: new Date().toISOString(), stats: { at: new Date().toISOString(), durationMs: 0, rows: 0, accepted: 0, rejected: 0, provisional: 0, merged: 0, duplicates: 0, events: 0, firmsError: "FIRMS_MAP_KEY not configured" } });
    }
    const prev = states.get("live");
    let rows = prev?.rows ?? [];
    let firmsError: string | null = null;
    if (opts.refetch !== false || !prev) {
      const r = await fetchFirms({ key: cfg.firmsKey, sources: cfg.firmsSources, bbox: cfg.firmsBbox, dayRange: cfg.firmsDayRange });
      firmsError = r.errors.length ? r.errors.join("; ") : null;
      if (r.rows.length || !r.errors.length) {
        rows = r.rows;
        lastSuccessfulPull = new Date().toISOString();
      }
      log(`firms: ${r.rows.length} rows from ${cfg.firmsSources.length} sources${firmsError ? ` (errors: ${firmsError})` : ""}`);
    }
    await assemble("live", rows, firmsError, started);
  }

  /** Serialise runs so the scheduler, refreshes and reviews never interleave. */
  function queued(fn: () => Promise<void>): Promise<void> {
    const next = (running ?? Promise.resolve()).then(fn, fn);
    running = next.catch(() => undefined);
    return next;
  }

  async function events(dataset: Dataset): Promise<SatEvent[]> {
    if (!states.has(dataset)) await queued(() => run(dataset, { refetch: true }));
    return states.get(dataset)?.events ?? [];
  }

  function status(dataset: Dataset): PipelineStatus {
    const st = states.get(dataset);
    const poly = polygonsFor(dataset);
    const ageMinutes = lastSuccessfulPull ? Math.round((Date.now() - Date.parse(lastSuccessfulPull)) / 60000) : null;
    let warning: string | null = null;
    if (cfg.firmsKey) {
      if (!lastSuccessfulPull && states.get("live")?.stats)
        warning = `No successful FIRMS pull yet${states.get("live")?.stats?.firmsError ? `: ${states.get("live")?.stats?.firmsError}` : ""}`;
      else if (ageMinutes !== null && ageMinutes > cfg.heartbeatMaxAgeMin)
        warning = `Last successful FIRMS pull was ${ageMinutes} min ago (limit ${cfg.heartbeatMaxAgeMin} min) — the poller may have stopped.`;
    }
    return {
      dataset,
      sample: dataset === "sample",
      firmsConfigured: Boolean(cfg.firmsKey),
      llm: phraser.stats(),
      webhookConfigured: Boolean(cfg.webhookUrl),
      spatialBackend: pool ? "postgis" : "memory",
      store: store.kind,
      polygons: { count: poly.fc.features.length, source: poly.source, sample: poly.sample, refreshedAt: poly.refreshedAt },
      worldCover: dataset === "sample" ? "sample" : "unavailable",
      history: {
        source: dataset === "sample" ? "SAMPLE site history" : `Stored live detections (${store.kind})`,
        baselines: baselinesFor(dataset) ? "IsolationForest inlier median (data/derived)" : "Median per-overpass FRP (computed)",
      },
      sar: dataset === "sample" ? "sample" : "not_available",
      lastRun: st?.stats ?? null,
      rejections: (st?.rejections ?? []).slice(0, 200),
      heartbeat: { lastSuccessfulPull, ageMinutes, warning },
      scheduler: { enabled: false, windowsUtc: cfg.pollWindowsUtc, inWindow: false, nextRunAt: null },
      referenceNow: st?.referenceNow ?? new Date().toISOString(),
    };
  }

  return {
    run: (dataset: Dataset, opts: { refetch?: boolean } = {}) => queued(() => run(dataset, opts)),
    events,
    status,
    polygons: (dataset: Dataset) => polygonsFor(dataset).fc,
    facilities: facilitiesFor,
    async review(dataset: Dataset, eventId: string, decision: "confirm" | "reject", note: string, by: string) {
      const ev = (await events(dataset)).find((e) => e.id === eventId);
      if (!ev) return null;
      await store.saveReview({ dataset, eventId, decision, label: ev.classification.label, note: note.slice(0, 500), by, at: new Date().toISOString() });
      await queued(() => run(dataset, { refetch: false }));
      const updated = states.get(dataset)?.events.find((e) => e.id === eventId) ?? null;
      const alerts = await store.listAlerts(dataset);
      const alert = updated?.classification.tier ? alerts.find((a) => a.id === alertId(dataset, eventId, updated.classification.tier as AlertKind)) ?? null : null;
      return { event: updated, alert };
    },
    async sitrep(dataset: Dataset, eventId: string) {
      const ev = (await events(dataset)).find((e) => e.id === eventId);
      if (!ev) return null;
      return phraser.phrase(generateSitrep(ev), [ev.context.match?.name ?? "", ev.id]);
    },
    heartbeat: () => lastSuccessfulPull,
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;
