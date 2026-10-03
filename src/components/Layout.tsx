import { useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Dataset } from "../../shared/types.ts";
import { SCENARIOS, useSatfire, type ScenarioKey } from "../lib/store";
import StatusBanner from "./StatusBanner";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/map", label: "Map" },
  { to: "/events", label: "Events" },
  { to: "/facilities", label: "Facilities" },
  { to: "/alerts", label: "Alerts" },
  { to: "/analytics", label: "Analytics" },
  { to: "/architecture", label: "Architecture" },
];

const DATASETS: { key: Dataset; label: string }[] = [
  { key: "live", label: "Live FIRMS" },
  { key: "sample", label: "Sample scenarios" },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, dataset, setDataset, scenario, runScenario, loading } = useSatfire();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = SCENARIOS.find((s) => s.key === scenario);

  const pick = (key: ScenarioKey) => {
    runScenario(key);
    setOpen(false);
    if (pathname !== "/" && pathname !== "/map") navigate("/");
  };

  return (
    <div className="flex h-full min-h-screen flex-col bg-paper text-ink">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-rule bg-card px-4 py-2">
        <Link to="/" className="flex items-baseline gap-2">
          <span className="font-mono text-base font-semibold tracking-tight">SATFIRE</span>
          <span className="hidden text-[11px] text-faint sm:inline">thermal anomaly classification</span>
        </Link>
        <nav className="flex flex-wrap gap-4 text-sm" aria-label="Main">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) => `border-b-2 py-1 ${isActive ? "border-ink text-ink" : "border-transparent text-mute hover:text-ink"}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex border border-ink" role="group" aria-label="Dataset">
            {DATASETS.map((d) => (
              <button
                key={d.key}
                type="button"
                aria-pressed={dataset === d.key}
                onClick={() => setDataset(d.key)}
                className={`px-2.5 py-1 font-mono text-[11px] uppercase ${dataset === d.key ? "bg-ink text-paper" : "text-ink hover:bg-ink/10"}`}
              >
                {d.label}
              </button>
            ))}
          </div>
          {loading && <span className="font-mono text-[10px] text-faint">loading…</span>}
          {active && <span className="hidden font-mono text-[11px] text-mute lg:inline">{active.label} · {active.siteKey}</span>}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="border border-ink px-2.5 py-1 font-mono text-[11px] uppercase hover:bg-ink hover:text-paper"
          >
            {open ? "Close" : "Scenarios"}
          </button>
          {scenario && (
            <button type="button" onClick={() => runScenario(null)} className="font-mono text-[11px] uppercase text-mute underline">
              Clear
            </button>
          )}
          <span className="border-l border-rule pl-2 font-mono text-[11px] text-mute">{user.username}</span>
          <button type="button" onClick={logout} className="font-mono text-[11px] uppercase text-mute underline hover:text-ink">
            Log out
          </button>
        </div>
      </header>

      {open && (
        <div className="border-b border-rule bg-card px-4 py-3">
          <div className="mb-2 text-[11px] text-mute">Each scenario switches to the sample dataset and focuses the event at one site.</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => pick(s.key)}
                className={`border p-2.5 text-left text-xs hover:border-ink ${scenario === s.key ? "border-ink bg-ink/5" : "border-rule"}`}
              >
                <div className="font-semibold">{s.label}</div>
                <div className="mt-0.5 font-mono text-[10px] text-mute">{s.siteKey}</div>
                <div className="mt-1 text-[11px] leading-snug text-mute">{s.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <StatusBanner />
      <main className="min-w-0 flex-1 overflow-y-auto scroll-thin">{children}</main>
    </div>
  );
}
