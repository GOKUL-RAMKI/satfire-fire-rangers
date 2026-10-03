import type { ReactNode } from "react";
import type { PipelineStatus } from "../../shared/types.ts";
import { SampleBadge } from "../components/badges";
import { DataStatusPanel, Section } from "../components/panels";
import { fmtTime } from "../lib/format";
import { useSatfire } from "../lib/store";

interface Stage {
  phase: string;
  title: string;
  detail: string;
  live: (s: PipelineStatus) => { text: ReactNode; sample?: boolean; warn?: boolean };
}

const STAGES: Stage[] = [
  {
    phase: "1",
    title: "FIRMS ingestion (VIIRS 375 m primary, MODIS corroboration)",
    detail: "Overpass-window scheduling; India bounding box (configurable).",
    live: (s) =>
      s.sample
        ? { text: "sample FIRMS rows", sample: true }
        : s.firmsConfigured
          ? { text: s.lastRun ? `last run ${fmtTime(s.lastRun.at)} · ${s.lastRun.rows} rows` : "no run yet", warn: !s.lastRun || Boolean(s.lastRun.firmsError) }
          : { text: "FIRMS key not configured", warn: true },
  },
  {
    phase: "1",
    title: "Data-quality gate",
    detail: "Rejects invalid bands and timestamps (never defaulted to zero), caps high-scan-angle confidence, merges VIIRS+MODIS, holds low-confidence detections as provisional, idempotent insert key.",
    live: (s) => ({ text: s.lastRun ? `${s.lastRun.accepted} accepted · ${s.lastRun.rejected} rejected · ${s.lastRun.provisional} provisional · ${s.lastRun.merged} merged · ${s.lastRun.duplicates} duplicates` : "no run yet" }),
  },
  {
    phase: "2",
    title: "Dozier two-band unmixing",
    detail: "T_f and sub-pixel fraction p solved per detection across a background band; range reported, saturation → lower bound, unsolvable → flagged.",
    live: () => ({ text: "computed per detection at ingestion" }),
  },
  {
    phase: "3",
    title: "Spatial join (OSM polygons, WorldCover, facility records)",
    detail: "Dozier-shrunk footprint buffer, nearest-first tie-break with runner-ups, unmapped-industrial state, attribution version.",
    live: (s) => ({
      text: `${s.spatialBackend === "postgis" ? "PostGIS ST_DWithin" : "in-memory index"} · ${s.polygons.count} polygons (${s.polygons.source})`,
      sample: s.polygons.sample,
      warn: s.spatialBackend === "memory",
    }),
  },
  {
    phase: "3",
    title: "Site history & baselines",
    detail: "Active days, span, seasonality, recurrence; cold start (< 3 months or newly mapped) → no baseline, manual review.",
    live: (s) => ({ text: `${s.history.source} · baselines: ${s.history.baselines}`, sample: /sample/i.test(s.history.source) }),
  },
  {
    phase: "4",
    title: "Rule classifier (precedence, evidence score, seasonal prior)",
      detail: "industrial_fire > industrial_watch > wildfire > agri_off_season > mining > mining_cold_start > persistent_source > persistent_source_unverified > agri_in_season > other. Every fired rule is logged.",
    live: () => ({ text: "transparent rules, computed per event" }),
  },
  {
    phase: "5",
    title: "Event lifecycle & de-duplication",
    detail: "Overpass-aware linking; extinguished only after an extended quiet window; FRP trend as a supporting signal.",
    live: (s) => ({ text: s.lastRun ? `${s.lastRun.events} events on last run` : "no run yet" }),
  },
  {
    phase: "6",
    title: "Post-event check — Sentinel-1 SAR coherence",
    detail: "Reported as supports / does not support; never part of the Code Red trigger; sar_baseline_unavailable recorded, never skipped.",
    live: (s) => (s.sar === "sample" ? { text: "sample results", sample: true } : { text: "not available (live fetch is roadmap)", warn: true }),
  },
  {
    phase: "7",
    title: "Alert tiers → dashboard + DB-first webhook, SITREP",
    detail: "Watch / Alert / Code Red; alert stored before dispatch, retried with backoff; template SITREP, LLM rephrases only, template on failure.",
    live: (s) => ({
      text: `webhook ${s.webhookConfigured ? "configured" : "not configured"} · LLM ${s.llm.enabled ? `${s.llm.model} (ceilings ${s.llm.ceilings.perHour}/h, ${s.llm.ceilings.perDay}/day)` : "off — template only"}`,
      warn: !s.webhookConfigured,
    }),
  },
  {
    phase: "8",
    title: "Continuous learning & evaluation",
    detail: "Operator confirm/reject builds the gold set; backtest reports per-class precision/recall and false alerts per week. A learned model replaces the rules only if it beats them on the gold set.",
    live: () => ({ text: "gold set from operator reviews; learned model deferred" }),
  },
];

const ROADMAP = [
  "INSAT geostationary between-overpass tracking (~30 min cadence, ~4 km pixels)",
  "Live Sentinel-1 fetch and coherence processing; backscatter change",
  "Wind as a classifier feature; indicative downwind wedge (not a dispersion model)",
  "Learned classifier once the gold set meets the Phase 8 criteria",
  "Celery/Redis scale-out, role-based access with audit log",
];

export default function ArchitecturePage() {
  const { status } = useSatfire();
  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-bold text-ink">SATFIRE v3 pipeline</h1>
        <p className="max-w-3xl text-xs leading-relaxed text-mute">
          Node/TypeScript backend with one shared engine (quality gate, Dozier, spatial join, history, kinematics, classifier) used by the API, scripts and tests.
          Status on the right of each stage is read from <span className="font-mono">/api/status</span>; sample layers are labelled.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Section title="Pipeline — live status" className="xl:col-span-2">
          <ol className="space-y-1.5">
            {STAGES.map((st, i) => {
              const live = status ? st.live(status) : null;
              return (
                <li key={st.title}>
                  <div className="grid gap-2 rounded border border-rule bg-paper/40 p-2.5 text-xs md:grid-cols-[2.5rem_1fr_minmax(12rem,18rem)]">
                    <span className="font-mono text-[10px] uppercase text-faint">Ph {st.phase}</span>
                    <div>
                      <div className="font-semibold text-ink">{st.title}</div>
                      <div className="text-[11px] text-mute">{st.detail}</div>
                    </div>
                    <div className={`flex flex-wrap items-start gap-1.5 font-mono text-[10.5px] ${live?.warn ? "text-amber-800" : "text-ink"}`}>
                      {live?.sample && <SampleBadge />}
                      {live ? live.text : "status unavailable"}
                    </div>
                  </div>
                  {i < STAGES.length - 1 && <div className="text-center text-[10px] text-faint">▼</div>}
                </li>
              );
            })}
          </ol>
        </Section>
        <div className="space-y-3">
          <DataStatusPanel status={status} />
          <Section title="Roadmap (not in the prototype)">
            <ul className="list-disc space-y-1 pl-4 text-xs text-mute">
              {ROADMAP.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
