// Small geodesy helpers. Distances use a local equirectangular projection around the query point,
// which is well under 1 % error at the sub-10 km scales used here (PostGIS uses the spheroid).

const R = 6371008.8; // mean Earth radius, m
const RAD = Math.PI / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Project lon/lat to metres in a local frame centred on (lat0, lon0). */
export function toLocalM(lat0: number, lon0: number, lat: number, lon: number): [number, number] {
  return [(lon - lon0) * RAD * R * Math.cos(lat0 * RAD), (lat - lat0) * RAD * R];
}

export function offsetLatLon(lat: number, lon: number, eastM: number, northM: number): [number, number] {
  return [lat + northM / (RAD * R), lon + eastM / (RAD * R * Math.cos(lat * RAD))];
}

type Ring = number[][]; // [lon, lat][]

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance in metres from a point to a polygon given as rings (outer first, then holes), lon/lat.
 * Returns 0 when the point is inside the polygon.
 */
export function pointPolygonDistanceM(lat: number, lon: number, rings: Ring[]): number {
  const local = rings.map((ring) => ring.map(([x, y]) => toLocalM(lat, lon, y, x)));
  const [outer, ...holes] = local;
  if (outer && pointInRing(0, 0, outer) && !holes.some((h) => pointInRing(0, 0, h))) return 0;
  let best = Infinity;
  for (const ring of local) {
    for (let i = 0; i < ring.length - 1; i++) {
      best = Math.min(best, segDist(0, 0, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]));
    }
  }
  return best;
}

export function polygonsOf(
  geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] },
): number[][][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

export function bboxOf(polys: number[][][][]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  return [minX, minY, maxX, maxY];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
