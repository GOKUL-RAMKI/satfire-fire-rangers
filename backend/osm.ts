// Overpass lookup for the evidence panel's "nearby OSM features" list. This is a refresh / inspection
// path only: classification uses the bulk-loaded polygons, so a slow or rate-limited Overpass never
// sits on the critical path.

const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function osmContext(lat: number, lon: number) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const r = 1500;
  const query = `[out:json][timeout:8];(nwr(around:${r},${lat},${lon})["landuse"];nwr(around:${r},${lat},${lon})["industrial"];nwr(around:${r},${lat},${lon})["man_made"];nwr(around:${r},${lat},${lon})["power"="plant"];);out center tags;`;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "SATFIRE/3.0 (SIH26162 prototype)" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
    const payload = (await res.json()) as { elements: { type: string; id: number; tags?: Record<string, string> }[] };
    const features = payload.elements
      .filter((e) => e.tags && Object.keys(e.tags).length)
      .slice(0, 40)
      .map((e) => ({ type: e.type, id: e.id, name: e.tags?.name ?? null, tags: e.tags ?? {} }));
    const value = { source: "OpenStreetMap (Overpass, live lookup)", available: true, features };
    cache.set(key, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
    return value;
  } catch (e) {
    return { source: "OpenStreetMap (Overpass)", available: false, error: e instanceof Error ? e.message : String(e), features: [] };
  }
}
