import { Link, useParams } from "react-router-dom";
import { ClassBadge, LifecycleBadge, SampleBadge, TierBadge } from "../components/badges";
import { HistoryChart } from "../components/charts";
import MapView from "../components/MapView";
import { Empty, Kv, Section } from "../components/panels";
import { eventsAtFacility, fmtNum, fmtTime } from "../lib/format";
import { useSatfire } from "../lib/store";
import { CpcbBadge } from "./FacilitiesPage";

export default function FacilityDetailPage() {
  const { id = "" } = useParams();
  const { facilities, events, polygons, status, loading, dataset } = useSatfire();
  const f = facilities.find((x) => x.id === id);

  if (!f) {
    return (
      <div className="p-6">
        <Empty>
          {loading ? "Loading…" : `Facility ${id} not found in the ${dataset} dataset.`}{" "}
          <Link to="/facilities" className="text-cyan-900 underline">
            Back to facilities
          </Link>
        </Empty>
      </div>
    );
  }

  const evs = eventsAtFacility(events, f);
  const ownPolygons = polygons ? { ...polygons, features: polygons.features.filter((p) => f.polygonIds.includes(p.id) || p.properties.facilityId === f.id) } : null;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/facilities" className="text-xs text-cyan-900 hover:underline">
          ← Facilities
        </Link>
        <h1 className="text-lg font-bold text-ink">{f.name}</h1>
        <CpcbBadge f={f} />
        {f.dataset === "sample" && <SampleBadge title="Facility record is sample data" />}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Facility record">
          <Kv k="ID" v={f.id} />
          <Kv k="Type" v={f.type} />
          <Kv k="State" v={f.state} />
          <Kv k="Location" v={`${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`} />
          <Kv k="CPCB category" v={f.cpcbCategory ?? "—"} />
          <Kv k="CPCB category source" v={f.cpcbSource} />
          <Kv k="Routine thermal sources" v={f.routineSources.length ? f.routineSources.join(", ") : "none recorded"} />
          <Kv k="Brick kiln" v={f.kiln ? "yes — seasonal operating check applies" : "no"} />
          <Kv k="Mapped since" v={f.mappedSince ?? "—"} />
          <Kv k="Record source" v={f.source} />
          <Kv k="Refreshed" v={fmtTime(f.refreshedAt)} />
          <Kv k="Polygons" v={f.polygonIds.join(", ") || "—"} />
        </Section>
        <MapView
          events={evs}
          polygons={ownPolygons}
          polygonSample={status?.polygons.sample ?? false}
          selectedId={evs[0]?.id ?? null}
          onSelect={() => undefined}
          height={360}
        />
      </div>

      <h2 className="text-sm font-bold uppercase tracking-wider text-ink">Events at this facility ({evs.length})</h2>
      {evs.length === 0 ? (
        <Empty>No events at this facility in the {dataset} dataset.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {evs.map((e) => (
            <Section
              key={e.id}
              title={
                <Link to={`/events/${encodeURIComponent(e.id)}`} className="font-mono normal-case text-cyan-900 hover:underline">
                  {e.id}
                </Link>
              }
              right={e.history.sample ? <SampleBadge title="Site history is sample data" /> : undefined}
            >
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <ClassBadge label={e.classification.label} />
                <TierBadge tier={e.classification.tier} />
                <LifecycleBadge lifecycle={e.lifecycle} quietHours={e.quietHours} />
              </div>
              <Kv k="History pattern" v={`${e.history.pattern} · ${e.history.activeDays} active days`} />
              <Kv
                k="Baseline → current"
                v={
                  e.history.deviationX === null
                    ? `cold start: ${e.history.coldStartReason ?? "no baseline"}`
                    : `${fmtNum(e.history.baselineFrpMW)} → ${fmtNum(e.history.currentFrpMW)} MW (${fmtNum(e.history.deviationX, 2)}×)`
                }
              />
              <div className="mt-2 text-[10px] uppercase tracking-wide text-faint">Active days per month</div>
              <HistoryChart history={e.history} />
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}
