import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AlertKind } from "../../shared/types.ts";
import { ClassBadge, DispatchBadge, SampleBadge } from "../components/badges";
import { Empty, Section } from "../components/panels";
import { fmtTime } from "../lib/format";
import { useSatfire } from "../lib/store";
import { EventsTable } from "./EventsPage";

const KIND_STYLE: Record<AlertKind, string> = {
  code_red: "bg-red-700 text-white border-red-700",
  alert: "text-orange-800 border-orange-700/60",
  watch: "text-amber-800 border-amber-600/60",
  wildfire_route: "text-orange-900 border-orange-900/50",
};
const KINDS: AlertKind[] = ["code_red", "alert", "watch", "wildfire_route"];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export default function AlertsPage() {
  const { alerts, events, dataset, status } = useSatfire();
  const [kind, setKind] = useState<AlertKind | "all">("all");
  const queue = useMemo(
    () =>
      events
        .filter((e) => e.classification.needsReview)
        .sort(
          (a, b) =>
            (PRIORITY_ORDER[a.classification.reviewPriority ?? "medium"] - PRIORITY_ORDER[b.classification.reviewPriority ?? "medium"]) ||
            b.lastDetected.localeCompare(a.lastDetected),
        ),
    [events],
  );
  const rows = useMemo(
    () => [...alerts].filter((a) => kind === "all" || a.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [alerts, kind],
  );

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-bold text-ink">Alerts</h1>
        <p className="max-w-3xl text-xs text-mute">
          Every alert is written to the database first, then dispatched by webhook; failed dispatches are retried with backoff, so a failed webhook is never the only record.
          Webhook: {status ? (status.webhookConfigured ? "configured" : "not configured") : "unknown"}. Dataset: {dataset}.
        </p>
      </div>

      <Section title={`Review queue (${queue.length})`} right={<span className="text-[11px] text-faint">cold start, unmapped, provisional, other, off-season, unverified persistent</span>}>
        {queue.length ? <EventsTable events={queue} /> : <div className="text-xs text-faint">No events awaiting operator review.</div>}
      </Section>

      <Section
        title={`Alert records (${alerts.length})`}
        right={
          <label className="flex items-center gap-1.5 text-[11px] text-mute" htmlFor="kind-filter">
            Kind
            <select id="kind-filter" value={kind} onChange={(e) => setKind(e.target.value as AlertKind | "all")} className="border border-rule bg-card px-1.5 py-0.5 text-ink">
              <option value="all">All</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {rows.length === 0 ? (
          <Empty>No alert records{kind !== "all" ? " of this kind" : ""}.</Empty>
        ) : (
          <div className="space-y-2">
            {rows.map((a) => (
              <div key={a.id} className="rounded border border-rule bg-paper/50 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${KIND_STYLE[a.kind]}`}>{a.kind.replace("_", " ")}</span>
                  <ClassBadge label={a.label} />
                  {a.dataset === "sample" && <SampleBadge title="Alert raised on sample data" />}
                  <Link to={`/events/${encodeURIComponent(a.eventId)}`} className="font-mono text-[11px] text-cyan-900 hover:underline">
                    {a.eventId}
                  </Link>
                  <span className="ml-auto font-mono text-[10px] text-faint">created {fmtTime(a.createdAt)}</span>
                </div>
                <div className="mt-1 font-semibold text-ink">{a.placeName}</div>
                <div className="text-mute">{a.summary}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-mute">
                  <DispatchBadge status={a.dispatch.status} />
                  <span>attempts {a.dispatch.attempts}</span>
                  {a.dispatch.lastAttemptAt && <span>last attempt {fmtTime(a.dispatch.lastAttemptAt)}</span>}
                  {a.dispatch.nextAttemptAt && <span>next attempt {fmtTime(a.dispatch.nextAttemptAt)}</span>}
                  {a.dispatch.sentAt && <span>sent {fmtTime(a.dispatch.sentAt)}</span>}
                  {a.dispatch.lastError && <span className="text-red-800">error: {a.dispatch.lastError}</span>}
                </div>
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] text-ink">
                    SITREP — {a.sitrep.phrasing === "llm" ? "LLM-phrased (facts checked against template)" : "Template"}
                  </summary>
                  <div className="mt-1 text-[10.5px] text-faint">{a.sitrep.note}</div>
                  <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-ink/5 p-2 font-mono text-[11px] text-ink scroll-thin">{a.sitrep.text}</pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
