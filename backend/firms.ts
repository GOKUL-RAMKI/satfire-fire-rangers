// NASA FIRMS area API client. VIIRS 375 m (S-NPP, NOAA-20, NOAA-21) is the primary feed; MODIS 1 km
// is secondary (merged as corroboration by the quality gate). The key stays on the server.

import type { FirmsRow } from "../shared/types.ts";

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim() ?? ""]));
  });
}

export async function fetchFirmsSource(key: string, source: string, bbox: string, dayRange: number, date?: string, fetchFn: typeof fetch = fetch): Promise<FirmsRow[]> {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/${bbox}/${dayRange}${date ? `/${date}` : ""}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`FIRMS ${source} returned ${res.status}`);
  const text = await res.text();
  if (/invalid|error/i.test(text.slice(0, 200)) && !text.includes("latitude")) throw new Error(`FIRMS ${source}: ${text.slice(0, 120)}`);
  return parseCsv(text).map((r) => ({ ...r, source }));
}

/** Fetch every configured source; one failing source does not lose the others. */
export async function fetchFirms(opts: { key: string; sources: string[]; bbox: string; dayRange: number }): Promise<{ rows: FirmsRow[]; errors: string[] }> {
  const rows: FirmsRow[] = [];
  const errors: string[] = [];
  for (const source of opts.sources) {
    try {
      rows.push(...(await fetchFirmsSource(opts.key, source, opts.bbox, opts.dayRange)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { rows, errors };
}
