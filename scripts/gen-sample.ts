// Generates the SAMPLE dataset in data/sample/. Every thermal value is forward-modelled from a stated
// fire temperature, sub-pixel area and background with the Planck function (shared/dozier.ts), so the
// brightness temperatures, saturation and FRP are physically consistent with one another. VIIRS I4
// is capped at its ~367 K saturation level exactly as real FIRMS rows are. Rows use the FIRMS CSV
// schema so sample and live data go through the same ingest path, quality gate included.
//
// Run: npm run sample:gen   (deterministic — same output every run)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { forwardModel, I4_SAT_K, I5_SAT_K } from "../shared/dozier.ts";
import { offsetLatLon } from "../shared/geo.ts";
import type { CpcbCategory, Facility, FirmsRow, HistoryRecord, LandTag, PolygonFeature, SarCheck } from "../shared/types.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = join(root, "data", "sample");
mkdirSync(out, { recursive: true });

// deterministic PRNG (mulberry32)
let seed = 26162;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (mu: number, sd: number) => mu + sd * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

const REFRESHED = "2026-04-01T00:00:00Z";
const SAMPLE_SOURCE = "SAMPLE geometry (approximate, hand-drawn around the facility location)";
const BG_K = 300; // the sample uses the background the solver assumes; real backgrounds vary (see Dozier range)
const NOMINAL_SCAN = 0.39; // km
const NOMINAL_TRACK = 0.36; // km

// ---------------------------------------------------------------- facilities and polygons

interface FacSpec {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  state: string;
  tag: LandTag;
  halfW: number;
  halfH: number;
  routine: string[];
  mappedSince: string | null;
  osm: Record<string, string>;
}

