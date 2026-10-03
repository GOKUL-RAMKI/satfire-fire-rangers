import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CLASS_LABELS, CLASS_ORDER } from "../../shared/labels.ts";
import type { ClassKey, SatEvent } from "../../shared/types.ts";
import { ClassBadge, LifecycleBadge, ReviewBadge, TierBadge } from "../components/badges";
import { Empty } from "../components/panels";
import { fmtNum, fmtTime } from "../lib/format";
import { useSatfire } from "../lib/store";

export function EventsTable({ events }: { events: SatEvent[] }) {
  if (!events.length) return <Empty>No events.</Empty>;
  return (
    <div className="overflow-x-auto rounded border border-rule bg-card scroll-thin">
      <table className="w-full min-w-[900px] text-left text-xs">
        <thead className="font-mono text-[10px] uppercase text-mute">
          <tr className="border-b border-rule">
            {["Event", "Class", "Tier", "Lifecycle", "Place", "Last detected", "Peak FRP", "Score", "Review"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-rule/60 hover:bg-ink/5">
              <td className="px-3 py-1.5 font-mono text-[11px]">
                <Link to={`/events/${encodeURIComponent(e.id)}`} className="text-cyan-900 hover:underline">
                  {e.id}
                </Link>
              </td>
              <td className="px-3 py-1.5">
                <ClassBadge label={e.classification.label} />
              </td>
              <td className="px-3 py-1.5">
                <TierBadge tier={e.classification.tier} />
              </td>
              <td className="px-3 py-1.5">
                <LifecycleBadge lifecycle={e.lifecycle} quietHours={e.quietHours} />
              </td>
              <td className="px-3 py-1.5">{e.placeName}</td>
              <td className="px-3 py-1.5 font-mono text-[11px]">{fmtTime(e.lastDetected)}</td>
              <td className="px-3 py-1.5 font-mono text-[11px]">{fmtNum(e.peakFrpMW)} MW</td>
              <td className="px-3 py-1.5 font-mono text-[11px]">{e.classification.confidence.total}/100</td>
              <td className="px-3 py-1.5">
                {e.classification.needsReview ? (
                  <>
                    <ReviewBadge />{" "}
                    <span className="font-mono text-[10px] uppercase text-mute">{e.classification.reviewPriority ?? "medium"}</span>
                  </>
                ) : e.review ? (
                  <span className="font-mono text-[10px] text-mute">{e.review.decision}ed</span>
                ) : (
                  ""
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EventsPage() {
  const { events, dataset, loading } = useSatfire();
  const [cls, setCls] = useState<ClassKey | "all">("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const rows = useMemo(
    () => events.filter((e) => (cls === "all" || e.classification.label === cls) && (!reviewOnly || e.classification.needsReview)),
    [events, cls, reviewOnly],
  );

  return (
    <div className="space-y-3 p-4">
      <h1 className="text-lg font-bold text-ink">Events ({events.length})</h1>
      <p className="max-w-3xl text-xs text-mute">
        Detections close in space and time are linked into one event (overpass-aware window). An event is marked extinguished only after an extended quiet window.
        Score is the rule-based evidence score, not a probability. Dataset: {dataset}.
      </p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-mute" htmlFor="cls-filter">
          Class
          <select id="cls-filter" value={cls} onChange={(e) => setCls(e.target.value as ClassKey | "all")} className="border border-rule bg-card px-1.5 py-1 text-ink">
            <option value="all">All classes</option>
            {CLASS_ORDER.map((c) => (
              <option key={c} value={c}>
                {CLASS_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-mute">
          <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> needs review only
        </label>
        <span className="font-mono text-[11px] text-faint">{rows.length} shown</span>
      </div>
      {loading && !events.length ? <Empty>Loading events…</Empty> : <EventsTable events={rows} />}
    </div>
  );
}
