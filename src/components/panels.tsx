import type { ReactNode } from "react";
import type { PipelineStatus } from "../../shared/types.ts";
import { fmtNum, fmtTime } from "../lib/format";
import { SampleBadge } from "./badges";

export function StatCard({
  label,
  value,
  sub,
  accent = "#1d1b16",
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="border-t-2 pt-2" style={{ borderColor: accent }}>
      <div className="font-mono text-[10px] uppercase text-mute">{label}</div>
      <div className="mt-1 font-mono text-3xl font-medium" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

export function Section({
  title,
  right,
  children,
  className = "",
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded border border-rule bg-card p-4 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-mute">{title}</h3>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-rule py-1.5 text-xs last:border-0">
      <span className="shrink-0 text-mute">{k}</span>
      <span className="text-right font-mono text-ink">{v}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-rule p-4 text-center text-xs text-mute">{children}</div>;
}

type Row = { k: string; v: ReactNode; tone?: "bad" | "warn"; sample?: boolean };

function statusRows(s: PipelineStatus): Row[] {
  const run = s.lastRun;
  const llm = s.llm;
  return [
    {
      k: "Thermal feed",
      v: s.sample
        ? "Sample FIRMS rows (backend sample dataset)"
        : s.firmsConfigured
          ? "NASA FIRMS (live key configured)"
          : "FIRMS key not configured",
      tone: !s.sample && !s.firmsConfigured ? "bad" : undefined,
      sample: s.sample,
    },
    {
      k: "Last pipeline run",
      v: run
        ? `${fmtTime(run.at)} · ${run.rows} rows · ${run.accepted} accepted · ${run.rejected} rejected · ${run.provisional} provisional · ${run.events} events`
        : "no run yet",
      tone: run ? undefined : "warn",
    },
    ...(run?.firmsError ? [{ k: "FIRMS error", v: run.firmsError, tone: "bad" as const }] : []),
    {
      k: "Heartbeat",
      v: s.heartbeat.lastSuccessfulPull
        ? `last pull ${fmtTime(s.heartbeat.lastSuccessfulPull)} (${fmtNum(s.heartbeat.ageMinutes, 0)} min ago)`
        : "no successful pull recorded",
      tone: s.heartbeat.warning ? "bad" : undefined,
    },
    { k: "Spatial join", v: s.spatialBackend === "postgis" ? "PostGIS (ST_DWithin)" : "in-memory index (no database)", tone: s.spatialBackend === "memory" ? "warn" : undefined },
    { k: "Event store", v: s.store === "postgis" ? "PostGIS" : "local file store", tone: s.store === "file" ? "warn" : undefined },
    {
      k: "Land-use polygons",
      v: `${s.polygons.source} · ${s.polygons.count} polygons${s.polygons.refreshedAt ? ` · refreshed ${fmtTime(s.polygons.refreshedAt)}` : ""}`,
      sample: s.polygons.sample,
    },
    { k: "WorldCover", v: s.worldCover === "sample" ? "sample land-cover points" : "unavailable", sample: s.worldCover === "sample", tone: s.worldCover === "unavailable" ? "warn" : undefined },
    { k: "Site history", v: `${s.history.source} · baselines: ${s.history.baselines}`, sample: /sample/i.test(s.history.source) },
    { k: "Sentinel-1 SAR", v: s.sar === "sample" ? "sample post-event results" : "not available (roadmap)", sample: s.sar === "sample" },
    {
      k: "LLM phrasing",
      v: llm.enabled
        ? `${llm.model} · ${llm.callsLastHour}/${llm.ceilings.perHour} per h · ${llm.callsToday}/${llm.ceilings.perDay} per day · $${fmtNum(llm.spendTodayUsd, 2)}/$${fmtNum(llm.ceilings.dailyBudgetUsd, 2)}`
        : llm.configured
          ? "configured but disabled — template SITREPs"
          : "not configured — template SITREPs",
    },
    { k: "Webhook dispatch", v: s.webhookConfigured ? "configured (DB-first, retried with backoff)" : "not configured — alerts stored in DB only", tone: s.webhookConfigured ? undefined : "warn" },
    {
      k: "Scheduler",
      v: s.scheduler.enabled
        ? `windows ${s.scheduler.windowsUtc} UTC · ${s.scheduler.inWindow ? "in window" : "outside window"} · next ${fmtTime(s.scheduler.nextRunAt)}`
        : "disabled",
    },
    { k: "Gate rejections (last run)", v: String(s.rejections.length) },
  ];
}

export function DataStatusPanel({ status }: { status: PipelineStatus | null }) {
  return (
    <Section title="Data status" right={status ? <span className="font-mono text-[10px] text-faint">ref. {fmtTime(status.referenceNow)}</span> : undefined}>
      {!status ? (
        <div className="text-xs text-mute">Status unavailable.</div>
      ) : (
        statusRows(status).map((r) => (
          <div key={r.k} className="flex items-start justify-between gap-3 border-b border-rule py-1.5 text-xs last:border-0">
            <span className="shrink-0 text-mute">{r.k}</span>
            <span
              className={`flex flex-wrap items-center justify-end gap-1.5 text-right font-mono text-[11px] ${
                r.tone === "bad" ? "text-red-800" : r.tone === "warn" ? "text-amber-800" : "text-ink"
              }`}
            >
              {r.sample && <SampleBadge />}
              {r.v}
            </span>
          </div>
        ))
      )}
    </Section>
  );
}
