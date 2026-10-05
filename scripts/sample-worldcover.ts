// Samples ESA WorldCover v200 (2021, 10 m COGs on public S3, no account needed)
// at live CELL sites — detections with no OSM polygon match, the only sites the
// WorldCover fallback can ever affect (eventContext consults landcover only when
// there is no polygon winner). Matched sites are skipped: their tag already won.
//
// One GDAL container run opens each tile COG once over /vsicurl/ (range
// reads) and samples every site in that tile, so there is no bulk download.
// Output data/runtime/landuse... (git-ignored): data/runtime/landcover_live.json,
// a LandcoverPoint list the live pipeline prefers when present, exactly like the
// sample landcover.json. Re-run when new CELL sites appear.
//
// Class codes: ESA WorldCover v200 legend (10 tree … 100 moss/lichen).
//
// Run: npm run wc:sample -- --dry-run   (no network, prints tile plan)
//      npm run wc:sample                 (samples every live CELL site)
//      npm run wc:sample -- --radius-km 2

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ROOT } from "../backend/config.ts";
import { createPool } from "../backend/postgis.ts";
import type { LandcoverPoint } from "../shared/spatial.ts";

const OUT = join(ROOT, "data", "runtime", "landcover_live.json");

const CODE_CLASS: Record<number, string> = {
  10: "Tree cover",
  20: "Shrubland",
  30: "Grassland",
  40: "Cropland",
  50: "Built-up",
  60: "Bare / sparse vegetation",
  70: "Permanent snow and ice",
  80: "Permanent water bodies",
  90: "Herbaceous wetland",
  95: "Mangroves",
  100: "Moss and lichen",
};

const tileOf = (lat: number, lon: number): string => {
  const la = Math.floor(lat / 3) * 3;
  const lo = Math.floor(lon / 3) * 3;
  return `${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}E${String(lo).padStart(3, "0")}`;
};
const cogUrl = (tile: string) =>
  `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`;

// Runs inside osgeo/gdal: opens each tile COG once, samples every point.
// HTTP timeouts are set: a stalled tile fails fast instead of hanging the run.
const RUNNER = `
import json, sys
from osgeo import gdal
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "TRUE")
gdal.SetConfigOption("GDAL_HTTP_CONNECTTIMEOUT", "15")
gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "60")
gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "2")
tiles = json.load(open("/work/tiles.json"))
out = {}
for i, (tile, job) in enumerate(tiles.items()):
    print(f"tile {i + 1}/{len(tiles)} {tile} ({len(job['points'])} pts)", flush=True)
    try:
        ds = gdal.Open("/vsicurl/" + job["url"])
        if ds is None:
            out[tile] = {"error": "open failed"}
            continue
        band = ds.GetRasterBand(1)
        gt = ds.GetGeoTransform()
        nx, ny = ds.RasterXSize, ds.RasterYSize
        codes = []
        for p in job["points"]:
            px = int((p["lon"] - gt[0]) / gt[1])
            py = int((p["lat"] - gt[3]) / gt[5])
            if px < 0 or py < 0 or px >= nx or py >= ny:
                codes.append(None)
                continue
            try:
                codes.append(int(band.ReadAsArray(px, py, 1, 1)[0][0]))
            except Exception:
                codes.append(None)
        out[tile] = {"codes": codes}
    except Exception as e:
        out[tile] = {"error": str(e)}
print("RESULT:" + json.dumps(out), flush=True)
`;

const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry-run");
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const radiusKm = Number(opt("radius-km", "1.5"));
// Limit to specific tiles for testing, e.g. --tile N21E081 --tile N21E084.
const onlyTiles = argv.flatMap((a, i) => (a === "--tile" && argv[i + 1] ? [argv[i + 1]] : []));

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set. Site centroids live in firms_detections (PostGIS).");
  process.exit(1);
}
const pool = createPool(cfg.databaseUrl);
const rows = (
  await pool.query(
    `SELECT site_key, avg(lat)::float8 AS lat, avg(lon)::float8 AS lon, count(*)::int AS n
     FROM firms_detections WHERE dataset='live' AND site_key LIKE 'CELL-%'
     GROUP BY 1 ORDER BY n DESC`,
  )
).rows as { site_key: string; lat: number; lon: number; n: number }[];
await pool.end();

