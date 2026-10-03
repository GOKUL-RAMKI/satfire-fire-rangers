// Phase 1 data-quality gate. Runs before any physics.
//  * missing / implausible band values are rejected, never defaulted to zero
//  * malformed date/time fields are rejected with a logged reason
//  * high-scan-angle pixels are flagged and their confidence capped
//  * low-confidence detections are held as provisional (never dropped, never auto-escalated)
//  * duplicates on (sensor, acq_time, lat, lon) are rejected (idempotency key)
//  * MODIS seen with VIIRS in one pass window is merged into the VIIRS detection as corroboration

import { dozierNotApplicable, dozierUnmix } from "./dozier.ts";
import { haversineM } from "./geo.ts";
import type { Confidence, Dataset, Detection, FirmsRow, GateRejection, Instrument } from "./types.ts";

export const GATE = {
  viirsBandK: [200, 500] as const, // plausible brightness temperature range, K
  modisBandK: [200, 600] as const,
  viirsHighScanKm: 0.6, // nominal I-band pixel is 0.375 km at nadir
  modisHighScanKm: 2.0, // nominal MODIS pixel is 1 km at nadir
  mergeDistanceM: 1000,
  mergeWindowMin: 60,
  futureToleranceMin: 60,
};

export interface GateResult {
  detections: Detection[]; // accepted, including provisional, excluding merged MODIS rows
  rejections: GateRejection[];
  merged: number;
  duplicates: number;
}

const num = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function sensorOf(row: FirmsRow): { sensor: string; instrument: Instrument } | null {
  const src = (row.source ?? "").toUpperCase();
  const inst = (row.instrument ?? "").toUpperCase();
  const sat = (row.satellite ?? "").toUpperCase();
  if (src.startsWith("MODIS") || inst === "MODIS") {
    const s = sat.startsWith("T") ? "MODIS_TERRA" : sat.startsWith("A") ? "MODIS_AQUA" : "MODIS";
    return { sensor: s, instrument: "MODIS" };
  }
  if (src.startsWith("VIIRS") || inst === "VIIRS") {
    if (src.includes("NOAA21") || sat === "N21" || sat === "2") return { sensor: "VIIRS_NOAA21", instrument: "VIIRS" };
    if (src.includes("NOAA20") || sat === "N20" || sat === "1") return { sensor: "VIIRS_NOAA20", instrument: "VIIRS" };
    return { sensor: "VIIRS_SNPP", instrument: "VIIRS" };
  }
  return null;
}

/** Strict YYYY-MM-DD + HHMM parse. Returns null for anything malformed. */
export function parseAcqTime(date: string | undefined, time: string | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  if (time === undefined || !/^\d{1,4}$/.test(time.trim())) return null;
  const hhmm = time.trim().padStart(4, "0");
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(2));
  if (hh > 23 || mm > 59) return null;
  const [y, mo, d] = date.trim().split("-").map(Number);
  const t = Date.UTC(y, mo - 1, d, hh, mm);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return check.toISOString().replace(".000Z", "Z");
}

function confidenceOf(raw: string | undefined, instrument: Instrument): Confidence | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (instrument === "MODIS") {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < 0 || n > 100) return null;
    return n < 30 ? "l" : n < 80 ? "n" : "h"; // FIRMS MODIS confidence classes
  }
  if (v === "l" || v === "low") return "l";
  if (v === "n" || v === "nominal") return "n";
  if (v === "h" || v === "high") return "h";
  return null;
}

