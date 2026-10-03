// Bulk-loads land-use / facility polygons into PostGIS, bumps the attribution version and
// re-attributes every stored detection of that dataset (plan Phase 3 provenance).
// The live dataset uses the merged national layer (backend/livePolygons.ts): the Geofabrik
// india extract when present, else the tracked Overpass focus-region files, plus WRI anchors.
// Run: npm run db:load            (sample + live, whichever files exist)
//      npm run db:load -- sample  (one dataset)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../backend/config.ts";
import { loadLiveLayer } from "../backend/livePolygons.ts";
import { createPool, loadPolygons } from "../backend/postgis.ts";
import type { Dataset, PolygonCollection } from "../shared/types.ts";

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}
const wanted = (process.argv[2] as Dataset | undefined) ?? null;
const pool = createPool(cfg.databaseUrl);
for (const dataset of ["sample", "live"] as Dataset[]) {
  if (wanted && wanted !== dataset) continue;
  let fc: PolygonCollection | null = null;
  if (dataset === "sample") {
    const path = join(cfg.root, "data", "sample", "landuse_polygons.geojson");
    if (!existsSync(path)) {
      console.log(`${dataset}: ${path} not found — skipped`);
      continue;
    }
    fc = JSON.parse(readFileSync(path, "utf8")) as PolygonCollection;
  } else {
    const live = loadLiveLayer(cfg.root);
    if (!live.polygons.features.length) {
      console.log(`${dataset}: no live polygons (${live.source}) — skipped`);
      continue;
    }
    console.log(`live: ${live.source}`);
    fc = live.polygons;
  }
  const r = await loadPolygons(pool, dataset, fc);
  console.log(`${dataset}: loaded ${r.loaded} polygons, attribution v${r.version}, re-attributed ${r.reattributed} stored detections`);
}
await pool.end();
