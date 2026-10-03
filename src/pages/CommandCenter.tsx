import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CLASS_COLORS, CLASS_LABELS, TIER_LABELS } from "../../shared/labels.ts";
import EvidencePanel from "../components/EvidencePanel";
import MapView, { MapLegend } from "../components/MapView";
import { ClassBadge, DispatchBadge, ReviewBadge, SeverityBadge, TierBadge } from "../components/badges";
import { DataStatusPanel, Empty, Section, StatCard } from "../components/panels";
import { tooltipStyle } from "../lib/chart";
import { classCounts, fmtNum, fmtTime, TIER_ORDER } from "../lib/format";
import { selectedEvent, useSatfire } from "../lib/store";

export default function CommandCenter() {
  const { events, polygons, status, alerts, selection, selectEvent, loading, dataset } = useSatfire();
  const selected = selectedEvent(events, selection) ?? events[0] ?? null;

  const stats = useMemo(() => {
    const by = (l: string) => events.filter((e) => e.classification.label === l);
    const ind = by("industrial_fire");
    const tiers = TIER_ORDER.map((t) => `${TIER_LABELS[t]} ${ind.filter((e) => e.classification.tier === t).length}`);
    const lifecycle = ["active", "quiet", "extinguished"].map((l) => `${events.filter((e) => e.lifecycle === l).length} ${l}`);
    const present = classCounts(events).filter((c) => c.count > 0);
    const review = events.filter((e) => e.classification.needsReview);
    return {
      detections: events.reduce((s, e) => s + e.observationCount, 0),
      lifecycle: lifecycle.join(" · "),
      industrial: ind.length,
      tiers: tiers.join(" · "),
      unmapped: by("unmapped_industrial_candidate").length,
      wildfire: by("wildfire").length,
      routine: by("persistent_source").length + by("mining").length,
      routineSub: `${by("persistent_source").length} persistent · ${by("mining").length} mining`,
      review: review.length,
      reviewSub: `${review.filter((e) => e.classification.flags.includes("cold_start_manual_review")).length} cold start · ${by("provisional").length} provisional · ${by("other").length} other`,
      coverage: present.length,
      coverageSub: present.map((c) => CLASS_LABELS[c.label]).join(" · ") || "no events",
      dist: present.map((c) => ({ name: CLASS_LABELS[c.label], key: c.label, value: c.count })),
    };
  }, [events]);

  const priority = events.filter((e) => e.classification.tier || e.classification.needsReview).slice(0, 6);

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Thermal detections" value={String(stats.detections)} sub={`quality-gated, in ${events.length} events (${dataset})`} />
        <StatCard label="Events" value={String(events.length)} sub={stats.lifecycle} />
        <StatCard label="Industrial fires" value={String(stats.industrial)} sub={stats.tiers} accent="#b42318" />
        <StatCard label="Unmapped industrial candidates" value={String(stats.unmapped)} sub="reviewed like a matched industrial fire" accent={CLASS_COLORS.unmapped_industrial_candidate} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wildfires" value={String(stats.wildfire)} sub="routed to NDRF / Forest Depts" accent={CLASS_COLORS.wildfire} />
        <StatCard label="Routine sources" value={String(stats.routine)} sub={`${stats.routineSub} — no dispatch`} accent={CLASS_COLORS.persistent_source} />
        <StatCard label="Needs operator review" value={String(stats.review)} sub={stats.reviewSub} accent="#0c4a6e" />
        <StatCard label="Class coverage" value={`${stats.coverage} / ${Object.keys(CLASS_LABELS).length}`} sub={stats.coverageSub} accent={CLASS_COLORS.mining} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-3 xl:col-span-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink">Thermal events — class overlay</h2>
            <Link to="/map" className="ml-auto text-xs text-cyan-800 hover:underline">
              Open full map →
            </Link>
          </div>
          <MapView
            events={events}
            polygons={polygons}
            polygonSample={status?.polygons.sample ?? false}
            selectedId={selected?.id ?? null}
            onSelect={selectEvent}
          flyToSelected={Boolean(selection)}
            height={440}
          />
          <MapLegend />
          {selected ? (
            <EvidencePanel event={selected} />
          ) : (
            <Empty>{loading ? "Loading events…" : `No events in the ${dataset} dataset.`}</Empty>
          )}
        </div>

        <div className="space-y-3">
          <DataStatusPanel status={status} />
          <Section title="Priority — tiered or needs review" right={<Link to="/events" className="text-xs text-cyan-800 hover:underline">All →</Link>}>
            {priority.length === 0 ? (
              <div className="text-xs text-faint">Nothing tiered or awaiting review.</div>
            ) : (
              <div className="space-y-2">
                {priority.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => selectEvent(e.id)}
                    className={`w-full rounded bg-ink/5 p-2.5 text-left hover:ring-1 hover:ring-ink/40 ${selected?.id === e.id ? "ring-1 ring-ink" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SeverityBadge severity={e.severity} />
                      <TierBadge tier={e.classification.tier} />
                      {e.classification.needsReview && <ReviewBadge />}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-ink">{e.placeName}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <ClassBadge label={e.classification.label} />
                      <span className="font-mono text-[10px] text-faint">{fmtNum(e.peakFrpMW)} MW peak</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Class distribution (events)">
            {stats.dist.length === 0 ? (
              <div className="text-xs text-faint">No events.</div>
            ) : (
              <>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={stats.dist} dataKey="value" nameKey="name" outerRadius={64} innerRadius={30}>
                        {stats.dist.map((d) => (
                          <Cell key={d.key} fill={CLASS_COLORS[d.key]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-0.5 text-[11px]">
                  {stats.dist.map((d) => (
                    <div key={d.key} className="flex items-center gap-1.5">
                      <span className="dot" style={{ background: CLASS_COLORS[d.key] }} />
                      <span className="text-ink">{d.name}</span>
                      <span className="ml-auto font-mono text-mute">{d.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Section>

          <Section title="Recent alerts" right={<Link to="/alerts" className="text-xs text-cyan-800 hover:underline">All →</Link>}>
            {alerts.length === 0 ? (
              <div className="text-xs text-faint">No alert records.</div>
            ) : (
              <div className="space-y-1.5">
                {[...alerts]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, 5)
                  .map((a) => (
                    <div key={a.id} className="border-b border-rule pb-1.5 text-xs last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] uppercase text-ink">{a.kind.replace("_", " ")}</span>
                        <DispatchBadge status={a.dispatch.status} />
                        <span className="ml-auto font-mono text-[10px] text-faint">{fmtTime(a.createdAt)}</span>
                      </div>
                      <div className="text-mute">{a.placeName}</div>
                    </div>
                  ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
