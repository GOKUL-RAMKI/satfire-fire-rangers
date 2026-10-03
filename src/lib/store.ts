import { createContext, useContext } from "react";
import type {
  AlertRecord,
  Dataset,
  Facility,
  PipelineStatus,
  PolygonCollection,
  SatEvent,
} from "../../shared/types.ts";
import type { User } from "./api";

/** Demo scenarios: each switches to the sample dataset and focuses the event at one site. */
export const SCENARIOS = [
  { key: "code_red", label: "Industrial fire", siteKey: "FAC-001", hint: "Paradip — baseline break, expanding, Code Red rule" },
  { key: "alert", label: "Alert", siteKey: "FAC-003", hint: "Korba — baseline break + growth, awaiting operator" },
  { key: "watch", label: "Watch", siteKey: "FAC-009", hint: "Haldia — heat above baseline, unclear fit" },
  { key: "persistent", label: "Persistent source", siteKey: "FAC-002", hint: "Jamnagar — steady, tiny, hot; no alarm" },
  { key: "cold_start", label: "Cold-start review", siteKey: "FAC-015", hint: "No baseline — never auto-whitelisted" },
  { key: "agri", label: "Agricultural", siteKey: "POLY-AGRI-LDH", hint: "Farmland, field-bound, seasonal prior" },
  { key: "wildfire", label: "Wildfire", siteKey: "POLY-FOR-SIM", hint: "Forest, expanding — route to NDRF / Forest Dept" },
  { key: "mining", label: "Mining", siteKey: "FAC-004", hint: "Quarry, long smear, low T_f — whitelisted" },
  { key: "unmapped", label: "Unmapped candidate", siteKey: "CELL-20.37-72.93", hint: "Industrial-like heat, no map match" },
  { key: "provisional", label: "Provisional", siteKey: "CELL-19.72-85.32", hint: "Low confidence — held, never dropped" },
] as const;

export type ScenarioKey = (typeof SCENARIOS)[number]["key"];

export type Selection = { kind: "event"; id: string } | { kind: "site"; siteKey: string } | null;

export interface SatfireState {
  user: User;
  logout: () => void;
  dataset: Dataset;
  setDataset: (d: Dataset) => void;
  status: PipelineStatus | null;
  events: SatEvent[];
  facilities: Facility[];
  polygons: PolygonCollection | null;
  alerts: AlertRecord[];
  loading: boolean;
  /** Per-resource load failures (e.g. "facilities: 500 ..."). */
  errors: string[];
  reload: () => void;
  selection: Selection;
  selectEvent: (id: string) => void;
  scenario: ScenarioKey | null;
  runScenario: (key: ScenarioKey | null) => void;
  /** Swap one event in place (after an operator review). */
  replaceEvent: (e: SatEvent) => void;
}

export const SatfireContext = createContext<SatfireState | null>(null);

export function useSatfire(): SatfireState {
  const ctx = useContext(SatfireContext);
  if (!ctx) throw new Error("useSatfire outside SatfireContext");
  return ctx;
}

/** Resolve the current selection to an event (scenarios look events up by siteKey). */
export function selectedEvent(events: SatEvent[], selection: Selection): SatEvent | null {
  if (!selection) return null;
  if (selection.kind === "event") return events.find((e) => e.id === selection.id) ?? null;
  const matches = events.filter((e) => e.siteKey === selection.siteKey);
  return matches.sort((a, b) => b.lastDetected.localeCompare(a.lastDetected))[0] ?? null;
}
