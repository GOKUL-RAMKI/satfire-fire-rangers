import { Link } from "react-router-dom";
import type { SatEvent } from "../../shared/types.ts";
import { fmtNum, fmtTime } from "../lib/format";
import { useEventDetail } from "../lib/useEventDetail";
import { ClassBadge, FlagChip, LifecycleBadge, ReviewBadge, SampleBadge, SeverityBadge, TierBadge } from "./badges";
import { GeoSection, HistorySection, KinematicsSection, SarSection, ScoreSection, WildfireRouteSection } from "./evidence/ContextSections";
import { DozierSection } from "./evidence/DozierSection";
import { ReviewSection, SitrepSection } from "./evidence/OperatorActions";
import { CodeRedSection, RuleTraceSection } from "./evidence/RuleTrace";

export default function EvidencePanel({
  event: listEvent,
  wide = false,
  showLink = true,
  isFull = false,
}: {
  event: SatEvent;
  wide?: boolean;
  showLink?: boolean;
  /** The caller already fetched the detail route (all detections). */
  isFull?: boolean;
}) {
  const version = `${listEvent.review?.at ?? ""}|${listEvent.lastDetected}|${listEvent.classification.tier ?? ""}`;
  const detail = useEventDetail(isFull ? null : listEvent.id, listEvent.dataset, listEvent, version);
  const event = isFull ? listEvent : (detail.event ?? listEvent);
  const c = event.classification;
  const grid = wide ? "grid gap-3 lg:grid-cols-2" : "grid gap-3";

  return (
    <div className="space-y-3">
      <div className="rounded border border-rule bg-card p-4" style={{ borderTop: `3px solid ${c.tier === "code_red" ? "#b42318" : "#d6d0c2"}` }}>
        <div className="flex flex-wrap items-center gap-2">
          <ClassBadge label={c.label} />
          <TierBadge tier={c.tier} />
          <SeverityBadge severity={event.severity} />
          <LifecycleBadge lifecycle={event.lifecycle} quietHours={event.quietHours} />
          {c.needsReview && <ReviewBadge />}
          {event.dataset === "sample" && <SampleBadge title="Event from the sample dataset" />}
          <span className="ml-auto font-mono text-[11px] text-mute">{event.id}</span>
        </div>
        <div className="mt-2 text-base font-semibold text-ink">{event.placeName}</div>
        <div className="font-mono text-[11px] text-mute">
          {event.lat.toFixed(4)}, {event.lon.toFixed(4)} · {fmtTime(event.firstDetected)} → {fmtTime(event.lastDetected)} · {event.observationCount} obs · peak FRP{" "}
          {fmtNum(event.peakFrpMW)} MW
        </div>
        <div className="mt-2 text-xs text-ink">
          <span className="font-semibold">Action:</span> {c.action}
        </div>
        {c.tier && <div className="text-xs text-mute">Tier: {c.tierReason}</div>}
        {c.needsReview && c.reviewReason && (
          <div className="mt-1 text-xs text-sky-900">
            <span className="font-semibold">Needs review:</span> {c.reviewReason}
          </div>
        )}
        {c.flags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {c.flags.map((f) => (
              <FlagChip key={f} flag={f} />
            ))}
          </div>
        )}
        {showLink && (
          <div className="mt-3">
            <Link to={`/events/${encodeURIComponent(event.id)}`} className="border border-ink px-2.5 py-1 font-mono text-[11px] uppercase hover:bg-ink hover:text-paper">
              Open incident page
            </Link>
          </div>
        )}
      </div>

      <div className={grid}>
        <RuleTraceSection c={c} />
        <div className="space-y-3">
          <ScoreSection c={c} />
          <CodeRedSection c={c} />
        </div>
      </div>

      {!isFull && !detail.full && (
        <div className="text-[11px] text-faint">
          {detail.error ? `Full detection list unavailable (${detail.error}); showing the first ${event.detections.length}.` : "Loading all detections for this event…"}
        </div>
      )}
      <DozierSection dozier={event.dozier} detections={event.detections} />

      <div className={grid}>
        <GeoSection ctx={event.context} />
        <HistorySection h={event.history} />
      </div>

      <div className={grid}>
        <KinematicsSection k={event.kinematics} />
        <div className="space-y-3">
          <SarSection sar={event.sar} />
          {event.wildfireRoute && <WildfireRouteSection route={event.wildfireRoute} />}
        </div>
      </div>

      <div className={grid}>
        <ReviewSection event={event} />
        <SitrepSection event={event} />
      </div>
    </div>
  );
}
