import { CLASS_COLORS, CLASS_LABELS, SEVERITY_COLORS, TIER_LABELS } from "../../shared/labels.ts";
import type { ClassKey, DispatchStatus, Lifecycle, Severity, Tier } from "../../shared/types.ts";

export function ClassBadge({ label }: { label: ClassKey }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 border-l-2 bg-ink/5 px-2 py-0.5 font-mono text-[11px] uppercase text-ink"
      style={{ borderColor: CLASS_COLORS[label] }}
    >
      {CLASS_LABELS[label]}
    </span>
  );
}

const TIER_COLORS: Record<Tier, string> = { watch: "#a16207", alert: "#c2570c", code_red: "#b42318" };

export function TierBadge({ tier }: { tier: Tier | null }) {
  if (!tier) return <span className="font-mono text-[10px] uppercase text-faint">no tier</span>;
  const c = TIER_COLORS[tier];
  const solid = tier === "code_red";
  return (
    <span
      className="inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
      style={solid ? { background: c, borderColor: c, color: "#fff" } : { color: c, borderColor: c }}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const c = SEVERITY_COLORS[severity];
  return (
    <span className="inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase" style={{ color: c, borderColor: c }}>
      {severity}
    </span>
  );
}

const LIFECYCLE_STYLE: Record<Lifecycle, string> = {
  active: "bg-red-700/10 text-red-800",
  quiet: "bg-amber-600/10 text-amber-800",
  extinguished: "bg-rule text-mute",
};

export function LifecycleBadge({ lifecycle, quietHours }: { lifecycle: Lifecycle; quietHours?: number }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 font-mono text-[10px] uppercase ${LIFECYCLE_STYLE[lifecycle]}`}>
      {lifecycle}
      {lifecycle !== "active" && quietHours !== undefined ? ` · ${Math.round(quietHours)}h quiet` : ""}
    </span>
  );
}

/** Checklist item #5: shown on every sample or fallback layer. */
export function SampleBadge({ title = "This layer is sample data, not a live observation" }: { title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center border border-amber-700 bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-900"
    >
      Sample data
    </span>
  );
}

/** Live fallback layer: real data, but point-sampled and coarser than the primary source. */
export function FallbackBadge({ title = "Fallback layer: real data at coarser resolution than the primary source" }: { title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center border border-sky-700/50 bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-900"
    >
      Fallback data
    </span>
  );
}

export function FlagChip({ flag }: { flag: string }) {
  const warn = /cold_start|off_season|held|regional_default|unsolvable|invalid|saturated|range_wide|background_default|capped|high_scan/.test(flag);
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] ${
        warn ? "border-amber-600/50 bg-amber-50 text-amber-900" : "border-rule bg-ink/5 text-mute"
      }`}
    >
      {flag}
    </span>
  );
}

export function ReviewBadge() {
  return (
    <span className="inline-flex items-center border border-sky-700/50 bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-sky-900">
      needs review
    </span>
  );
}

const DISPATCH_STYLE: Record<DispatchStatus, string> = {
  sent: "text-emerald-800 border-emerald-700/50",
  pending: "text-amber-800 border-amber-600/50",
  failed: "text-red-800 border-red-700/50",
  not_configured: "text-mute border-rule",
  not_dispatched: "text-mute border-rule",
  suppressed_sample: "text-amber-900 border-amber-700/50",
};

export function DispatchBadge({ status }: { status: DispatchStatus }) {
  return <span className={`inline-flex border px-1.5 py-0.5 font-mono text-[10px] uppercase ${DISPATCH_STYLE[status]}`}>{status.replaceAll("_", " ")}</span>;
}
