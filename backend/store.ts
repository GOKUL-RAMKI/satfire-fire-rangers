// Persistence for alerts (DB-first dispatch), operator reviews (gold set), live site history and the
// ingest log. PostGIS when DATABASE_URL is configured, otherwise an append-safe JSON file store in
// data/runtime/ (gitignored). The status endpoint reports which one is active.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { AlertRecord, Dataset, GateRejection, HistoryRecord, Review } from "../shared/types.ts";

export interface Store {
  kind: "postgis" | "file";
  /** Idempotent on (dataset, eventId, kind): returns the existing record if already present. */
  insertAlert(a: AlertRecord): Promise<{ inserted: boolean; alert: AlertRecord }>;
  updateAlert(a: AlertRecord): Promise<void>;
  listAlerts(dataset?: Dataset): Promise<AlertRecord[]>;
  pendingDispatches(): Promise<AlertRecord[]>;
  saveReview(r: Review): Promise<void>;
  listReviews(): Promise<Review[]>;
  appendHistory(dataset: Dataset, records: HistoryRecord[]): Promise<void>;
  history(dataset: Dataset): Promise<HistoryRecord[]>;
  logRejections(dataset: Dataset, runAt: string, rejections: GateRejection[]): Promise<void>;
}

export const alertId = (dataset: Dataset, eventId: string, kind: string) => `${dataset}:${eventId}:${kind}`;

// ---------------------------------------------------------------- file store

interface FileState {
  alerts: AlertRecord[];
  reviews: Review[];
  history: Record<Dataset, HistoryRecord[]>;
  ingestLog: { dataset: Dataset; runAt: string; rejection: GateRejection }[];
}

export function createFileStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "store.json");
  let state: FileState;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as FileState;
  } catch {
    state = { alerts: [], reviews: [], history: { live: [], sample: [] }, ingestLog: [] };
  }
  // serialise writes; write to a temp file then rename so a crash never leaves a torn file
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(() => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path);
    });
    return chain;
  };
  const histKey = (r: HistoryRecord) => `${r.siteKey}|${r.acqTime}|${r.lat}|${r.lon}`;

  return {
    kind: "file",
    async insertAlert(a) {
      const existing = state.alerts.find((x) => x.id === a.id);
      if (existing) return { inserted: false, alert: existing };
      state.alerts.push(a);
      await persist();
      return { inserted: true, alert: a };
    },
    async updateAlert(a) {
      const i = state.alerts.findIndex((x) => x.id === a.id);
      if (i >= 0) state.alerts[i] = a;
      await persist();
    },
    async listAlerts(dataset) {
      return state.alerts.filter((a) => !dataset || a.dataset === dataset).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async pendingDispatches() {
      return state.alerts.filter((a) => a.dispatch.status === "pending");
    },
    async saveReview(r) {
      state.reviews = state.reviews.filter((x) => !(x.dataset === r.dataset && x.eventId === r.eventId));
      state.reviews.push(r);
      await persist();
    },
    async listReviews() {
      return state.reviews;
    },
    async appendHistory(dataset, records) {
      const seen = new Set(state.history[dataset].map(histKey));
      for (const r of records) if (!seen.has(histKey(r))) state.history[dataset].push(r);
      await persist();
    },
    async history(dataset) {
      return state.history[dataset];
    },
    async logRejections(dataset, runAt, rejections) {
      state.ingestLog.push(...rejections.map((rejection) => ({ dataset, runAt, rejection })));
      state.ingestLog = state.ingestLog.slice(-5000);
      await persist();
    },
  };
}

// ---------------------------------------------------------------- PostGIS store

export function createPgStore(pool: pg.Pool): Store {
  const rowToAlert = (r: { record: AlertRecord }) => r.record;
  return {
    kind: "postgis",
    async insertAlert(a) {
      const res = await pool.query(
        `INSERT INTO alerts (id, dataset, event_id, kind, created_at, record, dispatch_status, attempts, next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dataset, event_id, kind) DO NOTHING RETURNING id`,
        [a.id, a.dataset, a.eventId, a.kind, a.createdAt, a, a.dispatch.status, a.dispatch.attempts, a.dispatch.nextAttemptAt],
      );
      if (res.rowCount) return { inserted: true, alert: a };
      const existing = await pool.query(`SELECT record FROM alerts WHERE dataset=$1 AND event_id=$2 AND kind=$3`, [a.dataset, a.eventId, a.kind]);
      return { inserted: false, alert: rowToAlert(existing.rows[0]) };
    },
    async updateAlert(a) {
      await pool.query(`UPDATE alerts SET record=$2, dispatch_status=$3, attempts=$4, next_attempt_at=$5 WHERE id=$1`, [
        a.id,
        a,
        a.dispatch.status,
        a.dispatch.attempts,
        a.dispatch.nextAttemptAt,
      ]);
    },
    async listAlerts(dataset) {
      const res = dataset
        ? await pool.query(`SELECT record FROM alerts WHERE dataset=$1 ORDER BY created_at DESC`, [dataset])
        : await pool.query(`SELECT record FROM alerts ORDER BY created_at DESC`);
      return res.rows.map(rowToAlert);
    },
    async pendingDispatches() {
      const res = await pool.query(`SELECT record FROM alerts WHERE dispatch_status='pending'`);
      return res.rows.map(rowToAlert);
    },
    async saveReview(r) {
      await pool.query(
        `INSERT INTO reviews (dataset, event_id, decision, label, note, by_user, at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (dataset, event_id) DO UPDATE SET decision=EXCLUDED.decision, label=EXCLUDED.label, note=EXCLUDED.note, by_user=EXCLUDED.by_user, at=EXCLUDED.at`,
        [r.dataset, r.eventId, r.decision, r.label, r.note, r.by, r.at],
      );
    },
    async listReviews() {
      const res = await pool.query(`SELECT dataset, event_id, decision, label, note, by_user, at FROM reviews`);
      return res.rows.map((x) => ({
        dataset: x.dataset,
        eventId: x.event_id,
        decision: x.decision,
        label: x.label,
        note: x.note,
        by: x.by_user,
        at: new Date(x.at).toISOString(),
      }));
    },
    async appendHistory() {
      // History lives in firms_detections.site_key, set by the PostGIS spatial layer after event assembly.
    },
    async history(dataset) {
      const res = await pool.query(
        `SELECT site_key, acq_time, lat, lon, frp_mw FROM firms_detections WHERE dataset=$1 AND site_key IS NOT NULL`,
        [dataset],
      );
      return res.rows.map((r) => ({
        siteKey: r.site_key,
        acqTime: new Date(r.acq_time).toISOString().replace(".000Z", "Z"),
        lat: r.lat,
        lon: r.lon,
        frpMW: Number(r.frp_mw),
      }));
    },
    async logRejections(dataset, runAt, rejections) {
      for (const r of rejections)
        await pool.query(`INSERT INTO ingest_log (dataset, run_at, row_index, reason, detail, source) VALUES ($1,$2,$3,$4,$5,$6)`, [
          dataset,
          runAt,
          r.rowIndex,
          r.reason,
          r.detail,
          r.source,
        ]);
    },
  };
}
