// Live WorldCover fallback: ESA WorldCover v200 point samples at live CELL
// sites (scripts/sample-worldcover.ts), stored git-ignored in
// data/runtime/landcover_live.json. Same LandcoverPoint mechanism as the sample
// landcover.json; the pipeline prefers it for live when present and reports
// "unavailable" otherwise (today's behaviour is preserved when the file is missing).
// Node-only: the backend and scripts use this; nothing here ships to the browser.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LandcoverPoint } from "../shared/spatial.ts";

export interface LiveLandcover {
  points: LandcoverPoint[];
  /** Human-readable provenance for status output. */
  source: string;
  refreshedAt: string | null;
}

let cache: { key: string; layer: LiveLandcover } | null = null;

export function loadLiveLandcover(root: string): LiveLandcover | null {
  const path = join(root, "data", "runtime", "landcover_live.json");
  if (!existsSync(path)) return null;
  let key: string;
  try {
    const s = statSync(path);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
  if (cache && cache.key === key) return cache.layer;
  let points: LandcoverPoint[];
  try {
    points = JSON.parse(readFileSync(path, "utf8")) as LandcoverPoint[];
  } catch {
    return null;
  }
  const layer: LiveLandcover = {
    points,
    source: "ESA WorldCover v200 point samples (data/runtime/landcover_live.json)",
    refreshedAt: null,
  };
  cache = { key, layer };
  return layer;
}

export function clearLiveLandcoverCache(): void {
  cache = null;
}
