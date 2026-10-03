// Seasonal prior for agricultural burning and the brick-kiln operating season.
// Most OSM farmland lacks crop/season tags, so a regional default calendar applies and the record is
// marked seasonal_baseline=regional_default, which lowers its weight in the confidence score.

import type { SeasonInfo } from "./types.ts";

type Window = [startMonth: number, startDay: number, endMonth: number, endDay: number]; // inclusive, 1-based months

interface Region {
  name: string;
  bbox: [minLat: number, maxLat: number, minLon: number, maxLon: number];
  windows: Window[];
}

// Starting calendars, to be tuned on data (plan Phase 4). Sources: residue-burning seasons for the
// rice–wheat belt (paddy stubble Oct–Nov, wheat stubble Apr–May); broader default for the rest of India.
const REGIONS: Region[] = [
  {
    name: "Punjab–Haryana–Delhi–western UP rice–wheat belt",
    bbox: [28.4, 32.6, 73.8, 78.4],
    windows: [
      [4, 1, 5, 31],
      [10, 1, 11, 30],
    ],
  },
];
const DEFAULT_REGION: Region = {
  name: "India regional default",
  bbox: [-90, 90, -180, 180],
  windows: [
    [3, 1, 5, 31],
    [10, 1, 12, 15],
  ],
};

const CROP_WINDOWS: Record<string, Window[]> = {
  rice: [[10, 1, 11, 30]],
  paddy: [[10, 1, 11, 30]],
  wheat: [[4, 1, 5, 31]],
  sugarcane: [
    [11, 1, 12, 31],
    [1, 1, 3, 31],
  ],
};

// Brick kilns in India typically fire through the dry season (roughly Nov–Jun) and shut for the monsoon.
const KILN_WINDOWS: Window[] = [
  [11, 1, 12, 31],
  [1, 1, 6, 30],
];

function inWindows(iso: string, windows: Window[]): boolean {
  const d = new Date(iso);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return windows.some(([sm, sd, em, ed]) => md >= sm * 100 + sd && md <= em * 100 + ed);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (ws: Window[]) => ws.map(([sm, sd, em, ed]) => `${sd} ${MONTHS[sm - 1]}–${ed} ${MONTHS[em - 1]}`).join(", ");

export function agriSeason(iso: string, lat: number, lon: number, osmTags: Record<string, string> = {}): SeasonInfo {
  const crop = (osmTags.crop ?? "").toLowerCase().split(/[;,]/).map((c) => c.trim()).find((c) => CROP_WINDOWS[c]);
  if (crop) {
    const windows = CROP_WINDOWS[crop];
    return { inSeason: inWindows(iso, windows), baseline: "osm_crop_tag", region: `OSM crop=${crop}`, windows: fmt(windows) };
  }
  const region =
    REGIONS.find((r) => lat >= r.bbox[0] && lat <= r.bbox[1] && lon >= r.bbox[2] && lon <= r.bbox[3]) ?? DEFAULT_REGION;
  return { inSeason: inWindows(iso, region.windows), baseline: "regional_default", region: region.name, windows: fmt(region.windows) };
}

export function inKilnSeason(iso: string): boolean {
  return inWindows(iso, KILN_WINDOWS);
}
