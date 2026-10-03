// Fetches historical FIRMS rows for the REAL backtest (validation plan §7). For every window in the
// backtest spec (default analytics/backtest_real.json) it pulls the FIRMS area API
//   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}/{YYYY-MM-DD}
// in <= 10-day chunks (the API maximum), paced politely, and writes
//   data/backtest/<window>.json          FirmsRow[] inside the window (a `source` field is added)
//   data/backtest/<window>_history.json  HistoryRecord[] for the 12 months BEFORE the window, siteKey =
//                                        window name (no leakage: nothing on or after the window start)
//   data/backtest/manifest.json          what was fetched, when, from which source (never the key)
// analytics/backtest.py re-keys the history to the engine's per-event site keys before scoring.
//
// The key is read from FIRMS_MAP_KEY in .env.local (project root) or the environment. It is never
// printed, logged or written: every message is passed through redact().
//
// Run:  npm run firms:history -- [--spec analytics/backtest_real.json] [--only a,b] [--source VIIRS_SNPP_SP]
//                                [--history-days 365] [--pace-ms 2000] [--force] [--no-history]
//       npm run firms:history -- --dry-run     (no network, no key: fake CSV, writes to the OS temp dir)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAcqTime } from "../shared/qualityGate.ts";
import type { FirmsRow, HistoryRecord } from "../shared/types.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAY = 86400000;
const MAX_DAY_RANGE = 10; // FIRMS area API limit per request

interface Window {
  name: string;
  label: string;
  start: string; // YYYY-MM-DD (or ISO; only the date is used here)
  end: string; // inclusive
  bbox: [number, number, number, number]; // west, south, east, north
  rowsPath?: string;
  historyPath?: string;
}

// ---------------------------------------------------------------- args and key

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const dryRun = flag("dry-run");
const specPath = opt("spec", join(root, "analytics", "backtest_real.json"));
const source = opt("source", "VIIRS_SNPP_SP");
const historyDays = Number(opt("history-days", "365"));
const paceMs = Number(opt("pace-ms", dryRun ? "0" : "2000"));
const only = opt("only", "").split(",").filter(Boolean);
const outDir = opt("out-dir", dryRun ? join(tmpdir(), "satfire-firms-dryrun") : join(root, "data", "backtest"));

function readEnvLocal(): Record<string, string> {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const mapKey = dryRun ? "DRYRUNKEY" : readEnvLocal().FIRMS_MAP_KEY || process.env.FIRMS_MAP_KEY || "";
const redact = (s: string) => (mapKey ? s.split(mapKey).join("***") : s);

if (!mapKey) {
  console.error("FIRMS_MAP_KEY is not set (.env.local or environment). Nothing fetched. Use --dry-run to exercise the code path.");
  process.exit(2);
}

// ---------------------------------------------------------------- dates and chunks

const dateOnly = (s: string) => s.slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Split [first, last] (inclusive dates) into <= 10-day API requests. */
function chunks(first: string, last: string): { date: string; days: number }[] {
  const out: { date: string; days: number }[] = [];
  for (let d = first; daysBetween(d, last) >= 0; d = addDays(d, MAX_DAY_RANGE))
    out.push({ date: d, days: Math.min(MAX_DAY_RANGE, daysBetween(d, last) + 1) });
  return out;
}

// ---------------------------------------------------------------- fetch

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text: string, src: string): FirmsRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  if (!header.includes("latitude") || !header.includes("acq_date"))
    throw new Error(`unexpected FIRMS response: ${lines[0].slice(0, 120)}`);
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    row.source = src;
    return row as FirmsRow;
  });
}

/** Deterministic fake FIRMS CSV for --dry-run: a steady ~8 MW source, plus a hotter spreading
 *  cluster inside the evaluation window. Exercises parsing, chunking, history and the backtest. */
function fakeCsv(bbox: Window["bbox"], date: string, days: number, inWindow: boolean): string {
  const header = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type";
  const lat = (bbox[1] + bbox[3]) / 2;
  const lon = (bbox[0] + bbox[2]) / 2;
  const lines = [header];
  for (let k = 0; k < days; k++) {
    const d = addDays(date, k);
    if (k % 2 === 0) lines.push(`${lat.toFixed(5)},${lon.toFixed(5)},345.20,0.39,0.36,${d},0812,N,VIIRS,n,2,301.40,${(7.5 + (k % 3)).toFixed(2)},D,2`);
    if (inWindow)
      for (let i = 0; i < 1 + k; i++)
        lines.push(`${(lat + 0.0035 * i).toFixed(5)},${(lon + 0.0035 * (i % 2)).toFixed(5)},367.00,0.40,0.37,${d},2006,N,VIIRS,h,2,320.10,${(60 + 15 * i).toFixed(2)},N,0`);
  }
  return lines.join("\n") + "\n";
}

