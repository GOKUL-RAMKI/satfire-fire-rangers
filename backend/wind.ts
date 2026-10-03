// Wind at an event for the INDICATIVE downwind wedge (plan Phase 7 roadmap item, checklist step 9).
// Open-Meteo, no key (non-commercial use). The wedge shows the direction responders should consider;
// it is not a dispersion model and not an evacuation zone. Wind is not a classifier feature.

export interface WindInfo {
  available: boolean;
  speedMs: number | null;
  fromDeg: number | null; // meteorological: direction the wind blows FROM
  toDeg: number | null; // downwind direction
  at: string | null;
  source: string;
  note: string;
}

const cache = new Map<string, WindInfo>();

export async function windAt(lat: number, lon: number, iso: string, live: boolean, fetchFn: typeof fetch = fetch): Promise<WindInfo> {
  const hour = iso.slice(0, 13);
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${live ? "now" : hour}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const note = "Indicative only — not a dispersion model or an evacuation zone.";
  try {
    let speed: number | undefined;
    let from: number | undefined;
    let at: string | undefined;
    let source: string;
    if (live) {
      const res = await fetchFn(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
      const j = (await res.json()) as { current?: { time: string; wind_speed_10m: number; wind_direction_10m: number } };
      speed = j.current?.wind_speed_10m;
      from = j.current?.wind_direction_10m;
      at = j.current?.time ? `${j.current.time}Z` : undefined;
      source = "Open-Meteo forecast (current 10 m wind)";
    } else {
      const day = iso.slice(0, 10);
      const res = await fetchFn(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) throw new Error(`Open-Meteo archive returned ${res.status}`);
      const j = (await res.json()) as { hourly?: { time: string[]; wind_speed_10m: (number | null)[]; wind_direction_10m: (number | null)[] } };
      const i = j.hourly?.time.findIndex((t) => t.startsWith(hour)) ?? -1;
      if (i >= 0) {
        speed = j.hourly?.wind_speed_10m[i] ?? undefined;
        from = j.hourly?.wind_direction_10m[i] ?? undefined;
        at = `${j.hourly?.time[i]}Z`;
      }
      source = "Open-Meteo historical reanalysis (10 m wind at the last detection hour)";
    }
    if (speed === undefined || from === undefined) throw new Error("no wind value for this time");
    const info: WindInfo = { available: true, speedMs: speed, fromDeg: from, toDeg: (from + 180) % 360, at: at ?? null, source, note };
    cache.set(key, info);
    return info;
  } catch (e) {
    // if a required reading is missing, omit the wedge instead of guessing (plan §6)
    return { available: false, speedMs: null, fromDeg: null, toDeg: null, at: null, source: "Open-Meteo", note: `Wind unavailable (${e instanceof Error ? e.message : String(e)}); wedge omitted.` };
  }
}
