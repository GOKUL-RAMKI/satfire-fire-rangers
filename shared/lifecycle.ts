// Phase 5 event lifecycle and de-duplication.
// Detections close in space and time are linked into one event (DBSCAN-style, minPts = 1).
// The linking window is overpass-aware: it spans a missed overpass pair, so a cloudy pass does not
// split one fire into two events. An event is "extinguished" only after an extended quiet window.

import { haversineM } from "./geo.ts";
import type { Detection, Lifecycle } from "./types.ts";

export const LIFECYCLE = {
  linkDistanceM: 1500,
  linkWindowH: 36, // VIIRS gives ~2 passes/day per satellite; 36 h tolerates one missed pass pair
  quietAfterH: 24,
  extinguishedAfterH: 72,
};

export function linkDetections(detections: Detection[]): Detection[][] {
  const n = detections.length;
  const parent = detections.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // grid hash so linking stays near-linear on national-scale feeds
  const cellDeg = 0.015; // ~1.6 km, >= link distance
  const grid = new Map<string, number[]>();
  const key = (i: number, j: number) => `${i}:${j}`;
  detections.forEach((d, idx) => {
    const k = key(Math.floor(d.lat / cellDeg), Math.floor(d.lon / cellDeg));
    const bucket = grid.get(k);
    if (bucket) bucket.push(idx);
    else grid.set(k, [idx]);
  });
  const windowMs = LIFECYCLE.linkWindowH * 3600000;
  detections.forEach((d, idx) => {
    const ci = Math.floor(d.lat / cellDeg), cj = Math.floor(d.lon / cellDeg);
    const t = Date.parse(d.acqTime);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const other of grid.get(key(ci + di, cj + dj)) ?? []) {
          if (other <= idx) continue;
          const o = detections[other];
          if (Math.abs(Date.parse(o.acqTime) - t) <= windowMs && haversineM(d.lat, d.lon, o.lat, o.lon) <= LIFECYCLE.linkDistanceM)
            union(idx, other);
        }
  });

  const groups = new Map<number, Detection[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(detections[i]);
    else groups.set(r, [detections[i]]);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => Date.parse(a.acqTime) - Date.parse(b.acqTime)));
}

export function lifecycleOf(lastDetected: string, now: Date): { lifecycle: Lifecycle; quietHours: number } {
  const quietHours = Math.max(0, (now.getTime() - Date.parse(lastDetected)) / 3600000);
  const lifecycle: Lifecycle =
    quietHours < LIFECYCLE.quietAfterH ? "active" : quietHours < LIFECYCLE.extinguishedAfterH ? "quiet" : "extinguished";
  return { lifecycle, quietHours: Math.round(quietHours * 10) / 10 };
}
