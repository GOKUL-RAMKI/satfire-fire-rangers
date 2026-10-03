import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CLASS_COLORS, CLASS_LABELS, CLASS_ORDER, TIER_LABELS } from "../../shared/labels.ts";
import type { BacktestReport, ClassKey } from "../../shared/types.ts";
import { SampleBadge } from "../components/badges";
import { Empty, Kv, Section } from "../components/panels";
import { api, errorText } from "../lib/api";
import { grid, tick, tooltipStyle } from "../lib/chart";
import { classCounts, fmtNum, fmtTime, TIER_ORDER } from "../lib/format";
import { useSatfire } from "../lib/store";

const short = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);

function ChartBox({ title, note, children, height = 220 }: { title: string; note?: string; children: React.ReactElement; height?: number }) {
  return (
    <Section title={title}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
      {note && <div className="mt-1 text-[10.5px] text-faint">{note}</div>}
    </Section>
  );
}

function BacktestPanel() {
  const [state, setState] = useState<{ report: BacktestReport | null; error: string | null } | null>(null);
  useEffect(() => {
    api
      .backtest()
      .then((report) => setState({ report, error: null }))
      .catch((e) => setState({ report: null, error: errorText(e) }));
  }, []);

  if (!state) return <Section title="Backtest">Loading backtest report…</Section>;
  if (state.error) return <Section title="Backtest"><div className="text-xs text-red-800">Backtest unavailable: {state.error}</div></Section>;
  const r = state.report;
  if (!r) return <Section title="Backtest"><Empty>No backtest report generated yet (npm run backtest)</Empty></Section>;

  const labels = [...new Set(r.confusion.flatMap((c) => [c.truth, c.predicted]))].sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  const cell = (t: ClassKey, p: ClassKey) => r.confusion.find((c) => c.truth === t && c.predicted === p)?.count ?? 0;

  return (
    <Section title="Backtest — historical windows" right={r.sample ? <SampleBadge title="Backtest ran on sample data" /> : undefined}>
      <div className="mb-2 rounded bg-amber-50 p-2 text-[11px] text-amber-950 ring-1 ring-amber-600/30">{r.caveat}</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <Kv k="Generated" v={fmtTime(r.generatedAt)} />
          <Kv k="Dataset" v={r.dataset} />
          <Kv k="Industrial-fire recall" v={pct(r.industrialFireRecall)} />
          <Kv k="False industrial alerts / week" v={fmtNum(r.falseIndustrialAlertsPerWeek, 2)} />
          <Kv k="Weeks covered" v={fmtNum(r.weeksCovered, 1)} />
          <div className="mt-2 text-[10px] font-bold uppercase text-mute">Windows</div>
          <ul className="space-y-0.5 text-[11px] text-mute">
            {r.windows.map((w) => (
              <li key={w.name}>
                <span className="text-ink">{w.name}</span> · {CLASS_LABELS[w.label]} · {w.start.slice(0, 10)} → {w.end.slice(0, 10)} · {w.detections} det.
              </li>
            ))}
          </ul>
        </div>
        <div className="overflow-x-auto lg:col-span-2">
          <table className="w-full text-left text-xs">
            <thead className="font-mono text-[10px] uppercase text-mute">
              <tr className="border-b border-rule">
                <th className="py-1 pr-2">Class</th>
                <th className="py-1 pr-2">Precision</th>
                <th className="py-1 pr-2">Recall</th>
                <th className="py-1 pr-2">Support</th>
                <th className="py-1 pr-2">Predicted</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {r.perClass.map((c) => (
                <tr key={c.label} className="border-b border-rule/60">
                  <td className="py-1 pr-2 font-sans">
                    <span className="dot mr-1.5" style={{ background: CLASS_COLORS[c.label] }} />
                    {CLASS_LABELS[c.label]}
                  </td>
                  <td className="py-1 pr-2">{pct(c.precision)}</td>
                  <td className="py-1 pr-2">{pct(c.recall)}</td>
                  <td className="py-1 pr-2">{c.support}</td>
                  <td className="py-1 pr-2">{c.predicted}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {labels.length > 0 && (
            <>
              <div className="mt-3 text-[10px] font-bold uppercase text-mute">Confusion (rows = truth, columns = predicted)</div>
              <table className="mt-1 text-[10.5px]">
                <thead>
                  <tr>
                    <th />
                    {labels.map((p) => (
                      <th key={p} className="px-1.5 py-1 text-left font-mono font-normal text-mute" title={CLASS_LABELS[p]}>
                        {short(CLASS_LABELS[p], 10)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {labels.map((t) => (
                    <tr key={t}>
                      <th className="pr-2 text-left font-sans font-normal text-mute">{short(CLASS_LABELS[t], 20)}</th>
                      {labels.map((p) => {
                        const n = cell(t, p);
                        return (
                          <td key={p} className={`border border-rule px-1.5 py-0.5 text-center ${n ? (t === p ? "bg-emerald-100" : "bg-red-100") : "text-faint"}`}>
                            {n}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 text-[10px] font-bold uppercase text-mute">Failures ({r.failures.length})</div>
      {r.failures.length === 0 ? (
        <div className="text-[11px] text-faint">No failures recorded.</div>
      ) : (
        <ul className="mt-1 space-y-1 text-[11px]">
          {r.failures.map((f, i) => (
            <li key={`${f.eventId}-${i}`} className="rounded bg-red-50 p-1.5 ring-1 ring-red-700/20">
              <span className="font-mono">{f.window}</span> · <span className="font-mono">{f.eventId}</span>: truth {CLASS_LABELS[f.truth]}, predicted {CLASS_LABELS[f.predicted]} — {f.why}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function AnalyticsPage() {
  const { events, dataset } = useSatfire();

  const d = useMemo(() => {
    const dist = classCounts(events).map((c) => ({ key: c.label, name: CLASS_LABELS[c.label], value: c.count }));
    const tiered = events.filter((e) => e.classification.tier);
    const tiers = TIER_ORDER.map((t) => ({ name: TIER_LABELS[t], value: tiered.filter((e) => e.classification.tier === t).length }));

    const perDay = new Map<string, Record<string, number | string>>();
    for (const e of events)
      for (const det of e.detections) {
        const day = det.acqTime.slice(0, 10);
        const row = perDay.get(day) ?? { day };
        row[e.classification.label] = ((row[e.classification.label] as number) ?? 0) + 1;
        perDay.set(day, row);
      }
    const days = [...perDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const trimmed = events.some((e) => e.detections.length < e.observationCount);

    const frp = events
      .filter((e) => e.history.baselineFrpMW !== null)
      .map((e) => ({ name: short(e.placeName), id: e.id, peak: e.peakFrpMW, baseline: e.history.baselineFrpMW, label: e.classification.label }));
    const persistent = events
      .filter((e) => e.classification.label === "persistent_source" || e.classification.label === "mining")
      .map((e) => ({ name: short(e.placeName), activeDays: e.history.activeDays, label: e.classification.label }));
    const deviation = events
      .filter((e) => e.history.deviationX !== null)
      .map((e) => ({ name: short(e.placeName), dev: e.history.deviationX, label: e.classification.label }))
      .sort((a, b) => (b.dev ?? 0) - (a.dev ?? 0));
    const coldStart = events.filter((e) => e.history.deviationX === null);
    const present = CLASS_ORDER.filter((c) => days.some((r) => r[c]));
    return { dist, tiers, days, trimmed, frp, persistent, deviation, coldStart, present };
  }, [events]);

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-bold text-ink">Analytics</h1>
        <p className="text-xs text-mute">All charts are computed from the {events.length} events currently loaded ({dataset} dataset).</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartBox title="Class distribution (events)">
          <BarChart data={d.dist} layout="vertical" margin={{ left: 40 }}>
            <CartesianGrid {...grid} />
            <XAxis type="number" tick={tick} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ ...tick, fontSize: 9 }} width={150} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="value" name="events">
              {d.dist.map((x) => (
                <Cell key={x.key} fill={CLASS_COLORS[x.key]} />
              ))}
            </Bar>
          </BarChart>
        </ChartBox>
        <ChartBox title="Alert tiers (industrial fire / unmapped candidates)">
          <BarChart data={d.tiers}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="name" tick={tick} />
            <YAxis tick={tick} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="value" name="events">
              {d.tiers.map((t, i) => (
                <Cell key={t.name} fill={["#b42318", "#c2570c", "#a16207"][i]} />
              ))}
            </Bar>
          </BarChart>
        </ChartBox>
      </div>

      <ChartBox
        title="Detections per day (UTC), by event class"
        note={d.trimmed ? "Counted from the detections returned by the events list, which trims long events; per-event totals are in the Events table." : undefined}
      >
        <BarChart data={d.days}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="day" tick={tick} />
          <YAxis tick={tick} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          {d.present.map((c) => (
            <Bar key={c} dataKey={c} name={CLASS_LABELS[c]} stackId="a" fill={CLASS_COLORS[c]} />
          ))}
        </BarChart>
      </ChartBox>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartBox title="Peak FRP vs site baseline (MW)" note="Events with a baseline only; cold-start sites have none.">
          <BarChart data={d.frp}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="name" tick={{ ...tick, fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={60} />
            <YAxis tick={tick} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar dataKey="baseline" name="baseline" fill="#8f897b" />
            <Bar dataKey="peak" name="peak FRP (class colour)" fill="#b42318">
              {d.frp.map((x) => (
                <Cell key={x.id} fill={CLASS_COLORS[x.label]} />
              ))}
            </Bar>
          </BarChart>
        </ChartBox>
        <ChartBox title="Deviation from baseline (×)" note={d.coldStart.length ? `Cold start (no baseline, excluded): ${d.coldStart.map((e) => e.placeName).join(", ")}` : undefined}>
          <BarChart data={d.deviation}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="name" tick={{ ...tick, fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={60} />
            <YAxis tick={tick} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="dev" name="deviation ×">
              {d.deviation.map((x, i) => (
                <Cell key={i} fill={CLASS_COLORS[x.label]} />
              ))}
            </Bar>
          </BarChart>
        </ChartBox>
      </div>

      <ChartBox title="Routine sites — active days in site history (persistent sources + mining)" height={200}>
        <BarChart data={d.persistent}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="name" tick={{ ...tick, fontSize: 9 }} />
          <YAxis tick={tick} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="activeDays" name="active days">
            {d.persistent.map((x, i) => (
              <Cell key={i} fill={CLASS_COLORS[x.label]} />
            ))}
          </Bar>
        </BarChart>
      </ChartBox>

      <BacktestPanel />
    </div>
  );
}
