import { Link } from "react-router-dom";
import type { Facility } from "../../shared/types.ts";
import { ClassBadge, SampleBadge } from "../components/badges";
import { Empty } from "../components/panels";
import { eventsAtFacility, fmtDate } from "../lib/format";
import { useSatfire } from "../lib/store";

const CPCB_STYLE: Record<string, string> = {
  Red: "border-red-700/50 text-red-800",
  Orange: "border-orange-600/50 text-orange-800",
  Green: "border-emerald-700/50 text-emerald-800",
  White: "border-rule text-mute",
};

export function CpcbBadge({ f }: { f: Facility }) {
  return (
    <span
      title={`CPCB category source: ${f.cpcbSource}`}
      className={`inline-flex border px-1.5 py-0.5 font-mono text-[10px] uppercase ${f.cpcbCategory ? CPCB_STYLE[f.cpcbCategory] : "border-rule text-faint"}`}
    >
      CPCB {f.cpcbCategory ?? "n/a"}
    </span>
  );
}

export default function FacilitiesPage() {
  const { facilities, events, dataset, loading } = useSatfire();
  const sample = facilities.some((f) => f.dataset === "sample");
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-ink">Facilities ({facilities.length})</h1>
        {sample && <SampleBadge title="Facility records are sample data" />}
      </div>
      <p className="max-w-3xl text-xs text-mute">
        Facility records carry their data source and last-refresh date, including where the CPCB category comes from. Dataset: {dataset}.
      </p>
      {facilities.length === 0 ? (
        <Empty>{loading ? "Loading facilities…" : "No facility records for this dataset."}</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {facilities.map((f) => {
            const evs = eventsAtFacility(events, f);
            return (
              <Link key={f.id} to={`/facilities/${encodeURIComponent(f.id)}`} className="block rounded border border-rule bg-card p-4 hover:border-ink/50">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-faint">{f.id}</span>
                  <CpcbBadge f={f} />
                  {f.kiln && <span className="font-mono text-[10px] uppercase text-mute">kiln</span>}
                  <span className="ml-auto text-[11px] text-mute">{f.state}</span>
                </div>
                <div className="mt-1 font-semibold text-ink">{f.name}</div>
                <div className="text-xs text-mute">
                  {f.type}
                  {f.routineSources.length ? ` · routine: ${f.routineSources.join(", ")}` : ""}
                </div>
                <div className="mt-1 text-[11px] text-faint">
                  {f.source} · refreshed {fmtDate(f.refreshedAt)} · mapped since {f.mappedSince ?? "—"}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {evs.length ? evs.map((e) => <ClassBadge key={e.id} label={e.classification.label} />) : <span className="text-[11px] text-faint">No events in this dataset</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
