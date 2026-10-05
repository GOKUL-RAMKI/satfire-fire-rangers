import type { Classification, FacilityMatch, Kinematics, SarCheck, SatEvent, SiteContext, SiteHistory } from "../../../shared/types.ts";
import { fmtDate, fmtNum, fmtTime, SAR_TEXT } from "../../lib/format";
import { FallbackBadge, SampleBadge } from "../badges";
import { HistoryChart, OverpassChart } from "../charts";
import { Kv, Section } from "../panels";

function matchLine(m: FacilityMatch) {
  return `${m.name ?? m.polygonId} · ${m.tag} · ${fmtNum(m.distanceM, 0)} m${m.cpcbCategory ? ` · CPCB ${m.cpcbCategory}` : ""}`;
}

export function GeoSection({ ctx }: { ctx: SiteContext }) {
  const m = ctx.match;
  return (
    <Section title="Geospatial context" right={ctx.polygonSample ? <SampleBadge title="Polygon layer is sample data" /> : undefined}>
      <Kv k="Land-use tag" v={ctx.tag ? `${ctx.tag} (from ${ctx.tagSource.replace("_", " ")})` : "none — no polygon or land-cover class"} />
      <Kv k="Matched facility / polygon" v={m ? `${m.name ?? m.polygonId}${m.facilityId ? ` (${m.facilityId})` : ""}` : "no match"} />
      {m && (
        <>
          <Kv k="Distance" v={m.distanceM === 0 ? "inside polygon (0 m)" : `${fmtNum(m.distanceM, 0)} m from boundary`} />
          <Kv
            k="CPCB category"
            v={m.cpcbCategory ? `${m.cpcbCategory} (from facility record · ${m.source})` : "— (not in facility record)"}
          />
          <Kv k="Facility type" v={ctx.facilityType ?? "—"} />
          <Kv k="Source" v={m.source} />
          <Kv k="Refreshed" v={fmtTime(m.refreshedAt)} />
          <Kv k="Mapped since" v={m.mappedSince ?? "—"} />
        </>
      )}
      <Kv k="Attribution version" v={`v${ctx.attributionVersion}`} />
      <Kv k="Spatial backend" v={ctx.spatialBackend === "postgis" ? "PostGIS" : "in-memory index"} />
      <Kv k="Polygon layer" v={ctx.polygonSource} />
      <Kv
        k="ESA WorldCover"
        v={
          <span className="inline-flex items-center gap-1.5">
            {ctx.worldCoverSource === "sample" && <SampleBadge title="WorldCover class is sample data" />}
            {ctx.worldCoverSource === "live" && <FallbackBadge title="WorldCover class is point-sampled live fallback data" />}
            {ctx.worldCover ?? (ctx.worldCoverSource === "unavailable" ? "unavailable" : "—")}
          </span>
        }
      />
      {ctx.kiln && <Kv k="Brick kiln" v="yes — seasonal operating check applies" />}
      {ctx.runnerUps.length > 0 && (
        <div className="mt-2 rounded bg-amber-50 p-2 text-[11px] ring-1 ring-amber-600/30">
          <div className="font-semibold text-amber-900">Ambiguity: {ctx.runnerUps.length} runner-up polygon(s) within the buffer — nearest wins</div>
          <ul className="mt-1 space-y-0.5 font-mono text-[10.5px] text-mute">
            {ctx.runnerUps.map((r) => (
              <li key={r.polygonId}>
                #{r.rank} {matchLine(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

export function HistorySection({ h }: { h: SiteHistory }) {
  return (
    <Section title="Site history / persistence" right={h.sample ? <SampleBadge title="Site history is sample data" /> : undefined}>
      <Kv k="Pattern" v={h.pattern} />
      <Kv k="Active days / span" v={`${h.activeDays} active days over ${h.spanDays} days (${h.monthsActive} months active)`} />
      <Kv k="Recurrence" v={h.recurrence} />
      <Kv k="First / last seen" v={`${fmtDate(h.firstSeen)} → ${fmtDate(h.lastSeen)}`} />
      <Kv k="Baseline FRP" v={h.baselineFrpMW === null ? "none" : `${fmtNum(h.baselineFrpMW)} MW (${h.baselineSource.replace("_", " ")})`} />
      <Kv k="Current FRP" v={`${fmtNum(h.currentFrpMW)} MW`} />
      <Kv
        k="Deviation"
        v={
          h.deviationX === null ? (
            <span className="text-amber-800">cold start: {h.coldStartReason ?? "no baseline"}</span>
          ) : (
            `${fmtNum(h.deviationX, 2)}× baseline`
          )
        }
      />
      <Kv k="History source" v={`${h.source} · ${h.records} records`} />
      <div className="mt-2 text-[10px] uppercase tracking-wide text-faint">Active days per month (last 12 months)</div>
      <HistoryChart history={h} />
    </Section>
  );
}

function PatternSchematic({ kind, active, label }: { kind: "static" | "linear" | "radial"; active: boolean; label: string }) {
  const dots: [number, number][] =
    kind === "static"
      ? [[20, 20], [26, 18], [23, 25], [27, 24]]
      : kind === "linear"
        ? [[8, 28], [18, 24], [28, 20], [38, 16]]
        : [[25, 22], [15, 14], [35, 14], [14, 32], [36, 32], [25, 8]];
  return (
    <div className={`rounded p-1.5 ${active ? "bg-cyan-500/10 ring-1 ring-cyan-600/50" : "bg-ink/5"}`}>
      <svg viewBox="0 0 50 40" className="mx-auto h-10 w-full" aria-hidden>
        {dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3.2} fill={active ? "#0e7490" : "#8f897b"} opacity={active ? 0.9 - i * 0.1 : 0.6} />
        ))}
      </svg>
      <div className={`text-center text-[10px] ${active ? "font-bold text-cyan-800" : "text-faint"}`}>{label}</div>
    </div>
  );
}

export function KinematicsSection({ k }: { k: Kinematics }) {
  const kind = k.pattern === "linear-field" || k.pattern === "dispersed" ? "linear" : k.pattern.endsWith("expansion") ? "radial" : "static";
  return (
    <Section title="Kinematics (clustering across overpasses)">
      <div className="mb-2 grid grid-cols-3 gap-2">
        <PatternSchematic kind="static" active={kind === "static"} label="static / single" />
        <PatternSchematic kind="linear" active={kind === "linear"} label="linear / dispersed" />
        <PatternSchematic kind="radial" active={kind === "radial"} label="expanding" />
      </div>
      <Kv k="Pattern" v={k.pattern} />
      <Kv k="Expanding" v={k.expanding ? `yes (pixel growth ${fmtNum(k.pixelGrowth, 2)}×, spread +${fmtNum(k.spreadGrowthM, 0)} m)` : "no"} />
      <Kv k="Pixels / overpasses" v={`${k.pixels} pixel(s) over ${k.overpasses} overpass(es)`} />
      <Kv k="Spread" v={`${fmtNum(k.spreadM, 0)} m (elongation ${fmtNum(k.elongation, 2)})`} />
      <Kv k="Spread bearing" v={k.spreadBearingDeg === null ? "—" : `${fmtNum(k.spreadBearingDeg, 0)}°`} />
      <div className="mt-2 text-[10px] uppercase tracking-wide text-faint">FRP (MW, left) and pixels (right) per overpass</div>
      <OverpassChart kinematics={k} />
      <div className="text-[10.5px] text-faint">FRP varies with viewing angle and sensor; the trend is a supporting signal only.</div>
    </Section>
  );
}

const SCORE_ROWS: [keyof Classification["confidence"], string, number][] = [
  ["thermal", "Thermal", 30],
  ["spatial", "Spatial", 25],
  ["historical", "Historical", 20],
  ["kinematic", "Kinematic", 15],
  ["verification", "Verification", 10],
];

export function ScoreSection({ c }: { c: Classification }) {
  return (
    <Section title="Evidence score — not a probability">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          {SCORE_ROWS.map(([key, label, max]) => {
            const v = c.confidence[key];
            return (
              <div key={key} className="mt-1.5 text-xs first:mt-0">
                <div className="flex justify-between text-ink">
                  <span>{label}</span>
                  <span className="font-mono">
                    {v}/{max}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-rule">
                  <div className="h-1.5 rounded bg-cyan-700" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} />
                </div>
              </div>
            );
          })}
          <div className="mt-2 border-t border-rule pt-1 font-mono text-xs font-bold text-ink">Total {c.confidence.total}/100</div>
          <div className="text-[10.5px] text-faint">Rule-based evidence weighting; thresholds are starting rules to be tuned on data.</div>
        </div>
        <div className="space-y-2 text-xs">
          <div>
            <div className="text-[10px] font-bold uppercase text-mute">Evidence for</div>
            {c.evidenceFor.length ? (
              c.evidenceFor.map((e) => (
                <div key={e} className="flex gap-2 text-emerald-900">
                  <span>+</span>
                  <span>{e}</span>
                </div>
              ))
            ) : (
              <div className="text-faint">none</div>
            )}
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase text-mute">Evidence against / caution</div>
            {c.evidenceAgainst.length ? (
              c.evidenceAgainst.map((e) => (
                <div key={e} className="flex gap-2 text-mute">
                  <span>−</span>
                  <span>{e}</span>
                </div>
              ))
            ) : (
              <div className="text-faint">none</div>
            )}
          </div>
          {c.season && (
            <div className="text-[11px] text-mute">
              Seasonal prior: {c.season.inSeason ? "in" : "outside"} {c.season.region} window {c.season.windows} ({c.season.baseline})
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

export function SarSection({ sar }: { sar: SarCheck }) {
  const tone =
    sar.status === "supports" ? "text-emerald-800" : sar.status === "does_not_support" ? "text-red-800" : "text-mute";
  return (
    <Section title="Post-event check — Sentinel-1 SAR coherence" right={sar.sample ? <SampleBadge title="Sentinel-1 result is sample data" /> : undefined}>
      <Kv k="Result" v={<span className={tone}>{SAR_TEXT[sar.status]}</span>} />
      <Kv k="Coherence drop" v={sar.coherenceDrop === null ? "—" : fmtNum(sar.coherenceDrop, 2)} />
      <Kv k="Pre / post pass" v={`${fmtDate(sar.preDate)} → ${fmtDate(sar.postDate)}`} />
      <div className="mt-1 text-xs leading-relaxed text-ink">{sar.detail}</div>
      <div className="mt-2 text-[10.5px] text-faint">
        Revisit is measured in days, so SAR is a post-event confirmation layer reported as “supports” / “does not support”, not a live trigger.
      </div>
    </Section>
  );
}

export function WildfireRouteSection({ route }: { route: NonNullable<SatEvent["wildfireRoute"]> }) {
  return (
    <Section title="Wildfire routing">
      <Kv k="Spread bearing" v={route.bearingDeg === null ? "— (not expanding in a clear direction)" : `${fmtNum(route.bearingDeg, 0)}°`} />
      <Kv k="Recipients" v={route.recipients.length ? route.recipients.join(", ") : "—"} />
    </Section>
  );
}
