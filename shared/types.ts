// SATFIRE v3 shared domain types. One schema for backend, frontend, scripts and tests.
// Pure type declarations only (erasable syntax: no enums, no runtime code).

export type Dataset = "live" | "sample";

// ---------------------------------------------------------------- ingestion

/** One NASA FIRMS CSV row, exactly as the API returns it (all strings). */
export interface FirmsRow {
  latitude?: string;
  longitude?: string;
  bright_ti4?: string; // VIIRS I4 (~3.74 µm) brightness temperature, K
  bright_ti5?: string; // VIIRS I5 (~11.45 µm) brightness temperature, K
  brightness?: string; // MODIS band 21/22 brightness temperature, K
  bright_t31?: string; // MODIS band 31 brightness temperature, K
  scan?: string; // pixel size along scan, km
  track?: string; // pixel size along track, km
  acq_date?: string; // YYYY-MM-DD
  acq_time?: string; // HHMM (UTC), leading zeros may be missing
  satellite?: string;
  instrument?: string;
  confidence?: string; // VIIRS l/n/h, MODIS 0-100
  version?: string;
  frp?: string; // MW
  daynight?: string; // D / N
  type?: string; // standard-processing only: 0 veg, 1 volcano, 2 static land source, 3 offshore
  /** FIRMS source the row was fetched from (e.g. VIIRS_SNPP_NRT). Added by the fetcher. */
  source?: string;
}

export type Instrument = "VIIRS" | "MODIS";
export type Confidence = "l" | "n" | "h";

export interface GateRejection {
  rowIndex: number;
  reason: string;
  detail: string;
  source: string | null;
}

export type DozierStatus = "ok" | "saturated_lower_bound" | "unsolvable" | "invalid" | "not_applicable";

export interface DozierResult {
  status: DozierStatus;
  saturated: boolean;
  /** Solve at the assumed background. Used by the classifier (see agents.md, deviation a). */
  tfCentralC: number | null;
  pCentralPct: number | null;
  /** Spread across the background band. Reported, never collapsed to one number. */
  tfRangeC: [number, number] | null;
  pRangePct: [number, number] | null;
  backgroundK: number;
  backgroundSigmaK: number;
  backgroundSource: "default_300K" | "neighbour_median";
  /** e.g. background_default, partial_range, range_wide, daytime_reflected_solar */
  flags: string[];
}

export interface Detection {
  /** Idempotency key: sensor|acq_time|lat|lon */
  id: string;
  dataset: Dataset;
  sensor: string; // VIIRS_SNPP, VIIRS_NOAA20, VIIRS_NOAA21, MODIS_AQUA, MODIS_TERRA
  instrument: Instrument;
  acqTime: string; // ISO UTC
  lat: number;
  lon: number;
  brightI4K: number | null; // VIIRS I4 or MODIS 21/22
  brightI5K: number | null; // VIIRS I5 or MODIS 31
  frpMW: number;
  scanKm: number | null;
  trackKm: number | null;
  confidence: Confidence;
  dayNight: "D" | "N";
  staticSourceFlag: boolean | null;
  gateStatus: "ok" | "provisional";
  gateFlags: string[];
  dozier: DozierResult;
  /** MODIS detections merged into this VIIRS detection as corroboration. */
  corroboratedBy: string[];
  /** Spatial attribution for this pixel (filled by the spatial join). */
  match: FacilityMatch | null;
  runnerUps: FacilityMatch[];
  bufferM: number;
}

// ---------------------------------------------------------------- geography

export type LandTag = "industrial" | "quarry" | "forest" | "farmland";

export interface FacilityMatch {
  polygonId: string;
  facilityId: string | null;
  name: string | null;
  tag: LandTag;
  distanceM: number;
  rank: number;
  cpcbCategory: CpcbCategory | null;
  source: string;
  refreshedAt: string;
  mappedSince: string | null;
  attributionVersion: number;
  osmTags: Record<string, string>;
}

export type CpcbCategory = "Red" | "Orange" | "Green" | "White";

export interface SiteContext {
  tag: LandTag | null;
  tagSource: "osm_polygon" | "worldcover" | "none";
  match: FacilityMatch | null;
  runnerUps: FacilityMatch[];
  worldCover: string | null;
  worldCoverSource: "sample" | "unavailable";
  spatialBackend: "postgis" | "memory";
  attributionVersion: number;
  facilityType: string | null;
  kiln: boolean;
  /** Polygon layer used for this dataset. */
  polygonSource: string;
  polygonSample: boolean;
}