async function fetchChunk(bbox: Window["bbox"], date: string, days: number, inWindow: boolean): Promise<FirmsRow[]> {
  const area = bbox.join(",");
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/${area}/${days}/${date}`;
  if (dryRun) {
    console.log(`  [dry-run] GET ${redact(url)}`);
    return parseCsv(fakeCsv(bbox, date, days, inWindow), source);
  }
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return parseCsv(text, source);
    } catch (err) {
      lastErr = redact(String(err instanceof Error ? err.message : err));
      console.warn(`  retry ${attempt}/4 for ${source} ${area} ${date}+${days}d: ${lastErr}`);
      await sleep(5000 * attempt);
    }
  }
  throw new Error(`giving up on ${source} ${area} ${date}+${days}d: ${lastErr}`);
}

async function fetchRange(bbox: Window["bbox"], first: string, last: string, inWindow: boolean): Promise<{ rows: FirmsRow[]; requests: number }> {
  const seen = new Set<string>();
  const rows: FirmsRow[] = [];
  const parts = chunks(first, last);
  for (const [i, c] of parts.entries()) {
    for (const r of await fetchChunk(bbox, c.date, c.days, inWindow)) {
      const d = r.acq_date ?? "";
      if (d < first || d > last) continue; // keep strictly inside the requested range (no leakage)
      const key = `${r.latitude}|${r.longitude}|${r.acq_date}|${r.acq_time}|${r.satellite}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    if (paceMs && i < parts.length - 1) await sleep(paceMs);
  }
  return { rows, requests: parts.length };
}

function toHistory(rows: FirmsRow[], siteKey: string): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const r of rows) {
    const acqTime = parseAcqTime(r.acq_date, r.acq_time);
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const frpMW = Number(r.frp);
    if (!acqTime || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(frpMW)) continue; // malformed: skipped
    out.push({ siteKey, acqTime, lat, lon, frpMW });
  }
  return out.sort((a, b) => a.acqTime.localeCompare(b.acqTime));
}

// ---------------------------------------------------------------- main

const specFile = isAbsolute(specPath) ? specPath : join(root, specPath);
const spec = JSON.parse(readFileSync(specFile, "utf8"));
const windows: Window[] = (Array.isArray(spec) ? spec : spec.windows).filter((w: Window) => !only.length || only.includes(w.name));
mkdirSync(outDir, { recursive: true });

const manifestPath = join(outDir, "manifest.json");
const manifest: Record<string, unknown> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const dryRunSpec: unknown[] = [];

for (const w of windows) {
  if (!w.bbox) throw new Error(`window ${w.name} has no bbox`);
  const first = dateOnly(w.start);
  const last = dateOnly(w.end);
  const rowsFile = join(outDir, `${w.name}.json`);
  const histFile = join(outDir, `${w.name}_history.json`);
  console.log(`${w.name} (${w.label}) bbox ${w.bbox.join(",")} window ${first}..${last}`);

  let windowRows = 0;
  let historyRecords = 0;
  let requests = 0;
  if (existsSync(rowsFile) && !flag("force")) {
    console.log(`  ${rowsFile} exists, skipped (use --force to refetch)`);
  } else {
    const r = await fetchRange(w.bbox, first, last, true);
    writeFileSync(rowsFile, JSON.stringify(r.rows, null, 1) + "\n");
    windowRows = r.rows.length;
    requests += r.requests;
    console.log(`  window: ${r.rows.length} rows in ${r.requests} requests -> ${rowsFile}`);
  }
  if (!flag("no-history")) {
    if (existsSync(histFile) && !flag("force")) {
      console.log(`  ${histFile} exists, skipped`);
    } else {
      const hFirst = addDays(first, -historyDays);
      const hLast = addDays(first, -1); // ends the day BEFORE the window starts
      const h = await fetchRange(w.bbox, hFirst, hLast, false);
      const hist = toHistory(h.rows, w.name);
      writeFileSync(histFile, JSON.stringify(hist, null, 1) + "\n");
      historyRecords = hist.length;
      requests += h.requests;
      console.log(`  history ${hFirst}..${hLast}: ${hist.length} records in ${h.requests} requests -> ${histFile}`);
    }
  }
  if (windowRows || historyRecords)
    manifest[w.name] = { fetchedAt: new Date().toISOString(), source, bbox: w.bbox, window: [first, last], historyDays, windowRows, historyRecords, requests, dryRun };
  dryRunSpec.push({ ...w, rowsPath: rowsFile, historyPath: histFile });
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
if (dryRun) {
  const p = join(outDir, "spec.json");
  writeFileSync(p, JSON.stringify({ dataset: `DRY RUN (fake CSV) ${source}`, sample: true, caveat: "DRY RUN on a fake CSV — code-path check only, no real data.", windows: dryRunSpec }, null, 1) + "\n");
  console.log(`dry-run spec for analytics/backtest.py -> ${p}`);
}
console.log(`done -> ${outDir}`);
