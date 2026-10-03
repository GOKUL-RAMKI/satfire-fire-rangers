// Seeds LIVE site history so cold-start sites can graduate to baseline rules
// (mining LONG_SMEAR, persistent routine checks). Fetches FIRMS history per bbox,
// runs it through the SAME quality gate as live data, attributes it to the live
// polygon layer, and inserts it with site keys — the keys future live events will
// look up. A baselines file alone cannot do this: cold start is computed from
// records, not from the baseline number.
//
// Run: npm run seed:history -- --bbox 86.15,23.55,86.65,23.85 --bbox 79.35,11.5,79.65,11.7
//      npm run seed:history -- --months 6 --source VIIRS_SNPP_SP --pace-ms 2000
//      npm run seed:history -- --dry-run   (no network, no key, no database writes)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../backend/config.ts";
import { loadLiveLayer } from "../backend/livePolygons.ts";
import { createPool, insertDetections, setSiteKeys } from "../backend/postgis.ts";
import { computeSiteHistory } from "../shared/history.ts";
import { runQualityGate } from "../shared/qualityGate.ts";
import { bufferFor, buildPolygonIndex, joinPoint } from "../shared/spatial.ts";
import type { Detection, FirmsRow, HistoryRecord } from "../shared/types.ts";

const DAY = 86400000;
const MAX_DAY_RANGE = 5; // FIRMS area API limit per request for dated (historical) queries

const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry-run");
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const extraBboxes = argv.flatMap((a, i) =>
  a === "--bbox" ? [argv[i + 1].split(",").map(Number) as [number, number, number, number]] : [],
);
const areas: { name: string; bbox: [number, number, number, number] }[] = extraBboxes.length
  ? extraBboxes.map((bbox, i) => ({ name: `bbox-${i + 1}`, bbox }))
  : [
      { name: "jharia", bbox: [86.15, 23.55, 86.65, 23.85] },
      { name: "neyveli", bbox: [79.35, 11.5, 79.65, 11.7] },
    ];
const months = Number(opt("months", "12"));
const source = opt("source", "VIIRS_SNPP_SP");
const paceMs = Number(opt("pace-ms", isDryRun ? "0" : "2000"));

function readEnvLocal(): Record<string, string> {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const mapKey = isDryRun ? "DRYRUNKEY" : readEnvLocal().FIRMS_MAP_KEY || process.env.FIRMS_MAP_KEY || "";
const redact = (s: string): string => (mapKey ? s.split(mapKey).join("***") : s);
if (!mapKey) {
  console.error("FIRMS_MAP_KEY is not set (.env.local or environment). Use --dry-run to exercise the code path.");
  process.exit(2);
}

const cfg = loadConfig();
const pool = isDryRun ? null : createPool(cfg.databaseUrl || "");
if (!isDryRun && !cfg.databaseUrl) {
  console.error("DATABASE_URL is not set. Seeded history lives in firms_detections (PostGIS).");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const first = addDays(today, -Math.round(months * 30.44));
const last = addDays(today, -1);

function chunkList(): { date: string; days: number }[] {
  const out: { date: string; days: number }[] = [];
  for (let d = first; d <= last; d = addDays(d, MAX_DAY_RANGE)) {
    const end = addDays(d, MAX_DAY_RANGE - 1) > last ? last : addDays(d, MAX_DAY_RANGE - 1);
    out.push({ date: d, days: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / DAY) + 1 });
  }
  return out;
}

function parseCsv(text: string): FirmsRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  if (!header.includes("latitude") || !header.includes("acq_date")) throw new Error(`unexpected FIRMS response: ${lines[0].slice(0, 120)}`);
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    row.source = source;
    return row as FirmsRow;
  });
}

/** Deterministic cool-smoulder history for --dry-run: active every other day. */
function fakeCsv(bbox: [number, number, number, number], date: string, days: number): string {
  const header = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type";
  const lat = (bbox[1] + bbox[3]) / 2;
  const lon = (bbox[0] + bbox[2]) / 2;
  const lines = [header];
  for (let k = 0; k < days; k += 2) {
    const d = addDays(date, k);
    if (d > last) break;
    lines.push(`${lat.toFixed(5)},${lon.toFixed(5)},318.40,0.42,0.38,${d},0812,N,VIIRS,n,2,303.10,4.20,D,0`);
  }
  return lines.join("\n") + "\n";
}

