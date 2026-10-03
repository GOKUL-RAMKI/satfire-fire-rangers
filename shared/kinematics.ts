// Spatial / kinematic behaviour of an event's detections (Phase 4 inputs, Phase 6 clustering).
// Starting thresholds, to be tuned on data.

import { bearingDeg, haversineM, round, toLocalM } from "./geo.ts";
import type { Detection, Kinematics, SpatialPattern } from "./types.ts";

export const KIN = {
  overpassGapMin: 30, // detections within 30 min of the first in a group are one overpass
  compactSpreadM: 750, // ~2 VIIRS I-band pixels
  spreadGrowthM: 750, // footprint must grow by 2+ pixels to count as expansion
  linearElongation: 3,
  driftFraction: 0.4, // centroid drift / spread above this = irregular (moving front)
  minBearingShiftM: 150,
};

function maxPairwiseM(points: { lat: number; lon: number }[]): number {
  let best = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      best = Math.max(best, haversineM(points[i].lat, points[i].lon, points[j].lat, points[j].lon));
  return best;
}

function centroid(points: { lat: number; lon: number }[]) {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
}

/** sqrt of the ratio of principal-axis variances; 1 = round, large = line-like. */
function elongation(points: { lat: number; lon: number }[]): number {
  if (points.length < 3) return 1;
  const c = centroid(points);
  const xy = points.map((p) => toLocalM(c.lat, c.lon, p.lat, p.lon));
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of xy) {
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  sxx /= xy.length;
  syy /= xy.length;
  sxy /= xy.length;
  const tr = sxx + syy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(tr / 2 - disc, 150 ** 2); // floor at sub-pixel geolocation noise
  return Math.sqrt(l1 / l2);
}

export function groupOverpasses(detections: Detection[]): Detection[][] {
  const sorted = [...detections].sort((a, b) => Date.parse(a.acqTime) - Date.parse(b.acqTime));
  const groups: Detection[][] = [];
  for (const d of sorted) {
    const g = groups[groups.length - 1];
    if (g && Date.parse(d.acqTime) - Date.parse(g[0].acqTime) <= KIN.overpassGapMin * 60000) g.push(d);
    else groups.push([d]);
  }
  return groups;
}

export function analyseKinematics(detections: Detection[]): Kinematics {
  const groups = groupOverpasses(detections);
  const cumulative: Detection[] = [];
  const overpassSeries = groups.map((g) => {
    cumulative.push(...g);
    return {
      t: g[0].acqTime,
      pixels: g.length,
      frpMW: round(g.reduce((s, d) => s + d.frpMW, 0), 1),
      spreadM: Math.round(maxPairwiseM(cumulative)),
    };
  });
  const first = overpassSeries[0];
  const last = overpassSeries[overpassSeries.length - 1];
  const spreadM = Math.round(maxPairwiseM(detections));
  const firstSpread = Math.round(maxPairwiseM(groups[0]));
  const spreadGrowthM = spreadM - firstSpread;
  const pixelGrowth = round(last.pixels / first.pixels, 2);
  const expanding =
    groups.length >= 2 &&
    (last.pixels >= first.pixels + 2 || (pixelGrowth >= 2 && last.pixels >= 3) || spreadGrowthM >= KIN.spreadGrowthM);

  const c0 = centroid(groups[0]);
  const c1 = centroid(groups[groups.length - 1]);
  const shiftM = haversineM(c0.lat, c0.lon, c1.lat, c1.lon);
  const elong = round(elongation(detections), 2);

  let pattern: SpatialPattern;
  if (detections.length === 1) pattern = "single-pixel";
  else if (expanding) pattern = shiftM >= KIN.driftFraction * Math.max(spreadM, 1) ? "irregular-expansion" : "radial-expansion";
  else if (detections.length >= 3 && elong >= KIN.linearElongation) pattern = "linear-field";
  else pattern = spreadM <= KIN.compactSpreadM ? "static-compact" : "dispersed";

  return {
    pattern,
    expanding,
    pixels: detections.length,
    overpasses: groups.length,
    spreadM,
    elongation: elong,
    pixelGrowth,
    spreadGrowthM,
    spreadBearingDeg: shiftM >= KIN.minBearingShiftM ? Math.round(bearingDeg(c0.lat, c0.lon, c1.lat, c1.lon)) : null,
    overpassSeries,
  };
}