const byTile = new Map<string, typeof rows>();
for (const r of rows) {
  const t = tileOf(r.lat, r.lon);
  const list = byTile.get(t);
  if (list) list.push(r);
  else byTile.set(t, [r]);
}
console.log(`wc: ${rows.length} CELL sites in ${byTile.size} tiles (radius ${radiusKm} km)`);
for (const [t, list] of [...byTile.entries()].sort()) console.log(`  ${t}: ${list.length} sites`);
if (isDryRun) process.exit(0);

const work = join(tmpdir(), "satfire-wc");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "runner.py"), RUNNER);
const dataArg =
  process.platform === "win32"
    ? work.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => `//${String(d).toLowerCase()}`)
    : work;

const wanted = onlyTiles.length ? [...byTile.entries()].filter(([t]) => onlyTiles.includes(t)) : [...byTile.entries()];
if (!wanted.length) {
  console.error(`wc: no tiles match ${onlyTiles.join(",")}`);
  process.exit(2);
}
const t0 = Date.now();
// Single container run: every tile COG is opened once, all its points sampled.
writeFileSync(
  join(work, "tiles.json"),
  JSON.stringify(Object.fromEntries(wanted.map(([t, list]) => [t, { url: cogUrl(t), points: list.map((r) => ({ lat: r.lat, lon: r.lon })) }]))),
);
const results: Record<string, { codes?: (number | null)[]; error?: string }> = {};
try {
  const raw = execFileSync(
    "docker",
    ["run", "--rm", "-v", `${dataArg}:/work`, "osgeo/gdal:ubuntu-small-3.6.3", "python3", "/work/runner.py"],
    { encoding: "utf8", timeout: 1800000, maxBuffer: 256 * 1024 * 1024 },
  );
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("RESULT:")) Object.assign(results, JSON.parse(line.slice(7)) as typeof results);
    else if (line.trim()) console.log("  " + line.trim());
  }
} catch (e) {
  console.error(`wc: sampling failed (${e instanceof Error ? e.message.split("\n")[0] : e})`);
  process.exit(1);
}

const points: LandcoverPoint[] = [];
const counts = new Map<string, number>();
for (const [tile, list] of wanted) {
  const res = results[tile];
  if (!res || res.error || !res.codes) {
    console.warn(`wc: tile ${tile} failed (${res?.error ?? "no result"}); sites left uncovered`);
    continue;
  }
  list.forEach((r, i) => {
    const code = res.codes?.[i];
    // 0 = nodata (tile edge / ocean): skip silently, the site stays uncovered.
    const cls = code == null || code === 0 ? null : (CODE_CLASS[code] ?? null);
    if (code != null && !cls) console.warn(`wc: tile ${tile}: unknown class code ${code}`);
    if (!cls) return;
    points.push({ lat: r.lat, lon: r.lon, radiusKm, worldCoverClass: cls, place: r.site_key });
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  });
}
console.log(`wc: sampled in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`wc: class counts: ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
if (!existsSync(join(ROOT, "data", "runtime"))) mkdirSync(join(ROOT, "data", "runtime"), { recursive: true });
// Merge with existing output so batched runs (--tile ...) accumulate.
const kept = new Map<string, LandcoverPoint>();
if (existsSync(OUT))
  for (const p of JSON.parse(readFileSync(OUT, "utf8")) as LandcoverPoint[]) kept.set(p.place ?? `${p.lat},${p.lon}`, p);
for (const p of points) kept.set(p.place ?? `${p.lat},${p.lon}`, p);
writeFileSync(OUT, JSON.stringify([...kept.values()], null, 1) + "\n");
console.log(`wc: wrote ${kept.size} points -> ${OUT}`);
