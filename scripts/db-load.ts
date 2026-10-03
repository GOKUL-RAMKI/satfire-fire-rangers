// Bulk-loads land-use / facility polygons into PostGIS, bumps the attribution version and
// re-attributes every stored detection of that dataset (plan Phase 3 provenance).
// Run: npm run db:load            (sample + live, whichever files exist)
//      npm run db:load -- sample  (one dataset)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../backend/config.ts";
import { createPool, loadPolygons } from "../backend/postgis.ts";
import type { Dataset, PolygonCollection } from "../shared/types.ts";

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}
const files: Record<Dataset, string> = {
  sample: join(cfg.root, "data", "sample", "landuse_polygons.geojson"),
  live: join(cfg.root, "data", "osm", "landuse.geojson"),
};
const wanted = (process.argv[2] as Dataset | undefined) ?? null;
const pool = createPool(cfg.databaseUrl);
for (const dataset of ["sample", "live"] as Dataset[]) {
  if (wanted && wanted !== dataset) continue;
  if (!existsSync(files[dataset])) {
    console.log(`${dataset}: ${files[dataset]} not found — skipped`);
    continue;
  }
  const fc = JSON.parse(readFileSync(files[dataset], "utf8")) as PolygonCollection;
  const r = await loadPolygons(pool, dataset, fc);
  console.log(`${dataset}: loaded ${r.loaded} polygons, attribution v${r.version}, re-attributed ${r.reattributed} stored detections`);
}
await pool.end();
