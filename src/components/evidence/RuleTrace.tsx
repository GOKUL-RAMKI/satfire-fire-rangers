import { CLASS_LABELS, PRECEDENCE, RULE_TO_CLASS } from "../../../shared/labels.ts";
import type { Classification, RuleId } from "../../../shared/types.ts";
import { Section } from "../panels";

const RULE_NAMES: Record<RuleId, string> = {
  industrial_fire: "Industrial fire",
  industrial_watch: "Industrial watch",
  wildfire: "Wildfire",
  agri_off_season: "Agricultural (off-season)",
  mining: "Mining",
  persistent_source: "Persistent source",
  persistent_source_unverified: "Persistent source (unverified)",
  agri_in_season: "Agricultural (in-season)",
};

export function RuleTraceSection({ c }: { c: Classification }) {
  const early = c.ruleTrace.length === 0;
  return (
    <Section title="Rule trace">
      {early && (
        <div className="mb-2 rounded bg-amber-50 p-2 text-[11px] text-amber-900 ring-1 ring-amber-600/30">
          Rules not evaluated: the event was routed to <b>{CLASS_LABELS[c.label]}</b> before the rule table
          {c.label === "provisional"
            ? " (held by the quality gate or no usable Dozier solve)."
            : c.label === "unmapped_industrial_candidate"
              ? " (hot signature with no mapped land-use polygon or land-cover class)."
              : "."}
        </div>
      )}
      <ol className="space-y-1">
        {PRECEDENCE.map((rule, i) => {
          const t = c.ruleTrace.find((r) => r.rule === rule);
          const win = c.winningRule === rule;
          const fired = t?.fired ?? false;
          return (
            <li
              key={rule}
              className={`grid grid-cols-[1.25rem_1fr] gap-x-2 rounded px-2 py-1 text-xs ${
                win ? "bg-ink text-paper" : fired ? "bg-amber-100/70 text-ink" : "text-mute"
              }`}
            >
              <span className="font-mono" aria-label={fired ? "fired" : "not fired"}>
                {fired ? "✓" : "·"}
              </span>
              <span>
                <span className="font-mono text-[10px] opacity-70">{i + 1}.</span>{" "}
                <span className="font-semibold">{RULE_NAMES[rule]}</span>
                <span className="opacity-70"> → {CLASS_LABELS[RULE_TO_CLASS[rule]]}</span>
                {win && <span className="ml-2 font-mono text-[10px] uppercase">winning rule</span>}
                <span className={`block font-mono text-[10.5px] ${win ? "text-paper/80" : "text-faint"}`}>
                  {t ? t.detail : "not evaluated"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 font-mono text-[10.5px] text-faint">
        precedence: industrial_fire &gt; industrial_watch &gt; wildfire &gt; agri_off_season &gt; mining &gt; persistent_source &gt;
        persistent_source_unverified &gt; agri_in_season &gt; other
      </div>
      <div className="mt-1 text-[11px] text-mute">
        Fired: {c.fired.length ? c.fired.join(", ") : "none"} · winning rule: {c.winningRule ?? "none (→ " + CLASS_LABELS[c.label] + ")"}
      </div>
    </Section>
  );
}

export function CodeRedSection({ c }: { c: Classification }) {
  const cr = c.codeRedRule;
  return (
    <Section
      title="Code Red explicit rule"
      right={
        <span className={`font-mono text-[10px] uppercase ${cr.satisfied ? "text-red-800" : "text-mute"}`}>
          {cr.satisfied ? "satisfied" : "not satisfied"}
        </span>
      }
    >
      <div className="grid gap-1.5 sm:grid-cols-2">
        {cr.checks.map((ch) => (
          <div key={ch.name} className={`rounded p-2 text-xs ring-1 ${ch.ok ? "bg-emerald-50 ring-emerald-700/30" : "bg-ink/5 ring-rule"}`}>
            <div className="flex items-center gap-1.5 font-semibold capitalize">
              <span className={ch.ok ? "text-emerald-800" : "text-faint"}>{ch.ok ? "✓" : "✗"}</span> {ch.name}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] text-mute">{ch.detail}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-mute">
        Tier reason: {c.tierReason}
      </div>
      <div className="mt-1 text-[11px] italic text-faint">
        SAR is post-event confirmation only and is not part of the Code Red trigger.
      </div>
    </Section>
  );
}
