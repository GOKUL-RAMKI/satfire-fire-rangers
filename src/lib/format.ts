import { CLASS_ORDER } from "../../shared/labels.ts";
import type { ClassKey, DozierResult, Facility, SarStatus, SatEvent, Tier } from "../../shared/types.ts";

export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
};

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v.toFixed(digits)).toLocaleString();

export const fmtRange = (r: [number, number] | null, unit: string, digits = 0) =>
  r ? `${fmtNum(r[0], digits)}–${fmtNum(r[1], digits)} ${unit}` : "—";

/** Fire temperature, never as one bare number: central value plus range, or a lower bound. */
export function tfText(d: DozierResult): string {
  if (d.status === "unsolvable" || d.status === "invalid" || d.status === "not_applicable")
    return `${d.status.replaceAll("_", " ")} — no value guessed${d.saturated ? " (I4 saturated)" : ""}`;
  if (d.saturated) {
    const lb = d.tfRangeC?.[0] ?? d.tfCentralC;
    return lb !== null && lb !== undefined ? `≥ ${fmtNum(lb, 0)} °C (lower bound, I4 saturated)` : "lower bound only (I4 saturated)";
  }
  if (d.tfCentralC === null) return d.status.replaceAll("_", " ");
  const base = `≈ ${fmtNum(d.tfCentralC, 0)} °C (range ${fmtRange(d.tfRangeC, "°C")})`;
  // A degenerate-looking range (313.1–313.1 °C) is a display-precision artefact of a
  // genuinely narrow spread, usually with the default 300 K background — say so.
  if (d.tfRangeC && d.tfRangeC[0] === d.tfRangeC[1])
    return `${base} — spread below 0.1 °C precision${d.backgroundSource === "default_300K" ? " (default 300 K background, no neighbour pixels)" : ""}`;
  return base;
}

/** True when the 1-decimal T_f range renders as a degenerate-looking X–X display. */
export const isNarrowTfRange = (d: DozierResult): boolean =>
  d.tfRangeC !== null && d.tfRangeC !== undefined && d.tfRangeC[0] === d.tfRangeC[1];

export function pText(d: DozierResult): string {
  if (d.pCentralPct === null) return "—";
  return `≈ ${fmtNum(d.pCentralPct, 4)} % (range ${fmtRange(d.pRangePct, "%", 4)})`;
}

export const SAR_TEXT: Record<SarStatus, string> = {
  supports: "Supports the thermal classification",
  does_not_support: "Does not support the thermal classification",
  pending: "Pending (awaiting post-event pass)",
  not_requested: "Not requested",
  sar_baseline_unavailable: "sar_baseline_unavailable — no pre-event baseline",
  not_available: "Not available (live Sentinel-1 is roadmap)",
};

export const TIER_ORDER: Tier[] = ["code_red", "alert", "watch"];

export function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k === null || k === undefined) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function classCounts(events: SatEvent[]): { label: ClassKey; count: number }[] {
  const m = countBy(events, (e) => e.classification.label);
  return CLASS_ORDER.map((label) => ({ label, count: m.get(label) ?? 0 }));
}

export const lifecycleText = (e: SatEvent) =>
  e.lifecycle === "active" ? "active" : `${e.lifecycle} · ${fmtNum(e.quietHours, 0)} h quiet`;

export const eventsAtFacility = (events: SatEvent[], f: Facility) =>
  events.filter((e) => e.siteKey === f.id || e.context.match?.facilityId === f.id);