export interface Facility {
  id: string;
  dataset: Dataset;
  name: string;
  type: string;
  lat: number;
  lon: number;
  state: string;
  cpcbCategory: CpcbCategory | null;
  /** Where the CPCB category comes from. Derived categories are labelled as such. */
  cpcbSource: string;
  routineSources: string[];
  kiln: boolean;
  mappedSince: string | null;
  source: string;
  refreshedAt: string;
  polygonIds: string[];
}

export interface PolygonFeature {
  type: "Feature";
  id: string;
  properties: {
    id: string;
    tag: LandTag;
    facilityId: string | null;
    name: string | null;
    cpcbCategory: CpcbCategory | null;
    source: string;
    refreshedAt: string;
    mappedSince: string | null;
    osmTags: Record<string, string>;
  };
  geometry:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
}

export interface PolygonCollection {
  type: "FeatureCollection";
  features: PolygonFeature[];
}

// ---------------------------------------------------------------- history

export type HistoryPattern = "CONSISTENT" | "SEASONAL" | "LONG_SMEAR" | "SPORADIC" | "NONE";

export interface HistoryRecord {
  siteKey: string;
  acqTime: string;
  lat: number;
  lon: number;
  frpMW: number;
}

export interface SiteHistory {
  siteKey: string;
  source: string;
  sample: boolean;
  records: number;
  activeDays: number;
  spanDays: number;
  firstSeen: string | null;
  lastSeen: string | null;
  monthsActive: number;
  monthHistogram: number[]; // 12 entries, Jan..Dec, active days per calendar month
  pattern: HistoryPattern;
  recurrence: string;
  historySpreadM: number | null;
  baselineFrpMW: number | null;
  baselineSource: "isolation_forest" | "median" | "none";
  currentFrpMW: number;
  /** null = cold start (no baseline). */
  deviationX: number | null;
  coldStart: boolean;
  coldStartReason: string | null;
  series: { month: string; activeDays: number; medianFrpMW: number | null }[];
}

// ---------------------------------------------------------------- kinematics

export type SpatialPattern =
  | "single-pixel"
  | "static-compact"
  | "dispersed"
  | "linear-field"
  | "radial-expansion"
  | "irregular-expansion";

export interface Kinematics {
  pattern: SpatialPattern;
  expanding: boolean;
  pixels: number;
  overpasses: number;
  spreadM: number;
  elongation: number;
  pixelGrowth: number; // last overpass pixels / first overpass pixels
  spreadGrowthM: number;
  spreadBearingDeg: number | null;
  overpassSeries: { t: string; pixels: number; frpMW: number; spreadM: number }[];
}

// ---------------------------------------------------------------- classification

export type ClassKey =
  | "industrial_fire"
  | "wildfire"
  | "agricultural_fire"
  | "mining"
  | "persistent_source"
  | "unmapped_industrial_candidate"
  | "provisional"
  | "other";

export type RuleId =
  | "industrial_fire"
  | "industrial_watch"
  | "wildfire"
  | "agri_off_season"
  | "mining"
  | "mining_cold_start"
  | "persistent_source"
  | "persistent_source_unverified"
  | "agri_in_season";

export type Tier = "watch" | "alert" | "code_red";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface ScoreBreakdown {
  thermal: number; // /30
  spatial: number; // /25
  historical: number; // /20
  kinematic: number; // /15
  verification: number; // /10
  total: number; // /100
}

export interface RuleTrace {
  rule: RuleId;
  fired: boolean;
  detail: string;
}

export interface SeasonInfo {
  inSeason: boolean;
  baseline: "osm_crop_tag" | "regional_default";
  region: string;
  windows: string;
}

export interface Classification {
  label: ClassKey;
  winningRule: RuleId | null;
  fired: RuleId[];
  flags: string[];
  ruleTrace: RuleTrace[];
  tier: Tier | null;
  tierReason: string;
  codeRedRule: { satisfied: boolean; checks: { name: string; ok: boolean; detail: string }[] };
  needsReview: boolean;
  reviewReason: string | null;
  /** Triage order inside the review queue. Null when no review is needed. */
  reviewPriority: "high" | "medium" | "low" | null;
  /** Provisional sub-flavor for triage. Null unless the label is provisional. */
  provisionalKind: "low_confidence" | "unsolvable_cool" | "modis_only" | null;
  action: string;
  confidence: ScoreBreakdown;
  evidenceFor: string[];
  evidenceAgainst: string[];
  season: SeasonInfo | null;
}

