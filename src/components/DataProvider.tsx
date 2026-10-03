import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AlertRecord, Dataset, Facility, PipelineStatus, PolygonCollection, SatEvent } from "../../shared/types.ts";
import { api, errorText, type User } from "../lib/api";
import { SatfireContext, type SatfireState, type ScenarioKey, SCENARIOS, type Selection } from "../lib/store";

interface Loaded {
  key: string;
  dataset: Dataset;
  status: PipelineStatus | null;
  events: SatEvent[];
  facilities: Facility[];
  polygons: PolygonCollection | null;
  alerts: AlertRecord[];
  errors: string[];
}

const STATUS_POLL_MS = 60_000;

export default function DataProvider({
  user,
  initialDataset,
  initialStatus,
  onLogout,
  children,
}: {
  user: User;
  initialDataset: Dataset;
  initialStatus: PipelineStatus | null;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [dataset, setDatasetState] = useState<Dataset>(initialDataset);
  const [data, setData] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [scenario, setScenario] = useState<ScenarioKey | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(initialStatus);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    const key = `${dataset}|${tick}`;
    const settle = async <T,>(name: string, p: Promise<T>, fallback: T, errs: string[]): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        errs.push(`${name}: ${errorText(e)}`);
        return fallback;
      }
    };
    (async () => {
      const errs: string[] = [];
      // The live polygon layer is national scale (225k features): it is fetched
      // per map viewport by MapView, never whole. Sample (19 features) loads here.
      const [st, events, facilities, polygons, alerts] = await Promise.all([
        settle("status", api.status(dataset), null, errs),
        settle("events", api.events(dataset), [] as SatEvent[], errs),
        settle("facilities", api.facilities(dataset), [] as Facility[], errs),
        dataset === "sample" ? settle("polygons", api.polygons(dataset), null, errs) : Promise.resolve(null),
        settle("alerts", api.alerts(dataset), [] as AlertRecord[], errs),
      ]);
      if (id !== reqId.current) return;
      if (st) setStatus(st);
      setData({ key, dataset, status: st, events, facilities, polygons, alerts, errors: errs.filter((e) => !e.includes("unauthorized")) });
    })();
  }, [dataset, tick]);

  // Heartbeat: keep the status banner fresh.
  useEffect(() => {
    const t = window.setInterval(() => {
      api.status(dataset).then(setStatus).catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(t);
  }, [dataset]);

  const setDataset = useCallback(
    (d: Dataset) => {
      if (d === dataset) return;
      setSelection(null);
      setScenario(null);
      setDatasetState(d);
    },
    [dataset],
  );

  const runScenario = useCallback((key: ScenarioKey | null) => {
    setScenario(key);
    if (!key) return;
    const s = SCENARIOS.find((x) => x.key === key);
    if (!s) return;
    setDatasetState("sample");
    setSelection({ kind: "site", siteKey: s.siteKey });
  }, []);

  const selectEvent = useCallback((id: string) => {
    setSelection({ kind: "event", id });
    setScenario(null);
  }, []);

  const replaceEvent = useCallback((e: SatEvent) => {
    // Keep the list's (possibly trimmed) detections; the evidence panel fetches the full detail route.
    setData((prev) => (prev ? { ...prev, events: prev.events.map((x) => (x.id === e.id ? { ...e, detections: x.detections } : x)) } : prev));
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const logout = useCallback(() => {
    api
      .logout()
      .catch(() => undefined)
      .finally(onLogout);
  }, [onLogout]);

  // Only expose data that belongs to the current dataset (avoid flashing the other dataset's rows).
  const current = data && data.dataset === dataset ? data : null;

  const value = useMemo<SatfireState>(
    () => ({
      user,
      logout,
      dataset,
      setDataset,
      status,
      events: current?.events ?? [],
      facilities: current?.facilities ?? [],
      polygons: current?.polygons ?? null,
      alerts: current?.alerts ?? [],
      loading: !current || data?.key !== `${dataset}|${tick}`,
      errors: current?.errors ?? [],
      reload,
      selection,
      selectEvent,
      scenario,
      runScenario,
      replaceEvent,
    }),
    [user, logout, dataset, setDataset, status, current, data, tick, reload, selection, selectEvent, scenario, runScenario, replaceEvent],
  );

  return <SatfireContext.Provider value={value}>{children}</SatfireContext.Provider>;
}
