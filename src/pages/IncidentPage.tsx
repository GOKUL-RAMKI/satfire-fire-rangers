import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CLASS_COLORS, CLASS_LABELS } from "../../shared/labels.ts";
import type { SatEvent } from "../../shared/types.ts";
import EvidencePanel from "../components/EvidencePanel";
import MapView from "../components/MapView";
import { Empty, Kv, Section } from "../components/panels";
import { grid, tick, tooltipStyle } from "../lib/chart";
import { fmtNum, fmtTime, lifecycleText, tfText } from "../lib/format";
import { api, type WindInfo } from "../lib/api";
import { useSatfire } from "../lib/store";
import { useEventDetail } from "../lib/useEventDetail";

/** Timelines built only from the event's real per-detection data. */
function DetectionTimelines({ event }: { event: SatEvent }) {
  const rows = [...event.detections]
    .sort((a, b) => a.acqTime.localeCompare(b.acqTime))
    .map((d) => ({
      t: fmtTime(d.acqTime).slice(5, 16),
      frp: d.frpMW,
      sensor: d.sensor,
      tfLo: d.dozier.tfRangeC?.[0] ?? null,
      tfC: d.dozier.saturated ? null : d.dozier.tfCentralC,
      tfHi: d.dozier.saturated ? null : (d.dozier.tfRangeC?.[1] ?? null),
    }));
  const anySaturated = event.detections.some((d) => d.dozier.saturated);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Section title="FRP per detection (MW)">
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="t" tick={{ ...tick, fontSize: 9 }} />
              <YAxis tick={tick} width={36} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="frp" name="FRP (MW)" stroke="#b42318" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-[10.5px] text-faint">One point per quality-gated detection. FRP varies with viewing angle and sensor.</div>
      </Section>
      <Section title="Dozier T_f per detection (°C, range across background band)">
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="t" tick={{ ...tick, fontSize: 9 }} />
              <YAxis tick={tick} width={40} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="tfHi" name="range high" stroke="#c2570c" strokeDasharray="4 3" dot={false} connectNulls />
              <Line type="monotone" dataKey="tfC" name="central" stroke="#1d1b16" strokeWidth={2} dot connectNulls />
              <Line type="monotone" dataKey="tfLo" name={anySaturated ? "range low / lower bound" : "range low"} stroke="#0e7490" strokeDasharray="4 3" dot connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-[10.5px] text-faint">
          {anySaturated ? "Saturated pixels contribute a lower bound only (no central value). " : ""}Unsolvable pixels are omitted, never guessed.
        </div>
      </Section>
    </div>
  );
}

export default function IncidentPage() {
  const { id = "" } = useParams();
  const { events, dataset, polygons, status, loading } = useSatfire();
  const listEvent = events.find((e) => e.id === id) ?? null;
  // Refetch the full event when the list copy changes (e.g. after an operator review).
  const version = listEvent ? `${listEvent.review?.at ?? ""}|${listEvent.lastDetected}|${listEvent.classification.tier ?? ""}` : "";
  const detail = useEventDetail(id, dataset, listEvent, version);
  const event = detail.event;
  const codeRed = event?.classification.tier === "code_red";
  const windKey = `${dataset}|${id}`;
  const [windState, setWindState] = useState<{ key: string; info: WindInfo } | null>(null);
  useEffect(() => {
    if (!codeRed) return;
    let live = true;
    api
      .wind(id, dataset)
      .then((info) => live && setWindState({ key: windKey, info }))
      .catch((e) => live && setWindState({ key: windKey, info: { available: false, note: `Wind unavailable (${e instanceof Error ? e.message : String(e)}); wedge omitted.` } }));
    return () => {
      live = false;
    };
  }, [id, dataset, codeRed, windKey]);
  const wind = windState?.key === windKey ? windState.info : null;

  if (!event) {
    if (detail.loading || loading) return <div className="p-6 text-sm text-mute">Loading event…</div>;
    return (
      <div className="p-6">
        <Empty>
          Event <span className="font-mono">{id}</span> was not found in the <b>{dataset}</b> dataset{detail.error ? ` (${detail.error})` : ""}.{" "}
          <Link to="/events" className="text-cyan-900 underline">
            Back to events
          </Link>
        </Empty>
      </div>
    );
  }

  const c = event.classification;
  return (
    <div className="space-y-4 p-4">
      <div className="rounded border border-rule bg-card p-4" style={{ borderLeft: `4px solid ${CLASS_COLORS[c.label]}` }}>
        <div className="font-mono text-[11px] uppercase tracking-widest text-mute">
          {CLASS_LABELS[c.label]}
          {c.tier ? ` · ${c.tier.replace("_", " ")}` : ""} — incident view
        </div>
        <div className="mt-1 font-mono text-lg font-semibold text-ink">{event.id}</div>
        <div className="text-sm text-ink">{event.placeName}</div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <MapView
          events={[event]}
          polygons={polygons}
          polygonSample={status?.polygons.sample ?? false}
          dataset={dataset}
          selectedId={event.id}
          onSelect={() => undefined}
          height={380}
          windToDeg={wind?.available ? (wind.toDeg ?? null) : null}
        />
        <Section title="Incident summary">
          <Kv k="First detected" v={fmtTime(event.firstDetected)} />
          <Kv k="Last detected" v={fmtTime(event.lastDetected)} />
          <Kv k="Lifecycle" v={lifecycleText(event)} />
          <Kv k="Observations" v={`${event.observationCount} (${event.detections.length} loaded${detail.full ? "" : " — list view"})`} />
          <Kv k="Overpasses" v={event.kinematics.overpasses} />
          <Kv k="Peak FRP" v={`${fmtNum(event.peakFrpMW)} MW`} />
          {codeRed && (
            <Kv
              k="Wind (indicative wedge)"
              v={
                wind === null
                  ? "loading…"
                  : wind.available
                    ? `from ${Math.round(wind.fromDeg ?? 0)}° at ${fmtNum(wind.speedMs ?? 0)} m/s → wedge toward ${Math.round(wind.toDeg ?? 0)}° (${wind.source}, ${fmtTime(wind.at ?? null)}). ${wind.note}`
                    : wind.note
              }
            />
          )}
          <Kv k="Fire temperature (peak VIIRS pixel)" v={tfText(event.dozier)} />
          <Kv k="Site" v={event.context.match ? `${event.context.match.name ?? event.context.match.polygonId} (${event.siteKey})` : event.siteKey} />
          <Kv k="Evidence score" v={`${c.confidence.total}/100 (not a probability)`} />
          <Kv k="Action" v={c.action} />
        </Section>
      </div>

      <DetectionTimelines event={event} />

      <EvidencePanel event={event} wide showLink={false} isFull={detail.full} />
    </div>
  );
}