export type SarStatus =
  | "supports"
  | "does_not_support"
  | "pending"
  | "not_requested"
  | "sar_baseline_unavailable"
  | "not_available";

export interface SarCheck {
  status: SarStatus;
  coherenceDrop: number | null;
  preDate: string | null;
  postDate: string | null;
  detail: string;
  sample: boolean;
}

export interface Review {
  dataset: Dataset;
  eventId: string;
  decision: "confirm" | "reject";
  label: ClassKey;
  note: string;
  by: string;
  at: string;
}

export type Lifecycle = "active" | "quiet" | "extinguished";

export interface SatEvent {
  id: string;
  dataset: Dataset;
  siteKey: string;
  placeName: string;
  lat: number;
  lon: number;
  firstDetected: string;
  lastDetected: string;
  lifecycle: Lifecycle;
  quietHours: number;
  detections: Detection[];
  observationCount: number;
  peakFrpMW: number;
  /** Dozier result of the peak-FRP VIIRS detection. */
  dozier: DozierResult;
  context: SiteContext;
  history: SiteHistory;
  kinematics: Kinematics;
  classification: Classification;
  severity: Severity;
  sar: SarCheck;
  review: Review | null;
  wildfireRoute: { bearingDeg: number | null; recipients: string[] } | null;
}

// ---------------------------------------------------------------- alerts

export type AlertKind = "watch" | "alert" | "code_red" | "wildfire_route";

export type DispatchStatus =
  | "pending"
  | "sent"
  | "failed"
  | "not_configured"
  | "not_dispatched"
  | "suppressed_sample";

export interface AlertRecord {
  id: string;
  dataset: Dataset;
  eventId: string;
  kind: AlertKind;
  label: ClassKey;
  placeName: string;
  lat: number;
  lon: number;
  createdAt: string;
  summary: string;
  sitrep: { text: string; phrasing: "template" | "llm"; note: string };
  dispatch: {
    status: DispatchStatus;
    attempts: number;
    lastError: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    sentAt: string | null;
  };
}

// ---------------------------------------------------------------- status

export interface PipelineRunStats {
  at: string;
  durationMs: number;
  rows: number;
  accepted: number;
  rejected: number;
  provisional: number;
  merged: number;
  duplicates: number;
  events: number;
  firmsError: string | null;
}

export interface PipelineStatus {
  dataset: Dataset;
  sample: boolean;
  firmsConfigured: boolean;
  llm: {
    enabled: boolean;
    configured: boolean;
    model: string;
    callsLastHour: number;
    callsToday: number;
    spendTodayUsd: number;
    ceilings: { perHour: number; perDay: number; dailyBudgetUsd: number };
  };
  webhookConfigured: boolean;
  spatialBackend: "postgis" | "memory";
  store: "postgis" | "file";
  polygons: { count: number; source: string; sample: boolean; refreshedAt: string | null };
  worldCover: "sample" | "unavailable";
  history: { source: string; baselines: string };
  sar: "sample" | "not_available";
  lastRun: PipelineRunStats | null;
  rejections: GateRejection[];
  heartbeat: { lastSuccessfulPull: string | null; ageMinutes: number | null; warning: string | null };
  scheduler: { enabled: boolean; windowsUtc: string; inWindow: boolean; nextRunAt: string | null };
  referenceNow: string;
}

export interface BacktestReport {
  generatedAt: string;
  dataset: string;
  sample: boolean;
  caveat: string;
  windows: { name: string; label: ClassKey; start: string; end: string; detections: number }[];
  perClass: { label: ClassKey; precision: number | null; recall: number | null; support: number; predicted: number }[];
  industrialFireRecall: number | null;
  falseIndustrialAlertsPerWeek: number | null;
  weeksCovered: number;
  confusion: { truth: ClassKey; predicted: ClassKey; count: number }[];
  failures: { window: string; eventId: string; truth: ClassKey; predicted: ClassKey; why: string }[];
}
