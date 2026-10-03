// Builds the national live polygon layer from the Geofabrik India extract.
// The 1.6 GB PBF stays in data/runtime/osm/ (git-ignored); only the filtered
// industrial/quarry/farmland/forest polygons land in data/runtime/osm/ as
// landuse_india.geojson + facilities_india.json, which the pipeline prefers over
// data/osm/ when present (backend/livePolygons.ts).
//
// Tag/type/CPCB mapping is shared/osmTags.ts — the same implementation as the
// Overpass focus-region loader, so the two layers never disagree on what a tag means.
//
// Run: npm run osm:india            (GDAL filter in a container + Node build)
//      npm run osm:india -- --skip-gdal   (rebuild from an existing filtered file)

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT } from "../backend/config.ts";
import { cpcbOf, tagOf, typeOf } from "../shared/osmTags.ts";
import type { Facility, PolygonFeature } from "../shared/types.ts";

const DIR = join(ROOT, "data", "runtime", "osm");
const PBF = join(DIR, "india-latest.osm.pbf");
const FILTERED = join(DIR, "india_filtered.geojsons");
const OUT_FC = join(DIR, "landuse_india.geojson");
const OUT_FAC = join(DIR, "facilities_india.json");
const OUT_META = join(DIR, "landuse_india.meta.json");

mkdirSync(DIR, { recursive: true });
if (!existsSync(PBF)) {
  console.error(`Missing ${PBF} — download https://download.geofabrik.de/asia/india-latest.osm.pbf there first.`);
  process.exit(1);
}

const skipGdal = process.argv.includes("--skip-gdal");
if (!skipGdal) {
  // GDAL only exposes the ini's attribute list as columns, so we ship a config
  // with the industrial keys added (scripts/osmconf.india.ini). plant:source and
  // name:en travel inside other_tags and are parsed back in Node.
  writeFileSync(join(DIR, "osmconf.india.ini"), readFileSync(join(ROOT, "scripts", "osmconf.india.ini")));
  // GDAL's OSM driver assembles closed ways (osm_way_id) and multipolygon
  // relations (osm_id) into the multipolygons layer. Simplify tolerance (~5 m)
  // stays far below the 100 m fence-line buffer floor, so attribution is unaffected.
  const sql =
    `SELECT osm_id, osm_way_id, landuse, natural, power, man_made, industrial, name,` +
    ` operator, product, company, other_tags FROM multipolygons WHERE landuse IN` +
    ` ('industrial','quarry','farmland','forest') OR natural = 'wood' OR power = 'plant'` +
    ` OR man_made IN ('works','kiln') OR industrial IN ('mine','brickyard')`;
  const dataArg = DIR.replace(/\\/g, "/");
  console.log("gdal: filtering multipolygons (this takes a few minutes)...");
  execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${dataArg}:/data`,
      "osgeo/gdal:ubuntu-small-3.6.3",
      "ogr2ogr", "--config", "OSM_CONFIG_FILE", "/data/osmconf.india.ini",
      "-f", "GeoJSONSeq", "/data/india_filtered.geojsons", "/data/india-latest.osm.pbf", "multipolygons",
      "-sql", sql, "-simplify", "0.00005", "-lco", "RS=NO", "-skipfailures",
    ],
    { stdio: "inherit" },
  );
} else if (!existsSync(FILTERED)) {
  console.error(`Missing ${FILTERED} — run without --skip-gdal first.`);
  process.exit(1);
}

// other_tags arrives as `"k"=>"v","k2"=>"v2"` (hstore style); explicit fields win.
function parseOtherTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "string" || !raw) return out;
  for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"=>"(?:((?:[^"\\]|\\.)*))"/g)) {
    try {
      out[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`);
    } catch {
      // ignore malformed pairs
    }
  }
  return out;
}

const ring = (r: number[][]) => r.map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]);
const closed = (r: number[][]) => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];

const refreshedAt = new Date().toISOString();
const features = new Map<string, PolygonFeature>();
const facilities = new Map<string, Facility>();
let seen = 0;
let kept = 0;
let skipped = 0;

const rl = createInterface({ input: createReadStream(FILTERED, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  seen++;
  let feat: { properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } };
  try {
    feat = JSON.parse(line);
  } catch {
    skipped++;
    continue;
  }
  const props = feat.properties ?? {};
  const tags: Record<string, string> = { ...parseOtherTags(props.other_tags) };
  for (const [k, v] of Object.entries(props)) {
    if (k === "other_tags" || v === null || v === undefined) continue;
    tags[k] = String(v);
  }
  const tag = tagOf(tags);
  if (!tag) continue;
  const geom = feat.geometry;
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    skipped++;
    continue;
  }
  const polys = (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates) as number[][][][];
  const rings = polys.map((p) => ring(p[0])).filter(closed);
  if (!rings.length) {
    skipped++;
    continue;
  }
  // osm_id is set for relations, osm_way_id for closed ways — never both.
  const rawId = props.osm_id ?? props.osm_way_id ?? `${seen}`;
  const id = `OSM-india-${props.osm_id !== undefined && props.osm_id !== null ? `r${props.osm_id}` : `w${rawId}`}`;
  const displayName = tags.name ?? tags["name:en"] ?? null;
  const named = Boolean(displayName) && (tag === "industrial" || tag === "quarry");
  const t = typeOf(tags);
  const cpcb = named ? cpcbOf(t.type) : null;
  features.set(id, {
    type: "Feature",
    id,
    properties: {
      id,
      tag,
      facilityId: named ? id : null,
      name: displayName,
      cpcbCategory: cpcb,
      source: "OpenStreetMap Geofabrik india extract via GDAL (© OpenStreetMap contributors, ODbL)",
      refreshedAt,
      mappedSince: null,
      osmTags: tags,
    },
    geometry: rings.length === 1 ? { type: "Polygon", coordinates: [rings[0]] } : { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
  });
  if (named) {
    const pts = rings[0];
    facilities.set(id, {
      id,
      dataset: "live",
      name: displayName as string,
      type: t.type,
      lat: pts.reduce((sum, p) => sum + p[1], 0) / pts.length,
      lon: pts.reduce((sum, p) => sum + p[0], 0) / pts.length,
      state: tags["addr:state"] ?? "",
      cpcbCategory: cpcb,
      cpcbSource: "Derived from industry type (CPCB 2016 categorisation) — not an official per-facility record",
      routineSources: [],
      kiln: t.kiln,
      mappedSince: null,
      source: "OpenStreetMap Geofabrik india extract via GDAL",
      refreshedAt,
      polygonIds: [id],
    });
  }
  kept++;
}

writeFileSync(OUT_FC, JSON.stringify({ type: "FeatureCollection", features: [...features.values()] }));
writeFileSync(OUT_FAC, JSON.stringify([...facilities.values()], null, 1));
const byTag = new Map<string, number>();
for (const f of features.values()) byTag.set(f.properties.tag, (byTag.get(f.properties.tag) ?? 0) + 1);
writeFileSync(OUT_META, JSON.stringify({ refreshedAt, pbf: "india-latest.osm.pbf", seen, kept, skipped, byTag: Object.fromEntries(byTag) }, null, 1));
console.log(`india: ${kept} polygons (${skipped} skipped) -> ${OUT_FC}`);
console.log(`india: ${facilities.size} named facilities -> ${OUT_FAC}`);
console.log(`by tag: ${[...byTag.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
