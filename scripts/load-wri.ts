// Second spatial anchor: WRI Global Power Plant Database (CC BY 4.0) for India.
// Thermal-fuel plants get a synthetic circular facility polygon (a fallback anchor
// where OSM has no mapped polygon); every plant becomes a facility record.
// Output (git-ignored): data/runtime/osm/facilities_wri.json, merged on top of the
// OSM layer by backend/livePolygons.ts, which drops a synthetic polygon wherever
// an OSM polygon already anchors the site.
//
// Run: npm run osm:wri   (downloads the CSV if missing, rebuilds the file)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../backend/config.ts";
import type { CpcbCategory, Facility, PolygonFeature } from "../shared/types.ts";

const DIR = join(ROOT, "data", "runtime", "osm");
const CSV = join(DIR, "gppd.csv");
const OUT = join(DIR, "facilities_wri.json");
const URL = "https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv";

mkdirSync(DIR, { recursive: true });
if (!existsSync(CSV)) {
  console.log("wri: downloading Global Power Plant Database (~11 MB)...");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`WRI download failed: ${res.status}`);
  writeFileSync(CSV, Buffer.from(await res.arrayBuffer()));
}

// Minimal CSV parse (the file uses plain quoting, no embedded newlines).
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

// Only combustion fuels make thermal anchors; hydro/solar/wind/geothermal plants
// are recorded as facilities without a polygon (they are not thermal sources).
const THERMAL = new Set(["Coal", "Oil", "Gas", "Petcoke", "Biomass", "Waste", "Coalbed Methane"]);
const typeOfFuel = (fuel: string): { type: string; cpcb: CpcbCategory | null } =>
  THERMAL.has(fuel)
    ? { type: "Thermal power plant", cpcb: "Red" }
    : { type: `Power plant (${fuel.toLowerCase()})`, cpcb: null };

// Approximate footprint: real stations span ~0.3–2 km; OSM polygons win wherever
// they exist, so this circle is only a fallback anchor, never a fence line.
const radiusFor = (capacityMW: number): number =>
  Math.round(Math.min(800, Math.max(250, 200 + Math.sqrt(Math.max(0, capacityMW)) * 8)));

const circle = (lat: number, lon: number, radiusM: number): number[][] => {
  const pts: number[][] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    const dLat = (Math.cos(a) * radiusM) / 111320;
    const dLon = (Math.sin(a) * radiusM) / (111320 * Math.cos((lat * Math.PI) / 180));
    pts.push([Number((lon + dLon).toFixed(6)), Number((lat + dLat).toFixed(6))]);
  }
  pts.push([...pts[0]]);
  return pts;
};

const { header, rows } = parseCsv(readFileSync(CSV, "utf8"));
const col = (name: string): number => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`WRI CSV missing column ${name}`);
  return i;
};
const cCountry = col("country");
const cName = col("name");
const cId = col("gppd_idnr");
const cCap = col("capacity_mw");
const cLat = col("latitude");
const cLon = col("longitude");
const cFuel = col("primary_fuel");

const refreshedAt = new Date().toISOString();
const polygons: PolygonFeature[] = [];
const facilities: Facility[] = [];
let india = 0;
let thermal = 0;
for (const r of rows) {
  if (r[cCountry] !== "IND" && r[cCountry] !== "India") continue;
  const lat = Number(r[cLat]);
  const lon = Number(r[cLon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  india++;
  const name = r[cName] || `WRI plant ${r[cId]}`;
  const fuel = r[cFuel] || "Unknown";
  const cap = Number(r[cCap]) || 0;
  const { type, cpcb } = typeOfFuel(fuel);
  const id = `WRI-${r[cId]}`;
  const source = "WRI Global Power Plant Database v1.3.0 (CC BY 4.0)";
  facilities.push({
    id,
    dataset: "live",
    name,
    type,
    lat,
    lon,
    state: "",
    cpcbCategory: cpcb,
    cpcbSource: "Derived from fuel type (CPCB 2016 categorisation) — not an official per-facility record",
    routineSources: [],
    kiln: false,
    mappedSince: null,
    source,
    refreshedAt,
    polygonIds: THERMAL.has(fuel) ? [id] : [],
  });
  if (!THERMAL.has(fuel)) continue;
  thermal++;
  const coords = circle(lat, lon, radiusFor(cap));
  polygons.push({
    type: "Feature",
    id,
    properties: {
      id,
      tag: "industrial",
      facilityId: id,
      name,
      cpcbCategory: cpcb,
      source: `${source}; synthetic ${radiusFor(cap)} m circular anchor (fallback where OSM has no polygon)`,
      refreshedAt,
      mappedSince: null,
      osmTags: { "plant:source": fuel.toLowerCase(), capacity_mw: r[cCap], gppd_id: r[cId] },
    },
    geometry: { type: "Polygon", coordinates: [coords] },
  });
}

writeFileSync(OUT, JSON.stringify({ polygons: { type: "FeatureCollection", features: polygons }, facilities }, null, 1));
console.log(`wri: ${india} India plants (${thermal} thermal anchors) -> ${OUT}`);