const FACS: FacSpec[] = [
  { id: "FAC-001", name: "Paradip Petrochemical Processing Complex", type: "Petrochemical complex", lat: 20.294, lon: 86.662, state: "Odisha", tag: "industrial", halfW: 1400, halfH: 1000, routine: ["Flare stack F-1 (routine)", "Process heater H-2"], mappedSince: "2019-06-01T00:00:00Z", osm: { landuse: "industrial", industrial: "petrochemical" } },
  { id: "FAC-002", name: "Jamnagar Refinery — Flare Yard", type: "Oil refinery", lat: 22.383, lon: 70.012, state: "Gujarat", tag: "industrial", halfW: 1800, halfH: 1200, routine: ["Flare stack J-1 (routine, planned)", "Flare stack J-2 (standby)"], mappedSince: "2016-03-01T00:00:00Z", osm: { landuse: "industrial", industrial: "refinery" } },
  { id: "FAC-003", name: "Korba Thermal Power Station", type: "Thermal power plant", lat: 22.384, lon: 82.68, state: "Chhattisgarh", tag: "industrial", halfW: 1200, halfH: 1000, routine: ["Boiler stack (steady heat)", "Coal conveyor gallery"], mappedSince: "2015-01-01T00:00:00Z", osm: { landuse: "industrial", power: "plant" } },
  { id: "FAC-004", name: "Jharia Coal Mine Complex", type: "Coal mine", lat: 23.712, lon: 86.413, state: "Jharkhand", tag: "quarry", halfW: 2500, halfH: 2000, routine: ["Underground seam smoulder zone", "Slag cooling yard"], mappedSince: "2014-01-01T00:00:00Z", osm: { landuse: "quarry", resource: "coal" } },
  { id: "FAC-005", name: "Kakinada LNG Terminal", type: "LNG terminal", lat: 16.962, lon: 82.281, state: "Andhra Pradesh", tag: "industrial", halfW: 900, halfH: 700, routine: ["Pilot flare K-1"], mappedSince: "2018-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "port" } },
  { id: "FAC-006", name: "Bhilai Steel Plant", type: "Steel plant", lat: 21.195, lon: 81.38, state: "Chhattisgarh", tag: "industrial", halfW: 1600, halfH: 1300, routine: ["Blast furnace BF-3", "Coke oven battery"], mappedSince: "2015-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "steelmaking" } },
  { id: "FAC-007", name: "Talcher Fertilizer Complex", type: "Fertilizer plant", lat: 20.944, lon: 85.202, state: "Odisha", tag: "industrial", halfW: 800, halfH: 700, routine: ["Reformer stack"], mappedSince: "2017-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "chemical" } },
  { id: "FAC-008", name: "Vindhyachal Super Thermal Power Station", type: "Thermal power plant", lat: 24.095, lon: 82.672, state: "Madhya Pradesh", tag: "industrial", halfW: 1300, halfH: 1100, routine: ["Unit stacks 1–6"], mappedSince: "2015-01-01T00:00:00Z", osm: { landuse: "industrial", power: "plant" } },
  { id: "FAC-009", name: "Haldia Petrochemical Refinery", type: "Oil refinery", lat: 22.062, lon: 88.119, state: "West Bengal", tag: "industrial", halfW: 1400, halfH: 1100, routine: ["Flare H-1 (routine)"], mappedSince: "2016-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "refinery" } },
  { id: "FAC-010", name: "Neyveli Lignite Mine", type: "Lignite mine", lat: 11.613, lon: 79.477, state: "Tamil Nadu", tag: "quarry", halfW: 2500, halfH: 2200, routine: ["Overburden dump smoulder"], mappedSince: "2014-01-01T00:00:00Z", osm: { landuse: "quarry", resource: "lignite" } },
  { id: "FAC-011", name: "Visakhapatnam Steel Plant", type: "Steel plant", lat: 17.629, lon: 83.198, state: "Andhra Pradesh", tag: "industrial", halfW: 1500, halfH: 1200, routine: ["Blast furnace", "Sinter plant"], mappedSince: "2015-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "steelmaking" } },
  { id: "FAC-012", name: "Mathura Refinery", type: "Oil refinery", lat: 27.489, lon: 77.673, state: "Uttar Pradesh", tag: "industrial", halfW: 1100, halfH: 900, routine: ["Flare M-1 (routine)"], mappedSince: "2016-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "refinery" } },
  { id: "FAC-013", name: "Durgapur Steel & Power Cluster", type: "Steel plant", lat: 23.548, lon: 87.292, state: "West Bengal", tag: "industrial", halfW: 1300, halfH: 1000, routine: ["Coke oven", "Power boiler"], mappedSince: "2015-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "steelmaking" } },
  { id: "FAC-014", name: "Barauni Refinery", type: "Oil refinery", lat: 25.442, lon: 86.021, state: "Bihar", tag: "industrial", halfW: 1000, halfH: 800, routine: ["Flare B-1 (routine)"], mappedSince: "2016-01-01T00:00:00Z", osm: { landuse: "industrial", industrial: "refinery" } },
  { id: "FAC-015", name: "Newly mapped chemical unit (sample), Bharuch district", type: "Chemical plant", lat: 21.701, lon: 72.582, state: "Gujarat", tag: "industrial", halfW: 600, halfH: 500, routine: ["Process flare (commissioned 2026)"], mappedSince: "2026-03-10T00:00:00Z", osm: { landuse: "industrial", industrial: "chemical" } },
];

// CPCB 2016 categorisation by industry type (petroleum refining, petrochemicals, thermal power,
// integrated steel, mining, fertilizer, basic chemicals are Red). Derived, not an official per-facility record.
const CPCB_BY_TYPE: Record<string, CpcbCategory> = {
  "Petrochemical complex": "Red",
  "Oil refinery": "Red",
  "Thermal power plant": "Red",
  "Coal mine": "Red",
  "Lignite mine": "Red",
  "LNG terminal": "Red",
  "Steel plant": "Red",
  "Fertilizer plant": "Red",
  "Chemical plant": "Red",
};
const CPCB_SOURCE = "Derived from industry type (CPCB 2016 categorisation) — not an official per-facility record";

function rect(lat: number, lon: number, halfW: number, halfH: number): number[][][] {
  const c = [
    offsetLatLon(lat, lon, -halfW, -halfH),
    offsetLatLon(lat, lon, halfW, -halfH),
    offsetLatLon(lat, lon, halfW, halfH),
    offsetLatLon(lat, lon, -halfW, halfH),
  ].map(([la, lo]) => [Number(lo.toFixed(6)), Number(la.toFixed(6))]);
  return [[...c, c[0]]];
}

const polygons: PolygonFeature[] = [];
const facilities: Facility[] = [];
for (const f of FACS) {
  const pid = `POLY-${f.id}`;
  const cpcb = CPCB_BY_TYPE[f.type] ?? null;
  polygons.push({
    type: "Feature",
    id: pid,
    properties: { id: pid, tag: f.tag, facilityId: f.id, name: f.name, cpcbCategory: cpcb, source: SAMPLE_SOURCE, refreshedAt: REFRESHED, mappedSince: f.mappedSince, osmTags: { ...f.osm, name: f.name } },
    geometry: { type: "Polygon", coordinates: rect(f.lat, f.lon, f.halfW, f.halfH) },
  });
  facilities.push({
    id: f.id,
    dataset: "sample",
    name: f.name,
    type: f.type,
    lat: f.lat,
    lon: f.lon,
    state: f.state,
    cpcbCategory: cpcb,
    cpcbSource: CPCB_SOURCE,
    routineSources: f.routine,
    kiln: false,
    mappedSince: f.mappedSince,
    source: SAMPLE_SOURCE,
    refreshedAt: REFRESHED,
    polygonIds: [pid],
  });
}

interface AreaSpec {
  id: string;
  name: string;
  tag: LandTag;
  lat: number;
  lon: number;
  halfW: number;
  halfH: number;
  osm: Record<string, string>;
}
const AREAS: AreaSpec[] = [
  { id: "POLY-AGRI-LDH", name: "Farmland, Ludhiana district, Punjab", tag: "farmland", lat: 31.1502, lon: 75.3438, halfW: 3500, halfH: 2500, osm: { landuse: "farmland" } },
  { id: "POLY-AGRI-KNL", name: "Farmland, Karnal district, Haryana", tag: "farmland", lat: 29.6815, lon: 76.9821, halfW: 3000, halfH: 2500, osm: { landuse: "farmland", crop: "wheat" } },
  { id: "POLY-FOR-SIM", name: "Similipal forest, Odisha", tag: "forest", lat: 21.912, lon: 86.314, halfW: 12000, halfH: 12000, osm: { landuse: "forest", boundary: "national_park" } },
  { id: "POLY-FOR-UK", name: "Reserve forest, Pauri Garhwal, Uttarakhand", tag: "forest", lat: 30.0893, lon: 79.3125, halfW: 9000, halfH: 9000, osm: { natural: "wood" } },
];
for (const a of AREAS)
  polygons.push({
    type: "Feature",
    id: a.id,
    properties: { id: a.id, tag: a.tag, facilityId: null, name: a.name, cpcbCategory: null, source: SAMPLE_SOURCE, refreshedAt: REFRESHED, mappedSince: "2015-01-01T00:00:00Z", osmTags: { ...a.osm, name: a.name } },
    geometry: { type: "Polygon", coordinates: rect(a.lat, a.lon, a.halfW, a.halfH) },
  });

// ---------------------------------------------------------------- detections

const rows: FirmsRow[] = [];
const fmtDate = (iso: string) => iso.slice(0, 10);
const fmtTime = (iso: string) => iso.slice(11, 13) + iso.slice(14, 16);

function pixel(opts: {
  lat: number;
  lon: number;
  east: number;
  north: number;
  t: string;
  tfC: number;
  pPct: number;
  conf?: string;
  sat?: "N" | "N20";
  scan?: number;
  track?: number;
}): FirmsRow {
  const [la, lo] = offsetLatLon(opts.lat, opts.lon, opts.east, opts.north);
  const scan = opts.scan ?? NOMINAL_SCAN;
  const track = opts.track ?? NOMINAL_TRACK;
  // pPct is the fire's share of a nominal near-nadir pixel; off-nadir the same fire covers a smaller
  // share of a larger pixel, so fire area (and therefore FRP) stays constant.
  const pEff = (opts.pPct * NOMINAL_SCAN * NOMINAL_TRACK) / (scan * track);
  const fm = forwardModel(opts.tfC, pEff, BG_K, scan * track * 1e6);
  const hour = Number(opts.t.slice(11, 13));
  return {
    latitude: la.toFixed(5),
    longitude: lo.toFixed(5),
    bright_ti4: Math.min(fm.b4, I4_SAT_K).toFixed(2),
    bright_ti5: Math.min(fm.b5, I5_SAT_K).toFixed(2),
    scan: scan.toFixed(2),
    track: track.toFixed(2),
    acq_date: fmtDate(opts.t),
    acq_time: fmtTime(opts.t),
    satellite: opts.sat ?? "N",
    instrument: "VIIRS",
    confidence: opts.conf ?? "n",
    version: "2.0NRT",
    frp: fm.frpMW.toFixed(2),
    daynight: hour >= 4 && hour < 14 ? "D" : "N",
    source: opts.sat === "N20" ? "VIIRS_NOAA20_NRT" : "VIIRS_SNPP_NRT",
  };
}

// VIIRS overpass times over India (UTC): day ~07:30–08:45, night ~19:30–21:00
const D0 = "2026-04-20T07:36:00Z";
const D1 = "2026-04-21T07:48:00Z";
const N1 = "2026-04-21T20:12:00Z";
const D2 = "2026-04-22T07:30:00Z";
const N2 = "2026-04-22T19:54:00Z";
const D3 = "2026-04-23T08:06:00Z";
const N3 = "2026-04-23T20:30:00Z";
export const REFERENCE_NOW = "2026-04-23T22:00:00Z";

const fac = (id: string) => FACS.find((f) => f.id === id) as FacSpec;
const jitter = () => gauss(0, 40);

// 1. Paradip — industrial fire, radial expansion over six overpasses, baseline shattered -> Code Red rule
{
  const f = fac("FAC-001");
  const ring: [number, number][] = [[0, 0], [375, 0], [-375, 0], [0, 375], [0, -375]];
  [D1, N1, D2, N2, D3, N3].forEach((t, k) => {
    const n = [1, 2, 3, 4, 5, 5][k];
    for (let i = 0; i < n; i++)
      rows.push(pixel({ lat: f.lat, lon: f.lon, east: ring[i][0] + jitter(), north: ring[i][1] + jitter(), t, tfC: i === 0 ? 1200 : 1000, pPct: i === 0 ? 1.0 : 0.6, conf: "h" }));
  });
  // MODIS Aqua sees the same fire in the same pass window -> merged as corroboration
  rows.push({ latitude: offsetLatLon(f.lat, f.lon, 300, 200)[0].toFixed(4), longitude: offsetLatLon(f.lat, f.lon, 300, 200)[1].toFixed(4), brightness: "338.40", bright_t31: "305.10", scan: "1.02", track: "1.01", acq_date: fmtDate(D1), acq_time: "0815", satellite: "Aqua", instrument: "MODIS", confidence: "88", version: "6.1NRT", frp: "402.30", daynight: "D", source: "MODIS_NRT" });
}
// 2. Korba — expanding industrial fire over two overpasses -> Alert (awaiting operator)
{
  const f = fac("FAC-003");
  rows.push(pixel({ lat: f.lat, lon: f.lon, east: 150, north: -100, t: D2, tfC: 1000, pPct: 0.6, conf: "h" }));
  for (const [e, n] of [[150, -100], [525, -100], [150, 275]] as [number, number][])
    rows.push(pixel({ lat: f.lat, lon: f.lon, east: e + jitter(), north: n + jitter(), t: N2, tfC: 1000, pPct: 0.6, conf: "h" }));
}
// 3. Haldia — single hot detection ~3x baseline, not expanding -> Watch
{
  const f = fac("FAC-009");
  rows.push(pixel({ lat: f.lat, lon: f.lon, east: -300, north: 200, t: N2, tfC: 900, pPct: 0.3, conf: "n" }));
}
// 4. Jamnagar — routine flare: tiny, very hot, static, on baseline -> persistent source
{
  const f = fac("FAC-002");
  for (const t of [D1, N1, D2, N2, D3]) rows.push(pixel({ lat: f.lat, lon: f.lon, east: -600 + jitter(), north: 400 + jitter(), t, tfC: 1250, pPct: 0.02, conf: "n" }));
}
// 5. Kakinada — pilot flare, one high-scan-angle pixel (flagged, confidence capped) -> persistent source
{
  const f = fac("FAC-005");
  rows.push(pixel({ lat: f.lat, lon: f.lon, east: 200, north: -150, t: N1, tfC: 1300, pPct: 0.015, conf: "n" }));
  rows.push(pixel({ lat: f.lat, lon: f.lon, east: 200 + jitter(), north: -150 + jitter(), t: D2, tfC: 1300, pPct: 0.015, conf: "h", scan: 0.72, track: 0.61 }));
  rows.push(pixel({ lat: f.lat, lon: f.lon, east: 200 + jitter(), north: -150 + jitter(), t: N2, tfC: 1300, pPct: 0.015, conf: "n" }));
}
// 6. Newly mapped facility — flare-like signature but no baseline -> persistent_source_unverified (manual review)
{
  const f = fac("FAC-015");
  for (const t of [N1, N2]) rows.push(pixel({ lat: f.lat, lon: f.lon, east: 100 + jitter(), north: 50 + jitter(), t, tfC: 1200, pPct: 0.03, conf: "n" }));
}
// 7. Ludhiana — linear stubble burn along field rows, in season (regional default calendar)
{
  const a = AREAS[0];
  for (const x of [-750, -375, 0, 375, 750]) rows.push(pixel({ lat: a.lat, lon: a.lon, east: x + jitter(), north: 200 + jitter(), t: D2, tfC: 400, pPct: 3, conf: "n" }));
  for (const x of [-375, 0, 375, 750]) rows.push(pixel({ lat: a.lat, lon: a.lon, east: x + jitter(), north: 200 + jitter(), t: D3, tfC: 380, pPct: 2.5, conf: "n" }));
}
// 8. Karnal — single field-bound pixel on crop=wheat farmland three days ago -> agricultural, extinguished
{
  const a = AREAS[1];
  rows.push(pixel({ lat: a.lat, lon: a.lon, east: 400, north: -300, t: D0, tfC: 420, pPct: 2.8, conf: "n" }));
}
// 9. Similipal — forest fire drifting north-east over four overpasses -> wildfire (irregular expansion)
{
  const a = AREAS[2];
  [D1, N1, D2, N2].forEach((t, k) => {
    const n = [1, 2, 4, 6][k];
    for (let i = 0; i < n; i++)
      rows.push(pixel({ lat: a.lat, lon: a.lon, east: 450 * k + 375 * (i % 3) + jitter(), north: 450 * k + 375 * Math.floor(i / 3) + jitter(), t, tfC: 750, pPct: 3, conf: "n" }));
  });
}
// 10. Uttarakhand — forest fire growing in place -> wildfire (radial expansion)
{
  const a = AREAS[3];
  const ring: [number, number][] = [[0, 0], [375, 0], [-375, 0], [0, 375], [0, -375]];
  [D2, N2, D3].forEach((t, k) => {
    const n = [1, 3, 5][k];
    for (let i = 0; i < n; i++) rows.push(pixel({ lat: a.lat, lon: a.lon, east: ring[i][0] + jitter(), north: ring[i][1] + jitter(), t, tfC: 700, pPct: 2.5, conf: "n" }));
  });
}
// 11-12. Jharia and Neyveli — low, sustained smoulder spread over the mine -> mining
{
  const j = fac("FAC-004");
  const spots: [number, number][] = [[-900, 300], [100, -600], [800, 500]];
  for (const t of [D2, D3]) for (const [e, n] of spots) rows.push(pixel({ lat: j.lat, lon: j.lon, east: e + jitter(), north: n + jitter(), t, tfC: 250, pPct: 0.5, conf: "n" }));
  const nv = fac("FAC-010");
  for (const t of [N1, D3]) rows.push(pixel({ lat: nv.lat, lon: nv.lon, east: -500 + jitter(), north: 700 + jitter(), t, tfC: 350, pPct: 0.5, conf: "n" }));
}
// 13. Built-up area with no mapped polygon, very hot -> unmapped_industrial_candidate
const UNMAPPED = { lat: 20.371, lon: 72.931 };
rows.push(pixel({ lat: UNMAPPED.lat, lon: UNMAPPED.lon, east: 0, north: 0, t: N2, tfC: 1100, pPct: 0.4, conf: "n" }));
// 14. Low-confidence pixel on a lake shore -> held as provisional
const PROVISIONAL = { lat: 19.72, lon: 85.318 };
rows.push(pixel({ lat: PROVISIONAL.lat, lon: PROVISIONAL.lon, east: 0, north: 0, t: D3, tfC: 500, pPct: 0.2, conf: "l" }));
// 15. Roadside heat, no polygon, not hot -> other
const OTHER = { lat: 23.0051, lon: 80.014 };
rows.push(pixel({ lat: OTHER.lat, lon: OTHER.lon, east: 0, north: 0, t: D2, tfC: 450, pPct: 0.3, conf: "n" }));

// Deliberately bad rows to exercise the quality gate (all rejected with a logged reason)
const good = rows[3];
rows.push({ ...good, bright_ti5: "" }); // missing band — never defaulted to zero
rows.push({ ...good, acq_time: "2575" }); // malformed time
rows.push({ ...good, acq_date: "2026-02-30" }); // impossible date
rows.push({ ...good, bright_ti4: "0" }); // implausible band value
rows.push({ ...good, latitude: "95.2" }); // invalid location
rows.push({ ...rows[3] }); // exact duplicate of an accepted row (idempotency key)

// ---------------------------------------------------------------- site history (12 months before the window)

const history: HistoryRecord[] = [];
function siteHistory(siteKey: string, lat: number, lon: number, opts: { days: number; months?: number[]; frp: [number, number]; spreadM: number; since?: string }) {
  const start = Date.parse(opts.since ?? "2025-04-21T00:00:00Z");
  const end = Date.parse("2026-04-19T00:00:00Z");
  const picked = new Set<number>();
  let guard = 0;
  while (picked.size < opts.days && guard++ < 100000) {
    const day = Math.floor(start / 86400000 + rand() * ((end - start) / 86400000));
    const month = new Date(day * 86400000).getUTCMonth() + 1;
    if (opts.months && !opts.months.includes(month)) continue;
    picked.add(day);
  }
  for (const day of [...picked].sort()) {
    const night = rand() < 0.5;
    const t = new Date(day * 86400000 + (night ? 20 * 3600000 : 8 * 3600000) + Math.floor(rand() * 40) * 60000);
    const [la, lo] = offsetLatLon(lat, lon, gauss(0, opts.spreadM / 2), gauss(0, opts.spreadM / 2));
    history.push({ siteKey, acqTime: t.toISOString().replace(".000Z", "Z"), lat: Number(la.toFixed(5)), lon: Number(lo.toFixed(5)), frpMW: Number(Math.max(0.5, gauss(...opts.frp)).toFixed(2)) });
  }
}
const at = (id: string, e: number, n: number) => offsetLatLon(fac(id).lat, fac(id).lon, e, n);
siteHistory("FAC-001", ...at("FAC-001", -500, 300), { days: 210, frp: [9, 1.5], spreadM: 150 });
siteHistory("FAC-002", ...at("FAC-002", -600, 400), { days: 300, frp: [8.6, 1], spreadM: 150 });
siteHistory("FAC-003", ...at("FAC-003", 150, -100), { days: 110, frp: [12, 3], spreadM: 200 });
siteHistory("FAC-005", ...at("FAC-005", 200, -150), { days: 250, frp: [6.8, 0.8], spreadM: 150 });
siteHistory("FAC-009", ...at("FAC-009", -300, 200), { days: 150, frp: [15, 3], spreadM: 200 });
siteHistory("FAC-004", ...at("FAC-004", 0, 0), { days: 320, frp: [4, 1], spreadM: 2400 });
siteHistory("FAC-010", ...at("FAC-010", -500, 700), { days: 280, frp: [5, 1.2], spreadM: 1800 });
siteHistory("FAC-015", ...at("FAC-015", 100, 50), { days: 25, frp: [11, 2], spreadM: 150, since: "2026-03-12T00:00:00Z" });
siteHistory("POLY-AGRI-LDH", AREAS[0].lat, AREAS[0].lon, { days: 34, months: [4, 5, 10, 11], frp: [18, 6], spreadM: 3000 });
siteHistory("POLY-AGRI-KNL", AREAS[1].lat, AREAS[1].lon, { days: 22, months: [4, 5, 10, 11], frp: [16, 5], spreadM: 3000 });
history.sort((a, b) => a.siteKey.localeCompare(b.siteKey) || a.acqTime.localeCompare(b.acqTime));

// ---------------------------------------------------------------- WorldCover sample layer

const landcover = [
  ...FACS.map((f) => ({ lat: f.lat, lon: f.lon, radiusKm: 3, worldCoverClass: f.tag === "quarry" ? "Bare / sparse vegetation" : "Built-up" })),
  { lat: AREAS[0].lat, lon: AREAS[0].lon, radiusKm: 10, worldCoverClass: "Cropland" },
  { lat: AREAS[1].lat, lon: AREAS[1].lon, radiusKm: 10, worldCoverClass: "Cropland" },
  { lat: AREAS[2].lat, lon: AREAS[2].lon, radiusKm: 15, worldCoverClass: "Tree cover" },
  { lat: AREAS[3].lat, lon: AREAS[3].lon, radiusKm: 12, worldCoverClass: "Tree cover" },
  { ...UNMAPPED, radiusKm: 2, worldCoverClass: "Built-up", place: "Unmapped built-up area near Vapi, Gujarat" },
  { ...PROVISIONAL, radiusKm: 2, worldCoverClass: "Permanent water bodies", place: "Chilika lake shore, Odisha" },
  { ...OTHER, radiusKm: 2, worldCoverClass: "Grassland", place: "Roadside near Jabalpur, Madhya Pradesh" },
];

// ---------------------------------------------------------------- Sentinel-1 sample (post-event check)

// unmapped events are keyed by the grid cell of their first detection (shared/buildEvents.ts)
const unmappedKey = `CELL-${UNMAPPED.lat.toFixed(2)}-${UNMAPPED.lon.toFixed(2)}`;
const sar: (SarCheck & { siteKey: string })[] = [
  { siteKey: "FAC-001", status: "supports", coherenceDrop: 0.42, preDate: "2026-04-17", postDate: "2026-04-23", detail: "Coherence loss between pre- and post-event passes over the process area; consistent with structural or surface change.", sample: true },
  { siteKey: "FAC-003", status: "pending", coherenceDrop: null, preDate: "2026-04-17", postDate: null, detail: "Post-event pass not yet acquired (revisit is days).", sample: true },
  { siteKey: "FAC-009", status: "does_not_support", coherenceDrop: 0.04, preDate: "2026-04-17", postDate: "2026-04-23", detail: "No coherence change over the flare area.", sample: true },
  { siteKey: unmappedKey, status: "sar_baseline_unavailable", coherenceDrop: null, preDate: null, postDate: "2026-04-23", detail: "No pre-event SAR baseline for this location.", sample: true },
];

// ---------------------------------------------------------------- write

const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 1) + "\n");
write("firms_raw.json", { note: "SAMPLE DATA — forward-modelled FIRMS VIIRS/MODIS rows (see scripts/gen-sample.ts)", referenceNow: REFERENCE_NOW, rows });
write("landuse_polygons.geojson", { type: "FeatureCollection", features: polygons });
write("facilities.json", facilities);
write("site_history.json", history);
write("landcover.json", landcover);
write("sentinel1_sample.json", sar);
console.log(`sample: ${rows.length} FIRMS rows, ${polygons.length} polygons, ${facilities.length} facilities, ${history.length} history records -> ${out}`);