async function fetchChunk(bbox: [number, number, number, number], date: string, days: number): Promise<FirmsRow[]> {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/${bbox.join(",")}/${days}/${date}`;
  if (isDryRun) return parseCsv(fakeCsv(bbox, date, days));
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return parseCsv(text);
    } catch (err) {
      lastErr = redact(String(err instanceof Error ? err.message : err));
      console.warn(`  retry ${attempt}/4 ${bbox.join(",")} ${date}+${days}d: ${lastErr}`);
      await sleep(5000 * attempt);
    }
  }
  throw new Error(`giving up on ${bbox.join(",")} ${date}+${days}d: ${lastErr}`);
}

/** Same site-key scheme as event assembly: facility/polygon id, else a CELL grid key. */
function siteKeyFor(d: Detection): string {
  const m = d.match;
  return m?.facilityId ?? m?.polygonId ?? `CELL-${d.lat.toFixed(2)}-${d.lon.toFixed(2)}`;
}

const live = loadLiveLayer(cfg.root);
const index = buildPolygonIndex(live.polygons, 1);
console.log(`seed: live layer "${live.source}" (${live.polygons.features.length} polygons)`);

const now = new Date();
const allRecords: HistoryRecord[] = [];
let totalRows = 0;
let totalAccepted = 0;
let totalInserted = 0;
const rejectReasons = new Map<string, number>();

for (const { name, bbox } of areas) {
  console.log(`seed: ${name} [${bbox.join(",")}] ${first}..${last} (${source})`);
  const seen = new Set<string>();
  const rows: FirmsRow[] = [];
  const parts = chunkList();
  for (const [i, c] of parts.entries()) {
    for (const r of await fetchChunk(bbox, c.date, c.days)) {
      if ((r.acq_date ?? "") < first || (r.acq_date ?? "") > last) continue;
      const k = `${r.latitude}|${r.longitude}|${r.acq_date}|${r.acq_time}|${r.satellite}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
    }
    if (paceMs && i < parts.length - 1) await sleep(paceMs);
  }
  totalRows += rows.length;

  const gate = runQualityGate(rows, "live", now);
  totalAccepted += gate.detections.length;
  for (const r of gate.rejections) rejectReasons.set(r.reason, (rejectReasons.get(r.reason) ?? 0) + 1);
  for (const d of gate.detections) {
    d.bufferM = bufferFor(d);
    const hits = joinPoint(index, d.lat, d.lon, d.bufferM);
    d.match = hits[0] ?? null;
    d.runnerUps = hits.slice(1);
  }
  const matched = gate.detections.filter((d) => d.match).length;
  console.log(`  rows=${rows.length} accepted=${gate.detections.length} matched=${matched} rejected=${gate.rejections.length}`);

  if (pool) {
    totalInserted += await insertDetections(pool, gate.detections);
    await setSiteKeys(
      pool,
      gate.detections.map((d) => ({ detKey: d.id, siteKey: siteKeyFor(d) })),
    );
  }
  for (const d of gate.detections) {
    allRecords.push({ siteKey: siteKeyFor(d), acqTime: d.acqTime, lat: d.lat, lon: d.lon, frpMW: d.frpMW });
  }
}

console.log(`seed: total rows=${totalRows} accepted=${totalAccepted} inserted=${totalInserted}${isDryRun ? " (dry-run: nothing written)" : ""}`);
console.log(`seed: rejections: ${[...rejectReasons.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);

// Success gate: which seeded sites actually reach history patterns that unlock rules?
const bySite = new Map<string, HistoryRecord[]>();
for (const r of allRecords) {
  const list = bySite.get(r.siteKey);
  if (list) list.push(r);
  else bySite.set(r.siteKey, [r]);
}
const table = [...bySite.entries()]
  .map(([siteKey, recs]) => ({
    siteKey,
    n: recs.length,
    h: computeSiteHistory({ siteKey, records: recs, eventStart: now.toISOString(), currentFrpMW: recs[recs.length - 1].frpMW, mappedSince: null, source: "seed-history", sample: false }),
  }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 15);
console.log("seed: top sites by records (pattern / activeDays / spanDays / coldStart):");
for (const t of table) console.log(`  ${t.siteKey} n=${t.n} ${t.h.pattern} days=${t.h.activeDays} span=${t.h.spanDays} cold=${t.h.coldStart}`);

await pool?.end();
