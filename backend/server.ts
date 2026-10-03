// SATFIRE v3 backend: HTTP API (docs/api.md) + static dashboard (after `npm run build`).

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { COOKIE, createAuth, readCookie } from "./auth.ts";
import { loadConfig, type Config } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { createPhraser } from "./llm.ts";
import { osmContext } from "./osm.ts";
import { createPipeline } from "./pipeline.ts";
import { createPool } from "./postgis.ts";
import { createScheduler } from "./scheduler.ts";
import { createFileStore, createPgStore, type Store } from "./store.ts";
import { windAt } from "./wind.ts";
import type { Dataset, SatEvent } from "../shared/types.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Keep list responses small on national-scale live feeds; the detail route has every detection. */
const listView = (e: SatEvent): SatEvent => (e.detections.length > 25 ? { ...e, detections: e.detections.slice(0, 25) } : e);

export async function startServer(overrides: Partial<Config> = {}) {
  const cfg = loadConfig(overrides);
  let store: Store;
  let pool = null;
  if (cfg.databaseUrl) {
    try {
      pool = createPool(cfg.databaseUrl);
      await pool.query("SELECT 1");
      store = createPgStore(pool);
      console.log("SATFIRE: PostGIS connected (spatial join + alert store)");
    } catch (e) {
      console.warn(`SATFIRE: DATABASE_URL set but PostGIS unreachable (${e instanceof Error ? e.message : e}); using in-memory join + file store`);
      await pool?.end().catch(() => undefined);
      pool = null;
      store = createFileStore(cfg.runtimeDir);
    }
  } else store = createFileStore(cfg.runtimeDir);

  const phraser = createPhraser({
    key: cfg.geminiKey,
    model: cfg.geminiModel,
    enabled: cfg.llmEnabled,
    timeoutMs: cfg.llmTimeoutMs,
    maxPerHour: cfg.llmMaxPerHour,
    maxPerDay: cfg.llmMaxPerDay,
    dailyBudgetUsd: cfg.llmDailyBudgetUsd,
    priceInPerMTok: cfg.llmPriceInPerMTok,
    priceOutPerMTok: cfg.llmPriceOutPerMTok,
  });
  const dispatcher = createDispatcher({ store, url: cfg.webhookUrl, maxAttempts: cfg.dispatchMaxAttempts, backoffMs: cfg.dispatchBackoffMs });
  const pipeline = createPipeline({ cfg, store, pool, phraser, dispatcher });
  const auth = createAuth({ user: cfg.dashboardUser, password: cfg.dashboardPassword, secret: cfg.sessionSecret, ttlHours: cfg.sessionTtlHours, secure: cfg.secureCookies });
  const scheduler =
    cfg.firmsKey && cfg.schedulerEnabled
      ? createScheduler({ windowsUtc: cfg.pollWindowsUtc, inMin: cfg.pollInWindowMin, outMin: cfg.pollOutWindowMin, run: () => pipeline.run("live", { refetch: true }) })
      : null;

  const defaultDataset: Dataset = cfg.firmsKey ? "live" : "sample";
  const datasetOf = (v: unknown): Dataset => {
    if (v === undefined || v === null || v === "") return defaultDataset;
    if (v === "live" || v === "sample") return v;
    throw new HttpError(400, "dataset must be live or sample");
  };
  const distDir = join(cfg.root, "dist");

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const ip = req.socket.remoteAddress ?? "unknown";
    try {
      if (!path.startsWith("/api/")) return serveStatic(path, res);

      if (path === "/api/health" && req.method === "GET") return send(res, 200, { ok: true, version: "3.0.0" });
      if (path === "/api/auth/login" && req.method === "POST") {
        if (!auth.allowAttempt(ip)) return send(res, 429, { error: "Too many failed logins. Try again in 10 minutes." });
        const body = await readBody(req);
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!auth.verifyPassword(username, password)) {
          auth.recordFailure(ip);
          return send(res, 401, { error: "Invalid username or password" });
        }
        auth.recordSuccess(ip);
        return send(res, 200, { user: username }, { "Set-Cookie": auth.cookie(auth.issue(username), cfg.sessionTtlHours * 3600) });
      }
      if (path === "/api/auth/logout" && req.method === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie() });

      // everything below requires a session
      const user = auth.verify(readCookie(req.headers.cookie, COOKIE));
      if (!user) return send(res, 401, { error: "unauthorized" });
      if (path === "/api/auth/me") return send(res, 200, { user });

      const q = url.searchParams;
      if (req.method === "GET") {
        if (path === "/api/status") {
          const dataset = datasetOf(q.get("dataset"));
          await pipeline.events(dataset);
          const s = pipeline.status(dataset);
          if (scheduler) s.scheduler = { enabled: true, ...scheduler.status() };
          return send(res, 200, s);
        }
        if (path === "/api/events") return send(res, 200, (await pipeline.events(datasetOf(q.get("dataset")))).map(listView));
        const w = path.match(/^\/api\/events\/([^/]+)\/wind$/);
        if (w) {
          const dataset = datasetOf(q.get("dataset"));
          const ev = (await pipeline.events(dataset)).find((e) => e.id === decodeURIComponent(w[1]));
          if (!ev) return send(res, 404, { error: "event not found" });
          // indicative wedge only for confirmed (Code Red) events
          if (ev.classification.tier !== "code_red") return send(res, 200, { available: false, note: "Wedge is shown only for Code Red events." });
          return send(res, 200, await windAt(ev.lat, ev.lon, ev.lastDetected, dataset === "live"));
        }
        const m = path.match(/^\/api\/events\/([^/]+)$/);
        if (m) {
          const ev = (await pipeline.events(datasetOf(q.get("dataset")))).find((e) => e.id === decodeURIComponent(m[1]));
          return ev ? send(res, 200, ev) : send(res, 404, { error: "event not found" });
        }
        if (path === "/api/alerts") {
          const d = q.get("dataset");
          return send(res, 200, await store.listAlerts(d ? datasetOf(d) : undefined));
        }
        if (path === "/api/facilities") return send(res, 200, pipeline.facilities(datasetOf(q.get("dataset"))));
        if (path === "/api/polygons") return send(res, 200, pipeline.polygons(datasetOf(q.get("dataset"))));
        if (path === "/api/cpcb") return send(res, 200, JSON.parse(readFileSync(join(cfg.root, "data", "sample", "cpcb_categories.json"), "utf8")));
        if (path === "/api/backtest") {
          const p = join(cfg.root, "data", "derived", "backtest_report.json");
          return existsSync(p) ? send(res, 200, JSON.parse(readFileSync(p, "utf8"))) : send(res, 404, { error: "no backtest report generated (npm run backtest)" });
        }
        if (path === "/api/osm/context") {
          const lat = Number(q.get("lat"));
          const lon = Number(q.get("lon"));
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, "valid lat and lon are required");
          return send(res, 200, await osmContext(lat, lon));
        }
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const review = path.match(/^\/api\/events\/([^/]+)\/review$/);
        if (review) {
          const decision = body.decision;
          if (decision !== "confirm" && decision !== "reject") throw new HttpError(400, "decision must be confirm or reject");
          const r = await pipeline.review(datasetOf(body.dataset), decodeURIComponent(review[1]), decision, typeof body.note === "string" ? body.note : "", user);
          return r ? send(res, 200, r) : send(res, 404, { error: "event not found" });
        }
        const sitrep = path.match(/^\/api\/events\/([^/]+)\/sitrep$/);
        if (sitrep) {
          const r = await pipeline.sitrep(datasetOf(body.dataset), decodeURIComponent(sitrep[1]));
          return r ? send(res, 200, r) : send(res, 404, { error: "event not found" });
        }
        if (path === "/api/pipeline/refresh") {
          const dataset = datasetOf(body.dataset);
          await pipeline.run(dataset, { refetch: true });
          return send(res, 200, pipeline.status(dataset));
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: "internal error" });
    }
  });

  function serveStatic(path: string, res: ServerResponse) {
    if (!existsSync(distDir)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Dashboard not built. Run `npm run dev` (development) or `npm run build` then `npm start`.");
    }
    const safe = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, safe);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : cfg.port;
  console.log(`SATFIRE API listening on http://localhost:${port}`);
  if (cfg.passwordGenerated)
    console.log(`SATFIRE: no DASHBOARD_PASSWORD set — generated one for this run. Login: ${cfg.dashboardUser} / ${cfg.dashboardPassword}`);
  if (!cfg.firmsKey) console.log("SATFIRE: FIRMS_MAP_KEY not set — live dataset disabled, SAMPLE dataset served (labelled).");

  const resumed = await dispatcher.resumePending();
  if (resumed) console.log(`SATFIRE: resumed ${resumed} pending dispatch(es)`);
  void pipeline.run("sample").catch((e) => console.error("sample pipeline failed", e));
  scheduler?.start();

  return {
    port,
    cfg,
    pipeline,
    store,
    dispatcher,
    async close() {
      scheduler?.stop();
      dispatcher.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await pool?.end();
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() as string)) {
  startServer().catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.log("SATFIRE API is already running on this port; reusing it.");
      process.exit(0);
    }
    console.error("SATFIRE API failed to start:", e);
    process.exit(1);
  });
}
