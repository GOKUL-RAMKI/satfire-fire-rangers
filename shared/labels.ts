// Class keys, display names, colours, rule precedence and per-class actions (final_plan_v3 §5 Phase 4).

import type { ClassKey, RuleId, Severity, Tier } from "./types.ts";

export const CLASS_LABELS: Record<ClassKey, string> = {
  industrial_fire: "Industrial fire",
  wildfire: "Wildfire",
  agricultural_fire: "Agricultural fire",
  mining: "Mining activity",
  persistent_source: "Persistent industrial thermal source",
  unmapped_industrial_candidate: "Unmapped industrial candidate",
  provisional: "Provisional",
  other: "Other",
};

export const CLASS_COLORS: Record<ClassKey, string> = {
  industrial_fire: "#b42318",
  wildfire: "#c2570c",
  agricultural_fire: "#a16207",
  mining: "#6d3fa0",
  persistent_source: "#0e7490",
  unmapped_industrial_candidate: "#be185d",
  provisional: "#64748b",
  other: "#6b7280",
};

export const CLASS_ORDER: ClassKey[] = [
  "industrial_fire",
  "unmapped_industrial_candidate",
  "wildfire",
  "agricultural_fire",
  "mining",
  "persistent_source",
  "provisional",
  "other",
];

/**
 * Most safety-critical first (checklist §5 PRECEDENCE, plus `industrial_watch` directly after
 * `industrial_fire` — see agents.md deviation b). Every fired rule is logged; the first match wins.
 */
export const PRECEDENCE: RuleId[] = [
  "industrial_fire",
  "industrial_watch",
  "wildfire",
  "agri_off_season",
  "mining",
  "persistent_source",
  "persistent_source_unverified",
  "agri_in_season",
];

export const RULE_TO_CLASS: Record<RuleId, ClassKey> = {
  industrial_fire: "industrial_fire",
  industrial_watch: "industrial_fire",
  wildfire: "wildfire",
  agri_off_season: "agricultural_fire",
  agri_in_season: "agricultural_fire",
  mining: "mining",
  persistent_source: "persistent_source",
  persistent_source_unverified: "persistent_source",
};

/** Action column of the plan's classification table. */
export const CLASS_ACTIONS: Record<ClassKey, string> = {
  industrial_fire: "Tiered alert (Watch / Alert / Code Red).",
  wildfire: "Route coordinates and spread direction to NDRF and Forest Departments.",
  agricultural_fire: "No dispatch. Log for environmental tracking.",
  mining: "Whitelist from alerts. Feed long-term monitoring.",
  persistent_source: "No alarm. Feed emissions estimate and the site baseline.",
  unmapped_industrial_candidate: "Review with the same priority as a matched industrial fire.",
  provisional: "Held as provisional. Never silently dropped, never auto-escalated.",
  other: "Kept with its evidence and surfaced for operator review.",
};

export const TIER_LABELS: Record<Tier, string> = {
  watch: "Watch",
  alert: "Alert",
  code_red: "Code Red",
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: "#b42318",
  HIGH: "#c2570c",
  MEDIUM: "#a16207",
  LOW: "#0e7490",
  INFO: "#6b7280",
};
