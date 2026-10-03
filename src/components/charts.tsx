import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Kinematics, SiteHistory } from "../../shared/types.ts";
import { grid, tick, tooltipStyle } from "../lib/chart";
import { fmtTime } from "../lib/format";

/** 12-month site history: active days per month (from `history.series`). */
export function HistoryChart({ history, height = 120 }: { history: SiteHistory; height?: number }) {
  const data = history.series.map((s) => ({ month: s.month.slice(2), activeDays: s.activeDays, medianFrp: s.medianFrpMW }));
  if (!data.length) return <div className="py-3 text-center text-[11px] text-faint">No site history records.</div>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="month" tick={{ ...tick, fontSize: 9 }} interval={1} />
          <YAxis tick={{ ...tick, fontSize: 9 }} allowDecimals={false} width={28} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, name) => [v ?? "—", name === "activeDays" ? "active days" : "median FRP (MW)"]}
          />
          <Bar dataKey="activeDays" fill="#0e7490" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** FRP and pixel count per overpass (from `kinematics.overpassSeries`) — real per-pass data only. */
export function OverpassChart({ kinematics, height = 130 }: { kinematics: Kinematics; height?: number }) {
  const data = kinematics.overpassSeries.map((o) => ({ t: fmtTime(o.t).slice(5, 16), frp: o.frpMW, pixels: o.pixels, spread: o.spreadM }));
  if (!data.length) return <div className="py-3 text-center text-[11px] text-faint">No overpass series.</div>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="t" tick={{ ...tick, fontSize: 9 }} />
          <YAxis yAxisId="frp" tick={{ ...tick, fontSize: 9 }} width={34} />
          <YAxis yAxisId="px" orientation="right" tick={{ ...tick, fontSize: 9 }} allowDecimals={false} width={24} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line yAxisId="frp" type="monotone" dataKey="frp" name="FRP (MW)" stroke="#b42318" strokeWidth={2} dot />
          <Line yAxisId="px" type="stepAfter" dataKey="pixels" name="pixels" stroke="#6b665a" strokeDasharray="4 3" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
