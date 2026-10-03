// Phase 3 persistence engine: repeat detections at a site build a history (active days, span,
// seasonality, recurrence). Only records from BEFORE the event start are used, so the current event
// never leaks into its own baseline. A site with < 90 days of history, or one mapped < 90 days ago,
// gets no baseline (cold start) and is never auto-whitelisted.

import { haversineM, median, round } from "./geo.ts";
import type { HistoryPattern, HistoryRecord, SiteHistory } from "./types.ts";

export const HISTORY = {
  coldStartDays: 90,
  overpassBucketMin: 30,
  consistentMonths: 8,
  consistentMinDays: 60,
  seasonalShare: 0.8,
  seasonalMaxMonths: 4,
  smearSpreadM: 1000,
};

const DAY = 86400000;

/** Sum FRP per overpass (records within 30 min of each other at the site). */
export function perOverpassFrp(records: { acqTime: string; frpMW: number }[]): number[] {
  const sorted = [...records].sort((a, b) => Date.parse(a.acqTime) - Date.parse(b.acqTime));
  const out: number[] = [];
  let start = -Infinity;
  for (const r of sorted) {
    const t = Date.parse(r.acqTime);
    if (t - start > HISTORY.overpassBucketMin * 60000) {
      out.push(r.frpMW);
      start = t;
    } else out[out.length - 1] += r.frpMW;
  }
  return out;
}

export function computeSiteHistory(args: {
  siteKey: string;
  records: HistoryRecord[];
  eventStart: string;
  currentFrpMW: number;
  mappedSince: string | null;
  source: string;
  sample: boolean;
  baselineOverride?: { frpMW: number; source: "isolation_forest" } | null;
}): SiteHistory {
  const start = Date.parse(args.eventStart);
  const recs = args.records.filter((r) => Date.parse(r.acqTime) < start);
  const days = new Set(recs.map((r) => r.acqTime.slice(0, 10)));
  const months = new Set(recs.map((r) => r.acqTime.slice(0, 7)));
  const monthHistogram = Array.from({ length: 12 }, () => 0);
  for (const day of days) monthHistogram[Number(day.slice(5, 7)) - 1]++;

  const times = recs.map((r) => Date.parse(r.acqTime));
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;
  const spanDays = first !== null && last !== null ? Math.round((last - first) / DAY) : 0;

  let historySpreadM: number | null = null;
  if (recs.length >= 2) {
    const cLat = median(recs.map((r) => r.lat)) as number;
    const cLon = median(recs.map((r) => r.lon)) as number;
    const dists = recs.map((r) => haversineM(cLat, cLon, r.lat, r.lon)).sort((a, b) => a - b);
    historySpreadM = Math.round(2 * dists[Math.floor(0.9 * (dists.length - 1))]);
  }

  const calendarMonths = monthHistogram.filter((n) => n > 0).length;
  const topShare =
    days.size > 0 ? [...monthHistogram].sort((a, b) => b - a).slice(0, HISTORY.seasonalMaxMonths).reduce((s, n) => s + n, 0) / days.size : 0;
  let pattern: HistoryPattern = "NONE";
  if (days.size > 0) {
    if (calendarMonths >= HISTORY.consistentMonths && days.size >= HISTORY.consistentMinDays)
      pattern = (historySpreadM ?? 0) > HISTORY.smearSpreadM ? "LONG_SMEAR" : "CONSISTENT";
    else if (days.size >= 5 && topShare >= HISTORY.seasonalShare) pattern = "SEASONAL";
    else pattern = "SPORADIC";
  }

  const overpassFrp = perOverpassFrp(recs);
  const medianBaseline = median(overpassFrp);
  const baselineFrpMW = args.baselineOverride?.frpMW ?? medianBaseline;
  const baselineSource = args.baselineOverride ? "isolation_forest" : medianBaseline === null ? "none" : "median";

  let coldStartReason: string | null = null;
  if (!recs.length) coldStartReason = "no prior detections at this site";
  else if (spanDays < HISTORY.coldStartDays) coldStartReason = `history spans ${spanDays} days (< ${HISTORY.coldStartDays})`;
  else if (args.mappedSince && start - Date.parse(args.mappedSince) < HISTORY.coldStartDays * DAY)
    coldStartReason = `facility newly mapped (since ${args.mappedSince.slice(0, 10)})`;
  const coldStart = coldStartReason !== null || !baselineFrpMW;
  if (coldStart && !coldStartReason) coldStartReason = "baseline FRP unavailable";

  const recurrence =
    pattern === "NONE"
      ? "No prior thermal activity at this site"
      : `${days.size} active days across ${months.size} months; busiest months ${monthHistogram
          .map((n, i) => [n, i] as const)
          .filter(([n]) => n > 0)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 3)
          .map(([, i]) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i])
          .join(", ")}`;

  const series: SiteHistory["series"] = [];
  const s0 = new Date(start);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    const inMonth = recs.filter((r) => r.acqTime.startsWith(m));
    const med = median(perOverpassFrp(inMonth));
    series.push({
      month: m,
      activeDays: new Set(inMonth.map((r) => r.acqTime.slice(0, 10))).size,
      medianFrpMW: med === null ? null : round(med, 1),
    });
  }

  return {
    siteKey: args.siteKey,
    source: args.source,
    sample: args.sample,
    records: recs.length,
    activeDays: days.size,
    spanDays,
    firstSeen: first === null ? null : new Date(first).toISOString(),
    lastSeen: last === null ? null : new Date(last).toISOString(),
    monthsActive: months.size,
    monthHistogram,
    pattern,
    recurrence,
    historySpreadM,
    baselineFrpMW: baselineFrpMW === null ? null : round(baselineFrpMW, 1),
    baselineSource,
    currentFrpMW: round(args.currentFrpMW, 1),
    deviationX: coldStart || !baselineFrpMW ? null : round(args.currentFrpMW / baselineFrpMW, 1),
    coldStart,
    coldStartReason,
    series,
  };
}
