import { useMemo, useState } from "react";
import { CLASS_COLORS, CLASS_LABELS, CLASS_ORDER } from "../../shared/labels.ts";
import type { ClassKey } from "../../shared/types.ts";
import EvidencePanel from "../components/EvidencePanel";
import MapView, { MapLegend } from "../components/MapView";
import { Empty } from "../components/panels";
import { classCounts } from "../lib/format";
import { selectedEvent, useSatfire } from "../lib/store";

export default function MapPage() {
  const { events, polygons, status, selection, selectEvent } = useSatfire();
  const [hidden, setHidden] = useState<Set<ClassKey>>(new Set());
  const [showPolygons, setShowPolygons] = useState(true);
  const counts = useMemo(() => new Map(classCounts(events).map((c) => [c.label, c.count])), [events]);

  const filtered = useMemo(() => events.filter((e) => !hidden.has(e.classification.label)), [events, hidden]);
  const selected = selectedEvent(events, selection) ?? filtered[0] ?? null;
  const detections = filtered.reduce((s, e) => s + e.observationCount, 0);

  const toggle = (c: ClassKey) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-5">
      <div className="min-w-0 space-y-3 xl:col-span-3">
        <div className="rounded border border-rule bg-card p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-mute">Filter by class</span>
            <button type="button" onClick={() => setHidden(new Set())} className="ml-auto font-mono text-[10px] uppercase text-mute underline">
              show all
            </button>
            <label className="flex items-center gap-1 text-[11px] text-mute">
              <input type="checkbox" checked={showPolygons} onChange={(e) => setShowPolygons(e.target.checked)} /> facility / land-use layer
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {CLASS_ORDER.map((c) => {
              const on = !hidden.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c)}
                  className={`border px-2.5 py-1 text-xs ${on ? "text-ink" : "text-faint opacity-60"}`}
                  style={{ background: on ? `${CLASS_COLORS[c]}22` : "transparent", borderColor: `${CLASS_COLORS[c]}88` }}
                >
                  {CLASS_LABELS[c]} <span className="font-mono text-[10px] text-mute">{counts.get(c) ?? 0}</span>
                </button>
              );
            })}
          </div>
        </div>
        <MapView
          events={filtered}
          polygons={polygons}
          polygonSample={status?.polygons.sample ?? false}
          selectedId={selected?.id ?? null}
          onSelect={selectEvent}
          flyToSelected={Boolean(selection)}
          height={600}
          showPolygons={showPolygons}
        />
        <MapLegend showTags={showPolygons} />
        <div className="text-[11px] text-faint">
          {filtered.length} events · {detections} detections. Industrial-fire markers are larger with a white ring; provisional markers are hollow and dashed; unmapped candidates have a dark dashed ring. Click a marker for its evidence.
        </div>
      </div>
      <div className="min-w-0 xl:col-span-2">
        {selected ? <EvidencePanel event={selected} /> : <Empty>Click a detection on the map to open its evidence panel.</Empty>}
      </div>
    </div>
  );
}