export function detectionKey(sensor: string, acqTime: string, lat: number, lon: number): string {
  return `${sensor}|${acqTime}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
}

export function runQualityGate(rows: FirmsRow[], dataset: Dataset, now: Date = new Date()): GateResult {
  const rejections: GateRejection[] = [];
  const seen = new Set<string>();
  const accepted: Detection[] = [];
  let duplicates = 0;

  rows.forEach((row, rowIndex) => {
    const reject = (reason: string, detail: string) =>
      rejections.push({ rowIndex, reason, detail, source: row.source ?? null });

    const s = sensorOf(row);
    if (!s) return reject("unknown_sensor", `instrument=${row.instrument ?? ""} source=${row.source ?? ""}`);
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return reject("invalid_location", `lat=${row.latitude ?? ""} lon=${row.longitude ?? ""}`);

    const acqTime = parseAcqTime(row.acq_date, row.acq_time);
    if (!acqTime) return reject("malformed_timestamp", `acq_date=${row.acq_date ?? ""} acq_time=${row.acq_time ?? ""}`);
    if (Date.parse(acqTime) > now.getTime() + GATE.futureToleranceMin * 60000)
      return reject("future_timestamp", acqTime);

    const viirs = s.instrument === "VIIRS";
    const b4 = num(viirs ? row.bright_ti4 : row.brightness);
    const b5 = num(viirs ? row.bright_ti5 : row.bright_t31);
    const [lo, hi] = viirs ? GATE.viirsBandK : GATE.modisBandK;
    if (b4 === null || b5 === null) return reject("missing_band", `I4/21=${row.bright_ti4 ?? row.brightness ?? ""} I5/31=${row.bright_ti5 ?? row.bright_t31 ?? ""}`);
    if (b4 < lo || b4 > hi || b5 < lo || b5 > hi) return reject("implausible_band", `b4=${b4} b5=${b5} outside ${lo}-${hi} K`);

    const frp = num(row.frp);
    if (frp === null || frp < 0) return reject("invalid_frp", `frp=${row.frp ?? ""}`);

    const flags: string[] = [];
    let confidence = confidenceOf(row.confidence, s.instrument);
    if (confidence === null) {
      flags.push("unrecognised_confidence");
      confidence = "l";
    }
    const scan = num(row.scan);
    const track = num(row.track);
    if (scan !== null && scan > (viirs ? GATE.viirsHighScanKm : GATE.modisHighScanKm)) {
      flags.push("high_scan_angle");
      if (confidence === "h") {
        confidence = "n";
        flags.push("confidence_capped");
      }
    }
    const provisional = confidence === "l";
    if (provisional) flags.push("low_confidence_held");

    const id = detectionKey(s.sensor, acqTime, lat, lon);
    if (seen.has(id)) {
      duplicates++;
      return reject("duplicate", id);
    }
    seen.add(id);

    const dayNight = (row.daynight ?? "").toUpperCase() === "N" ? "N" : "D";
    const type = num(row.type);
    accepted.push({
      id,
      dataset,
      sensor: s.sensor,
      instrument: s.instrument,
      acqTime,
      lat,
      lon,
      brightI4K: b4,
      brightI5K: b5,
      frpMW: frp,
      scanKm: scan,
      trackKm: track,
      confidence,
      dayNight,
      staticSourceFlag: type === null ? null : type === 2,
      gateStatus: provisional ? "provisional" : "ok",
      gateFlags: flags,
      dozier: viirs
        ? dozierUnmix(b4, b5, { dayNight })
        : dozierNotApplicable("modis_not_mixed_into_viirs_solve"),
      corroboratedBy: [],
      match: null,
      runnerUps: [],
      bufferM: 150, // transient: overwritten by bufferFor() during attribution
    });
  });

  // VIIRS primary, MODIS as corroboration within one pass window
  const viirs = accepted.filter((d) => d.instrument === "VIIRS");
  const out: Detection[] = [];
  let merged = 0;
  for (const d of accepted) {
    if (d.instrument === "MODIS") {
      const t = Date.parse(d.acqTime);
      const partner = viirs.find(
        (v) =>
          Math.abs(Date.parse(v.acqTime) - t) <= GATE.mergeWindowMin * 60000 &&
          haversineM(v.lat, v.lon, d.lat, d.lon) <= GATE.mergeDistanceM,
      );
      if (partner) {
        partner.corroboratedBy.push(d.id);
        merged++;
        continue;
      }
    }
    out.push(d);
  }
  return { detections: out, rejections, merged, duplicates };
}
