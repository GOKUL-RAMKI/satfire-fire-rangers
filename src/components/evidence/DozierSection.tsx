import type { Detection, DozierResult } from "../../../shared/types.ts";
import { fmtNum, fmtRange, fmtTime, pText, tfText } from "../../lib/format";
import { FlagChip } from "../badges";
import { Kv, Section } from "../panels";

function tfCell(d: DozierResult) {
  if (d.status === "unsolvable" || d.status === "invalid" || d.status === "not_applicable") return "—";
  if (d.saturated) {
    const lb = d.tfRangeC?.[0] ?? d.tfCentralC;
    return lb === null || lb === undefined ? "lower bound" : `≥ ${fmtNum(lb, 0)} (lower bound)`;
  }
  return d.tfCentralC === null ? "—" : `≈ ${fmtNum(d.tfCentralC, 0)}`;
}

export function DozierSection({ dozier, detections }: { dozier: DozierResult; detections: Detection[] }) {
  const sorted = [...detections].sort((a, b) => a.acqTime.localeCompare(b.acqTime));
  return (
    <Section title="Thermal physics — Dozier two-band unmixing (computed per detection)">
      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          <Kv k="Status (peak-FRP VIIRS pixel)" v={dozier.status.replaceAll("_", " ")} />
          <Kv k="Fire temperature T_f" v={tfText(dozier)} />
          <Kv k="Sub-pixel fire fraction p" v={pText(dozier)} />
          <Kv k="I4 saturated" v={dozier.saturated ? (dozier.tfCentralC === null && !dozier.tfRangeC ? "yes — no T_f solved; classifier leans on saturation, FRP, footprint" : "yes — T_f is a lower bound") : "no"} />
        </div>
        <div>
          <Kv
            k="Background"
            v={`${fmtNum(dozier.backgroundK, 1)} K ± ${fmtNum(dozier.backgroundSigmaK, 1)} K (${dozier.backgroundSource === "default_300K" ? "default 300 K — flagged" : "neighbour median"})`}
          />
          <div className="flex flex-wrap gap-1 py-1.5">
            {dozier.flags.length ? dozier.flags.map((f) => <FlagChip key={f} flag={f} />) : <span className="text-[11px] text-faint">no Dozier flags</span>}
          </div>
          <div className="text-[11px] leading-snug text-faint">
            The solve is repeated across the background band; the spread is reported as a range, never collapsed to one exact number.
          </div>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1100px] text-left text-[11px]">
          <thead className="font-mono text-[10px] uppercase text-mute">
            <tr className="border-b border-rule">
              {["Time (UTC)", "Sensor", "Conf", "Gate", "FRP MW", "I4 K", "I5 K", "Dozier", "T_f °C", "T_f range °C", "p range %", "Buffer m", "Matched polygon", "Corrob."].map((h) => (
                <th key={h} className="px-1.5 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {sorted.map((d) => (
              <tr key={d.id} className="border-b border-rule/60 align-top">
                <td className="px-1.5 py-1 whitespace-nowrap">{fmtTime(d.acqTime)}</td>
                <td className="px-1.5 py-1">
                  {d.sensor}
                  <span className="text-faint"> {d.dayNight}</span>
                </td>
                <td className="px-1.5 py-1">{d.confidence}</td>
                <td className="px-1.5 py-1">
                  <span className={d.gateStatus === "provisional" ? "text-amber-800" : "text-ink"}>{d.gateStatus}</span>
                  {d.gateFlags.length > 0 && <div className="text-[10px] text-faint">{d.gateFlags.join(", ")}</div>}
                </td>
                <td className="px-1.5 py-1">{fmtNum(d.frpMW)}</td>
                <td className="px-1.5 py-1">{fmtNum(d.brightI4K)}</td>
                <td className="px-1.5 py-1">{fmtNum(d.brightI5K)}</td>
                <td className="px-1.5 py-1">{d.dozier.status.replaceAll("_", " ")}</td>
                <td className="px-1.5 py-1 whitespace-nowrap">{tfCell(d.dozier)}</td>
                <td className="px-1.5 py-1 whitespace-nowrap">{fmtRange(d.dozier.tfRangeC, "")}</td>
                <td className="px-1.5 py-1 whitespace-nowrap">{fmtRange(d.dozier.pRangePct, "", 4)}</td>
                <td className="px-1.5 py-1">{fmtNum(d.bufferM, 0)}</td>
                <td className="px-1.5 py-1">
                  {d.match ? (
                    <>
                      {d.match.name ?? d.match.polygonId}
                      <span className="text-faint"> · {fmtNum(d.match.distanceM, 0)} m</span>
                      {d.runnerUps.length > 0 && <div className="text-[10px] text-amber-800">+{d.runnerUps.length} runner-up</div>}
                    </>
                  ) : (
                    <span className="text-faint">none</span>
                  )}
                </td>
                <td className="px-1.5 py-1" title={d.corroboratedBy.join("\n")}>
                  {d.corroboratedBy.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-[10.5px] text-faint">
        {detections.length} detection(s). Corrob. = MODIS detections merged as corroboration (VIIRS primary). Saturated pixels show a lower bound only.
      </div>
    </Section>
  );
}
