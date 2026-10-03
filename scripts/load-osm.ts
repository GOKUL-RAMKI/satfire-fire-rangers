// Bulk-loads real OpenStreetMap land-use and facility polygons via the Overpass API into
// data/osm/landuse.geojson and data/osm/facilities.json (then `npm run db:load` puts them in PostGIS).
// Bulk loading keeps live Overpass calls off the classification path (plan Phase 3).
//
// Run: npm run osm:load                        (±10 km around every monitored facility)
//      npm run osm:load -- --bbox 75.2,30.9,75.6,31.3 --bbox ...   (extra regions, w,s,e,n)
//      npm run osm:load -- --radius-km 5
//      npm run osm:load -- --merge --only-extra --bbox ...   (add regions to the existing files)
//      npm run osm:load -- --reprocess   (re-derive tags/facilities from the stored OSM tags, no network)
// India-wide coverage is the Geofabrik extract path (see to_do.md); this loader is for focus regions.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../backend/config.ts";
import { cpcbOf, tagOf, typeOf } from "../shared/osmTags.ts";
import type { Facility, PolygonFeature } from "../shared/types.ts";

const args = process.argv.slice(2);
const radiusKm = Number(args[args.indexOf("--radius-km") + 1]) || 10;
const extra = args.flatMap((a, i) => (a === "--bbox" ? [args[i + 1]] : []));
const reprocess = args.includes("--reprocess");
const merge = args.includes("--merge") || reprocess;
const onlyExtra = args.includes("--only-extra");
const monitored = JSON.parse(readFileSync(join(ROOT, "data", "sample", "facilities.json"), "utf8")) as Facility[];

const bboxes: { name: string; bbox: [number, number, number, number] }[] = [
  ...monitored
    .filter((f) => !onlyExtra && !f.name.includes("(sample)"))
    .map((f) => {
      const dLat = radiusKm / 111.32;
      const dLon = radiusKm / (111.32 * Math.cos((f.lat * Math.PI) / 180));
      return { name: f.name, bbox: [f.lon - dLon, f.lat - dLat, f.lon + dLon, f.lat + dLat] as [number, number, number, number] };
    }),
  ...extra.map((b) => ({ name: `bbox ${b}`, bbox: b.split(",").map(Number) as [number, number, number, number] })),
];

const query = (b: [number, number, number, number]) => {
  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`; // Overpass wants s,w,n,e
  return `[out:json][timeout:180];(
  way["landuse"~"^(industrial|quarry|farmland|forest|farm|farmyard|meadow|orchard|vineyard|grass|plant_nursery)$"](${bb});
  relation["landuse"~"^(industrial|quarry|forest)$"](${bb});
  way["natural"="wood"](${bb});
  way["power"="plant"](${bb}); relation["power"="plant"](${bb});
  way["man_made"~"^(works|kiln)$"](${bb});
  way["industrial"~"^(mine|brickyard)$"](${bb});
);out geom;`;
};

interface El {
  type: "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

const ring = (g: { lat: number; lon: number }[]) => g.map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]);
const closed = (r: number[][]) => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];

const refreshedAt = new Date().toISOString();
const features = new Map<string, PolygonFeature>();
const facilities = new Map<string, Facility>();
if (merge) {
  try {
    const fc = JSON.parse(readFileSync(join(ROOT, "data", "osm", "landuse.geojson"), "utf8")) as { features: PolygonFeature[] };
    for (const f of fc.features) features.set(f.id, f);
    for (const f of JSON.parse(readFileSync(join(ROOT, "data", "osm", "facilities.json"), "utf8")) as Facility[]) facilities.set(f.id, f);
  } catch {
    // nothing to merge yet
  }
}
let skipped = 0;

if (reprocess) {
  // rebuild every stored feature from its OSM tags with the current tag / type / CPCB logic
  const stored = [...features.values()];
  features.clear();
  facilities.clear();
  for (const f of stored) {
    const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
    addFeature(f.id, f.properties.osmTags, rings, f.properties.refreshedAt);
  }
  bboxes.length = 0;
}

function addFeature(id: string, tags: Record<string, string>, rings: number[][][], refreshed: string): boolean {
  const tag = tagOf(tags);
  if (!tag) return false;
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
      source: "OpenStreetMap via Overpass bulk load (© OpenStreetMap contributors, ODbL)",
      refreshedAt: refreshed,
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
      source: "OpenStreetMap via Overpass bulk load",
      refreshedAt: refreshed,
      polygonIds: [id],
    });
  }
  return true;
}

for (const { name, bbox } of bboxes) {
  let payload: { elements: El[] } | null = null;
  for (let attempt = 1; attempt <= 3 && !payload; attempt++) {
    try {
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "SATFIRE/3.0 bulk loader (SIH26162)" },
        body: new URLSearchParams({ data: query(bbox) }),
        signal: AbortSignal.timeout(200000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      payload = (await res.json()) as { elements: El[] };
    } catch (e) {
      console.warn(`  ${name}: attempt ${attempt} failed (${e instanceof Error ? e.message : e})`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  if (!payload) continue;
  let n = 0;
  for (const el of payload.elements) {
    const tags = el.tags ?? {};
    if (!tagOf(tags)) continue;
    let rings: number[][][] = [];
    if (el.type === "way" && el.geometry) rings = [ring(el.geometry)];
    else if (el.type === "relation")
      rings = (el.members ?? []).filter((m) => m.role === "outer" && m.geometry).map((m) => ring(m.geometry as { lat: number; lon: number }[]));
    rings = rings.filter(closed);
    if (!rings.length) {
      skipped++;
      continue;
    }
    if (addFeature(`OSM-${el.type}-${el.id}`, tags, rings, refreshedAt)) n++;
  }
  console.log(`${name}: ${n} polygons`);
  await new Promise((r) => setTimeout(r, 2000)); // be polite to the public Overpass instance
}

mkdirSync(join(ROOT, "data", "osm"), { recursive: true });
writeFileSync(join(ROOT, "data", "osm", "landuse.geojson"), JSON.stringify({ type: "FeatureCollection", features: [...features.values()] }));
writeFileSync(join(ROOT, "data", "osm", "facilities.json"), JSON.stringify([...facilities.values()], null, 1));
console.log(`wrote ${features.size} polygons (${skipped} unclosed relation/way geometries skipped), ${facilities.size} named facilities -> data/osm/`);
