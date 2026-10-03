// Template-based situation report (plan Phase 7). Populated only from facility metadata, the Dozier
// range, CPCB category and the evidence list. An LLM may rephrase this text but never adds facts; if
// it fails, this raw template is what goes out. Numbers are written without thousands separators so
// the fact-preservation check in backend/llm.ts can compare them exactly.

import { CLASS_LABELS, TIER_LABELS } from "./labels.ts";
import type { SatEvent } from "./types.ts";

const r0 = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(Math.round(v)));

export function generateSitrep(ev: SatEvent): string {
  const c = ev.classification;
  const d = ev.dozier;
  const m = ev.context.match;
  const sample = ev.dataset === "sample";
  const L: string[] = [];
  L.push(`SITUATION REPORT${sample ? " [SAMPLE DATA]" : ""}`);
  L.push(`Event: ${ev.id}`);
  L.push(`Location: ${ev.placeName} (${ev.lat.toFixed(4)}, ${ev.lon.toFixed(4)})`);
  L.push(
    `Facility: ${m?.name ?? "none mapped"}${m ? ` | ${ev.context.facilityType ?? m.tag} | CPCB ${m.cpcbCategory ?? "unknown"} | source ${m.source}, refreshed ${m.refreshedAt.slice(0, 10)}` : ""}`,
  );
  L.push(`Detection window: ${ev.firstDetected} to ${ev.lastDetected} (${ev.observationCount} detections, ${ev.kinematics.overpasses} overpasses, lifecycle ${ev.lifecycle})`);
  L.push(`Classification: ${CLASS_LABELS[c.label]}${c.tier ? ` | Tier ${TIER_LABELS[c.tier]}` : ""} | Evidence score ${c.confidence.total}/100 (not a probability)`);
  L.push(`Rules fired: ${c.fired.length ? c.fired.join(", ") : "none"}`);
  L.push("");
  L.push(
    `Thermal: peak FRP ${r0(ev.peakFrpMW)} MW; Dozier ${d.status}${d.tfRangeC ? `, T_f range ${r0(d.tfRangeC[0])} to ${r0(d.tfRangeC[1])} C` : ""}${d.pRangePct ? `, area ${d.pRangePct[0]} to ${d.pRangePct[1]} percent of pixel` : ""}${d.saturated ? "; I4 saturated, T_f is a lower bound" : ""}.`,
  );
  L.push(
    `History: ${ev.history.coldStart ? `no baseline (${ev.history.coldStartReason})` : `pattern ${ev.history.pattern}, baseline ${r0(ev.history.baselineFrpMW)} MW, deviation ${ev.history.deviationX}x`}.`,
  );
  L.push(`Footprint: ${ev.kinematics.pattern}, ${ev.kinematics.expanding ? "expanding" : "not expanding"}${ev.kinematics.spreadBearingDeg !== null ? `, spreading toward ${ev.kinematics.spreadBearingDeg} deg` : ""}.`);
  L.push(`Post-event SAR: ${ev.sar.status}${ev.sar.sample ? " (sample data)" : ""}.`);
  L.push("");
  L.push("Evidence for:");
  for (const e of c.evidenceFor) L.push(`  + ${e}`);
  if (c.evidenceAgainst.length) {
    L.push("Evidence against / caution:");
    for (const e of c.evidenceAgainst) L.push(`  - ${e}`);
  }
  L.push("");
  L.push(`Action: ${c.action}`);
  if (c.tier === "code_red" || c.tier === "alert") {
    L.push("Verification: contact the plant control room, alert the district disaster cell, request the next satellite pass, send field reconnaissance. Satellite evidence alone is not confirmation.");
  }
  return L.join("\n");
}
