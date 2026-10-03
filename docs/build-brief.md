# SATFIRE — SIH26162 Prototype Build & UX Brief (v3)

> **Aligned to final_plan_v3.md on 2026-09-29; where this brief and the plan differ, the plan wins.**

This is the build and UX brief for the SATFIRE dashboard prototype for Smart India Hackathon 2026, problem **SIH26162 — AI-Based Detection and Classification of Industrial Fires and Persistent Thermal Sources Using NASA FIRMS, OSM & Satellite Data** (NTRO).

The prototype is a working system, not a UI with typed-in answers:

* The **thermal feed** is live NASA FIRMS, fetched by the backend, whenever a FIRMS key is configured. Otherwise the **sample dataset** is used, and it is labelled as sample everywhere it appears.
* The **quality gate, Dozier unmixing, spatial join, site history, rule classification, rule trace, evidence score, event lifecycle, alert tiers and dispatch** are real computations. They run on live and sample data alike, through one ingest path.
* Anything that is not live yet (Sentinel-1 SAR, geostationary tracking, wind) is either shown with a **SAMPLE DATA** badge or marked **Roadmap**. It is never presented as a live integration.

---

# 1. SOURCE DOCUMENTS

Read these completely before writing code.

| Document | Role |
|---|---|
| `final_plan_v3.md` (copy in `docs/solution-plan.md`) | The final product spec and submission document. **Primary source of truth.** |
| `docs/problem-statement.md` | Official SIH26162 problem statement text. |
| `v3_execution_checklist.md` | Internal build order, reference code, and the "Do Not Say" list. Not submitted. |
| `shared/types.ts`, `shared/labels.ts`, `shared/classify.ts` | Exact names for classes, rules, tiers, statuses and actions. The UI must use these, not its own copies. |

Do not invent a different problem statement, and do not change the SATFIRE architecture. The root `SIH26162_Problem_Statement.md` is an unofficial blueprint. It is not authoritative; the PS does not require PostGIS, Twilio or Celery.

### SATFIRE Tech Stack (final_plan_v3 §4)

* **Backend API:** Node.js / TypeScript (Node 24, run natively via type stripping: `node backend/server.ts`)
* **Shared engine:** pure TypeScript in `shared/`, imported by backend, frontend, scripts and tests, so there is one implementation of the rules
* **Frontend:** React, TypeScript, Vite, Leaflet.js (react-leaflet), Tailwind CSS, Recharts
* **Spatial database:** PostgreSQL + PostGIS (Docker, localhost only), with an in-memory join of identical semantics when no DB is configured
* **Batch analytics and backtesting:** Python (GeoPandas, Shapely, Rasterio, scikit-learn: Isolation Forest, DBSCAN, gradient boosting)
* **LLM (phrasing only):** Gemini API, with rate and cost ceilings. It rephrases the SITREP template and nothing else.
* **Data:** NASA FIRMS, OpenStreetMap, ESA WorldCover, open industrial-facility datasets, CPCB Red Category list, Sentinel-1 (Copernicus; sample data now, live on the roadmap), INSAT via MOSDAC (roadmap)

---

# 2. CORE PROBLEM

Satellite thermal-anomaly feeds such as NASA FIRMS report hotspots but cannot tell apart:

1. Agricultural fire
2. Wildfire
3. Mining activity
4. Persistent industrial thermal source (flares, furnaces, kilns, power plants)
5. Industrial fire
6. Other (an honest bucket for anything that fits no class)

Under simple brightness thresholding, a stubble fire, a quarry's heat and a flare stack all look thermally similar to an early-stage industrial fire. SATFIRE combines three kinds of evidence to separate them:

* **Physics** of the thermal signal: temperature, sub-pixel area, brightness (Dozier unmixing, FRP)
* **Geography** of the location: what is built on that land (OSM, ESA WorldCover, facility databases)
* **History** of the specific site: whether this has happened here before, and how often

The result is a continuously monitored, low-false-positive alert layer, bounded by satellite revisit cadence. It cuts alert fatigue and flags probable industrial fires for verification and dispatch. It does **not** claim to catch every fire the instant it starts.

The PS asks for (i) classification and segregation of industrial fires from forest and other natural fires, and (ii) GIS-based storage and map overlay of the outputs. Keep both visible throughout the prototype.

---

# 3. WHAT IS REAL AND WHAT IS SAMPLE

This replaces the old prototype-constraint section. The prototype runs the real pipeline. The only thing that switches is where the input comes from.

### Datasets

| Mode | Input | Labelling |
|---|---|---|
| **Live FIRMS** | Backend fetches VIIRS_SNPP, NOAA20, NOAA21 and MODIS_NRT for the configurable India bounding box when `FIRMS_MAP_KEY` is set | Normal |
| **Sample scenarios** | `data/sample/firms_raw.json`, in the FIRMS CSV schema, forward-modelled from scenario parameters | **SAMPLE DATA** badge on every view that shows it |

Both modes go through the same quality gate → Dozier → spatial join → history → classifier → lifecycle → tiers path. There is no separate "demo engine".

### Real computations (never typed in)

* Quality gate with logged rejection reasons
* Dozier two-band solve per detection at ingestion: central value, range across the background band, saturation and status flags
* Spatial join, nearest-first, with runner-ups stored (PostGIS or in-memory)
* Site history, baseline and deviation; cold-start detection
* Rule classification with precedence, full rule trace, evidence for and against
* Evidence score (thermal / spatial / historical / kinematic / verification)
* Event linking and lifecycle (active / quiet / extinguished)
* Alert tiers, the explicit Code Red rule, operator review
* DB-first alert storage and webhook dispatch with retry
* Template SITREP (optionally LLM-rephrased, fact-checked)

### Sample or reference layers (always badged)

Sample data lives in `data/sample/`, not `public/`, so Vite cannot serve it around the login gate. The backend is the single source and labels sample data itself.

```text
data/sample/
    firms_raw.json               FIRMS-CSV-shaped detections (incl. deliberately bad rows)
    landuse_polygons.geojson     sample OSM-style land-use and facility polygons
    facilities.json              facility metadata, mapped_since, source, refreshed_at
    site_history.json            12 months of prior detections per site
    sentinel1_sample.json        post-event SAR check results (sample)
    cpcb_categories.json         CPCB category per industry type (derived, labelled as such)
    landcover.json               WorldCover classes (sample)
```

A `SampleBadge` component goes on every sample or fallback layer: dataset mode, Sentinel-1, sample polygons, WorldCover, sample history. The CPCB category is derived from industry type. Label it "derived, not an official per-facility record".

### Backend modules (replace the old service-interface list)

```text
backend/  server.ts, config, auth, firms, pipeline, history,
          spatial/{memory,postgis}.ts, store/{file,postgis}.ts,
          dispatch, llm, scheduler, osm
shared/   types, labels, geo, qualityGate, dozier, season, kinematics,
          lifecycle, classify, sitrep
```

---

# 4. MAIN PROTOTYPE OBJECTIVE

A user who logs in should immediately understand:

> "This system receives satellite thermal anomalies, filters bad data, combines physical, geographic and historical evidence, classifies each event with a visible rule trace, tiers the industrial ones for operator review, and shows it all on a GIS dashboard."

It should feel like a real geospatial intelligence / disaster-monitoring platform, not a generic CRUD dashboard.

---

# 5. APPLICATION STRUCTURE

## 0. Login

The dashboard shows live industrial-site data, so it sits behind a login gate:

* scrypt password hash, HMAC session cookie (HttpOnly, SameSite=Strict), rate-limited logins
* Every `/api/*` route except `/api/health` and `/api/auth/*` requires a session

Role-based access and an audit log are **roadmap**.

## A. Overview / Command Center

All numbers are **computed from the current dataset**. No hardcoded counts or FRP arrays. Show:

* Active thermal anomalies / events
* Industrial facilities monitored
* Industrial-fire events by tier (Watch / Alert / Code Red)
* Persistent industrial thermal sources (routine)
* Events needing manual review (cold start, unmapped candidate, provisional, other, off-season agriculture)
* Recent detections
* Classification distribution

### System Status

Driven by `/api/status`, never hardcoded "connected". Example, sample mode without keys:

```text
DATASET             SAMPLE DATA (21–23 Apr 2026)
FIRMS FEED          not configured          (live when FIRMS_MAP_KEY is set)
SPATIAL JOIN        in-memory               (postgis when DB configured)
ALERT STORE         file (data/runtime)     (postgis when DB configured)
POLYGONS            N polygons, sample      [SAMPLE DATA]
WORLDCOVER          sample                  [SAMPLE DATA]
SENTINEL-1          sample                  [SAMPLE DATA]
LLM PHRASING        enabled / configured, calls this hour / today, spend vs ceiling
WEBHOOK             configured / not configured
HEARTBEAT           last successful FIRMS pull, age, warning if stale
SCHEDULER           overpass windows (UTC), in window, next run
```

Also show the quality-gate log from `/api/pipeline/status`: rows, accepted, rejected (with reasons), provisional, merged, duplicates.

---

# 6. PRIMARY GIS MAP

The map is the central component. Use Leaflet (react-leaflet).

### Thermal detections and events

Colour by class, using `CLASS_COLORS` from `shared/labels.ts`:

* Industrial fire
* Unmapped industrial candidate
* Wildfire
* Agricultural fire
* Mining activity
* Persistent industrial thermal source
* Provisional
* Other

Filterable by class, tier, dataset and lifecycle.

### Industrial facilities

Show the facility layer as polygons, not just markers. Sample polygons carry a SAMPLE DATA badge.

### Event clusters

Detections linked into one event cluster visually.

### Industrial fire

Industrial-fire events show their tier prominently. Code Red is the most prominent, then Alert, then Watch.

---

# 7. MAP INTERACTION — EVIDENCE PANEL

Clicking an event opens the evidence panel.

### Detection

```text
Event ID            EVT-<siteKey>-<yyyymmdd>
First / last detected
Latitude / Longitude
Sensor(s)           VIIRS_SNPP / NOAA20 / NOAA21, MODIS corroboration if merged
FIRMS confidence    l / n / h (capped if high scan angle)
FRP (peak)
Day / Night
Gate flags          e.g. high_scan_angle, provisional
```

### Thermal physics (per detection)

A table, one row per detection, with the pipeline's Dozier output:

```text
I4 (K) | I5 (K) | T_f central | T_f range | p central | p range | status | flags
```

`status` is one of `ok`, `saturated_lower_bound`, `unsolvable`, `invalid`, `not_applicable`.

These values are computed at ingestion. Do not mark them as demo-derived. On sample data they are computed from forward-modelled inputs, and the panel carries the SAMPLE DATA badge.

### Also in the panel

* All fired rules and the precedence winner (rule trace)
* Classification flags
* Runner-up facilities
* Provenance: source, `refreshed_at`, attribution version, CPCB derivation
* Site history
* Evidence-score breakdown
* Tier and tier reason
* SITREP, marked template or LLM-phrased
* Operator confirm / reject buttons
* SAR post-event check ("supports" / "does not support") with a SAMPLE DATA badge

---

# 8. DOZIER PHYSICS VISUALIZATION

A dedicated section explaining the sub-pixel solve:

```text
VIIRS pixel
      ↓
I4 (~3.74 µm) + I5 (~11.45 µm) brightness temperatures
      ↓
Quality gate (invalid bands rejected, never defaulted to zero)
      ↓
Two-band Planck solve at background ± σ
      ↓
Fire temperature (T_f) range  +  sub-pixel fire area (p) range
      + saturation flag, status
```

Show I4, I5, the T_f and p central values and ranges, saturation, status and flags.

Behaviour the UI must reflect:

* **Ranges, not false precision.** The solve is repeated across a background band, and the spread is reported. Never show `T_f = 1347.2938 °C`. Show, for example:

  ```text
  Estimated fire temperature     1,150–1,320 °C  (central ~1,230 °C)
  Estimated sub-pixel area       0.8–1.6 %
  ```

* **Classifier input.** The classifier uses the central solve plus the saturation flag. The range feeds reporting and confidence only. A `range_wide` flag lowers thermal confidence; `partial_range` is also flagged.
* **Background.** FIRMS provides no neighbouring pixels, so background defaults to 300 K. This is flagged `background_default` on every solve.
* **Saturation.** VIIRS I4 saturates near **367 K**. Saturated pixels get `saturated_lower_bound`, and T_f is shown as "≥ lower bound". The classifier then leans on the saturation flag, FRP and footprint growth.
* **Unsolvable.** An unsolvable pixel shows "unsolvable", never a guessed value.
* **Daytime passes.** Flagged `daytime_reflected_solar`, since I4 includes reflected sunlight.

Make the distinction between measurement (I4, I5, FRP) and estimate (T_f, p) clear.

---

# 9. GEOSPATIAL CONTEXT

For every selected event, show the geographic evidence the spatial join produced:

```text
Land-use tag        industrial            (source: OSM polygon | WorldCover | none)
Facility            Paradip Petrochemical Processing Complex (FAC-001)
Distance            inside (0 m)          | or "N m from boundary"
CPCB category       Red (derived from industry type)
Runner-ups          FAC-xxx at N m  ...   (if more than one polygon matched)
Provenance          source, refreshed_at, attribution version
Spatial backend     postgis | memory
```

How the join works:

* PostGIS `ST_DWithin` on geography, nearest-first; rank 1 wins, ranks 2–3 are stored as runner-ups. No match means unmapped.
* **Fence-line buffer:** `min(50 m, √(p·A_pix/π))`, using the Dozier area estimate. Falls back to 50 m when unsolved.
* **Tag order:** OSM polygon first, then WorldCover (tree cover → forest, cropland → farmland, built-up → no tag, i.e. unmapped).
* When polygons change, stored detections are re-attributed and the attribution version is bumped.

The goal is to show that the system does not classify from temperature alone.

---

# 10. HISTORICAL / PERSISTENCE ANALYSIS

For the selected site, show:

* Active days, span, first and last seen
* Month histogram → seasonality
* Pattern: `CONSISTENT`, `SEASONAL`, `LONG_SMEAR`, `SPORADIC` or `NONE`
* Recurrence
* Baseline FRP (median, or Isolation Forest inliers when `data/derived/site_baselines.json` exists) and its source
* Current FRP and **deviation ×** baseline

Examples:

```text
Jamnagar (FAC-002), persistent source    pattern CONSISTENT, deviation ~1×
Paradip (FAC-001), industrial fire       pattern CONSISTENT, deviation far above 5×
FAC-015 (newly mapped)                   COLD START: no baseline, manual review
```

**Cold start.** A site with under 90 days of history, or whose polygon was mapped under 90 days ago, has no baseline (`deviationX = null`). It is **never auto-whitelisted as routine**; it is routed to manual review. Show this state explicitly. Do not hide it behind a default deviation.

---

# 11. CLASSIFICATION ENGINE

A transparent rule engine (`shared/classify.ts`). There is no neural network. The LLM **never** classifies and never gates an alert.

Starting with explainable rules is a design decision. A learned model replaces the rules only when it beats them on an operator-labelled gold set (Phase 8, **roadmap**).

For every event show:

```text
CLASSIFICATION      Industrial fire
TIER                Code Red (explicit rule: thermal, spatial, kinematic and historical signals all agree)
EVIDENCE SCORE      NN / 100   (evidence score, not a probability)

RULES FIRED         industrial_fire  ← precedence winner
                    (full trace of every rule, fired or not, with its inputs)

EVIDENCE FOR
✓ Inside Paradip Petrochemical Processing Complex (industrial, sample polygon)
✓ I4 saturated: T_f is a lower bound; classification leans on saturation, FRP and footprint
✓ Site history CONSISTENT, baseline N MW, current N MW (N×)
✓ Kinematics: radial-expansion over 6 overpasses, expanding
✓ Sentinel-1 post-event check supports the thermal classification (sample data)

EVIDENCE AGAINST / CAUTION
○ Background fixed at 300 K default: flagged
○ Ambiguous attribution: N runner-up polygon(s) within buffer
```

The user must be able to see **why** the event got its label: which rules fired, and which one won on precedence.

---

# 12. CLASSIFICATION CLASSES

Use exactly these classes, from `shared/labels.ts` and the plan's Phase 4 table.

| Class | Spatial anchor | Thermal signature | Temporal / spatial behaviour | Action |
|---|---|---|---|---|
| **Agricultural fire** | Farmland (OSM, WorldCover cropland) | Large p, low T_f (~300–500 °C) | In season; burns out in ~24–48 h; field-bound | No dispatch. Log for environmental tracking. |
| **Wildfire** | Forest, wood, national park | Growing p, medium-to-high T_f | Sudden vs site history; multi-pixel expansion | Route coordinates and spread direction to NDRF and Forest Departments. |
| **Mining activity** | Quarry or mine polygons | Low-to-medium p, low sustained T_f | Months to years, static or very slow | Whitelist from alerts. Feed long-term monitoring. |
| **Persistent industrial thermal source** | Industrial polygons, facility-database points, static-source flag; brick kilns get a seasonal check | Very small p, very high or saturated | Steady, repeating; static one-pixel footprint | No alarm. Feed emissions estimate and the site baseline. |
| **Industrial fire** | Inside an industrial polygon or facility footprint | Growing footprint with very high or saturated readings | FRP and footprint break the site's baseline; expanding | Tiered alert (Watch / Alert / Code Red). |

### Additional states

| State | When | Handling |
|---|---|---|
| **Unmapped industrial candidate** (`unmapped_industrial_candidate`) | Industrial-like (hot) signature, no map match | Never sent to "Other". Alert tier; same review priority as a matched industrial fire. |
| **Persistent source, unverified** (`persistent_source_unverified` rule) | Persistent signature at a cold-start site | Shown under Persistent industrial thermal source but **never auto-whitelisted**; manual review. |
| **Provisional** (`provisional`) | Low-confidence detection (e.g. near water or cloud edges), or Dozier status that cannot inform a label | Held. Never silently dropped, never auto-escalated. |
| **Other** (`other`) | Fits no class | Kept with its evidence; surfaced for operator review. |

### Precedence

When several rules fire, the most safety-critical wins, and every fired rule is logged:

`Industrial fire > Wildfire > Agricultural (off-season) > Mining > Persistent source > Agricultural (in-season) > Other`

The engine's rule order (`PRECEDENCE` in `shared/labels.ts`) is:

```text
industrial_fire, industrial_watch, wildfire, agri_off_season, mining,
persistent_source, persistent_source_unverified, agri_in_season   → else other
```

### Starting thresholds

These are tuned on data in Phase 8. Show them in the rule trace; don't hide them.

* **hot:** saturated, or central T_f ≥ 800 °C
* **tiny:** central p < 0.1 % of the pixel
* **industrial_fire:** industrial, expanding, hot, and (deviation ≥ 3× or cold start)
* **industrial_watch:** industrial and hot, not a fire, with expanding, kiln off-season, or deviation ≥ 1.5× (single hot heat at a cold-start site that isn't tiny also counts). Classed as Industrial fire at Watch tier.
* **persistent_source:** industrial, static, hot, tiny, deviation < 1.5×, not cold start
* **mining:** quarry, `LONG_SMEAR` history, not saturated, central T_f < 400 °C
* **wildfire:** forest, irregular or radial expansion
* **agricultural:** farmland, linear-field or field-bound (single or compact, not expanding) pattern; split in / off season by the seasonal prior

### Seasonal prior

* **Punjab / Haryana / western UP calendar:** Apr–May and Oct–Nov.
* **Default India calendar:** Mar–May and Oct–mid-Dec.
* **Crop tag present:** an OSM `crop=*` tag gives `seasonal_baseline=osm_crop_tag`.
* **No crop tag** (most farmland polygons): the regional default applies, and the event is flagged `seasonal_baseline=regional_default`, which lowers its weight.
* **Off-season agriculture** outranks mining and persistent sources on precedence, and is routed to review.

### Brick kilns

Kiln heat outside the operating season (roughly Nov–Jun) is flagged `kiln_off_season` and is never whitelisted as routine.

### Alert tiers (industrial fire)

* **Watch:** a single detection above baseline, or an unclear fit. Logged and monitored.
* **Alert:** baseline-breaking heat plus footprint growth, or a cold-start site that is expanding and hot. Sent to operators for verification. Unmapped industrial candidates also sit here.
* **Code Red:** set in one of two ways.
  * **Operator confirmation:** an operator confirms an Alert. (Confirming a Watch raises it to Alert; rejecting clears the tier.)
  * **Explicit rule:** every check passes. Thermal: hot and deviation ≥ 5×. Spatial: inside a mapped facility with CPCB Red category. Kinematic: expanding over ≥ 3 overpasses. Historical: not cold start.

  **SAR is never part of the Code Red trigger.** Show the four rule checks with pass or fail in the panel.

---

# 13. EVIDENCE SCORE

An evidence breakdown, not a mysterious AI score:

```text
Evidence score (not a probability)

Thermal        NN / 30
Spatial        NN / 25
Historical     NN / 20
Kinematic      NN / 15
Verification   NN / 10   (post-event SAR "supports"; sample data now)
──────────────────────
Total          NN / 100

Rule-based evidence score, not a probability
```

Never label it "NN% probability" or "confidence NN%". The score is separate from the tier. A high verification component does not raise the tier, because SAR is not in the trigger.

---

# 14. EVENT LIFECYCLE

Detections are linked into one event when they are close in space and time. The linking is DBSCAN-style and overpass-aware (1.5 km, 24 h).

```text
Detection (VIIRS, D1)
Detection (VIIRS, N1)
Detection (MODIS, same pass window) → merged as corroboration, VIIRS primary
Detection (VIIRS, D2)
        ↓
   EVT-FAC-001-20260421
```

Show:

```text
First detected
Last detected
Observations / overpasses
FRP trend (supporting signal; varies with viewing angle and sensor)
Spatial pattern and spread bearing
Lifecycle status
```

Lifecycle statuses (`shared/types.ts`):

* **active**
* **quiet:** 24–72 h with no detection
* **extinguished:** more than 72 h quiet. One missed overpass (e.g. cloud) never closes a live event.

Operator review state (confirmed / rejected / needs review) is shown alongside, not as a lifecycle status.

**Roadmap:** the INSAT geostationary thermal curve between VIIRS passes. When it is added, eclipse-season gaps are flagged `diurnal_data_unavailable` and are never read as "no escalation".

---

# 15. INDUSTRIAL FIRE INCIDENT PAGE

```text
┌────────────────────────────────────────────────┐
│ INDUSTRIAL FIRE — CODE RED   [SAMPLE DATA]      │
│ EVT-FAC-001-20260421                            │
├───────────────────────┬────────────────────────┤
│ MAP                   │ INCIDENT SUMMARY        │
│ detections by overpass│ Facility, CPCB category │
│ facility polygon      │ Classification, tier    │
│ spread bearing        │ Evidence score          │
│                       │ Lifecycle, review state │
├───────────────────────┴────────────────────────┤
│ THERMAL ANALYSIS (from per-detection Dozier)    │
│ FRP timeline · T_f range timeline · p timeline  │
├────────────────────────────────────────────────┤
│ POST-EVENT CHECK: Sentinel-1  [SAMPLE DATA]     │
│ supports / does not support                     │
├────────────────────────────────────────────────┤
│ RULE TRACE & EVIDENCE · CODE RED RULE CHECKS    │
├────────────────────────────────────────────────┤
│ SITREP (template / LLM-phrased) · DISPATCH      │
└────────────────────────────────────────────────┘
```

Timelines come from the real per-detection Dozier output, not a fabricated series. The indicative downwind wedge is **roadmap**. If it is ever shown, label it "indicative, not a dispersion model".

---

# 16. SPATIAL / KINEMATIC ANALYSIS

`shared/kinematics.ts` derives each event's pattern from its detections:

```text
Detections → overpass-aware clustering → event footprint → expansion analysis
```

Patterns are `single-pixel`, `static-compact`, `dispersed`, `linear-field`, `radial-expansion` and `irregular-expansion`. The module also derives `expanding`, pixel growth, spread growth, spread bearing and an overpass series.

Show visually:

* **Industrial fire:** radial or expanding footprint (Paradip, Korba)
* **Persistent source:** static one-pixel footprint (Jamnagar, Kakinada)
* **Wildfire:** irregular expansion (Similipal) or radial growth in place (Uttarakhand)
* **Agricultural:** linear along field rows (Ludhiana) or a single field-bound pixel (Karnal)

These are computed from the detections in the dataset, sample or live.

---

# 17. SENTINEL-1 POST-EVENT CHECK

Sentinel-1 SAR coherence before and after an event looks for structural or surface change. Revisit is measured in days, so it is a **post-event confirmation layer, not a live trigger**.

```text
POST-EVENT CHECK   [SAMPLE DATA]

Thermal classification (already made, already tiered)
        +
Sentinel-1 coherence, pre vs post pass
        ↓
supports / does not support the thermal classification
```

Statuses (`SarStatus`):

* `supports`
* `does_not_support`
* `pending` (post-event pass not yet acquired)
* `not_requested`
* `sar_baseline_unavailable` (no pre-event baseline, e.g. a new facility; the system relies on thermal and spatial evidence and says so)
* `not_available`

Rules:

* Wording is "supports" or "does not support". Never "verified", "POSITIVE" or "confirmed".
* It is never part of the Code Red trigger.
* It currently comes from `data/sample/sentinel1_sample.json`, always with a SAMPLE DATA badge.
* Live Sentinel-1 fetch and coherence processing is **roadmap**.

---

# 18. FACILITY PROFILE

```text
Facility name, ID (FAC-xxx)
Facility type
Location, state
CPCB category (derived from industry type, labelled)
Land-use polygon(s), OSM tags
WorldCover class
mapped_since, source, refreshed_at
Routine sources (e.g. flare stack, blast furnace, boiler stack)
Site history (pattern, baseline, active days)
Current events and tiers
Cold-start status if applicable
```

Include a facility thermal-history chart (monthly active days and median FRP from site history), so the user can see why the current event is or isn't anomalous against the facility's normal behaviour.

---

# 19. SITREP GENERATION

The situation report is **template-based** (`shared/sitrep.ts`). It is populated only from facility metadata, the Dozier range, CPCB category and the evidence list.

```text
SITUATION REPORT [SAMPLE DATA]
Event, Location
Facility | type | CPCB category | source, refreshed
Detection window (detections, overpasses, lifecycle)
Classification | Tier | Evidence score (not a probability)
Rules fired
Thermal: peak FRP; Dozier status, T_f range, area range; saturation note
History: pattern, baseline, deviation (or cold-start reason)
Footprint: pattern, expanding, spread bearing
Post-event SAR: status (sample data)
Evidence for / Evidence against
```

LLM rules:

* The LLM (Gemini) **only rephrases** the fixed template. It never classifies, never adds facts, and never gates an alert.
* A fact-preservation check verifies that every number, ID and name survives and nothing new appears. If it fails, the raw template is used.
* After a 4 s timeout or any error, the raw template goes out immediately.
* Hourly and daily call caps and a spend ceiling apply.
* The output is labelled **template** or **LLM-phrased**.
* No chemical-hazard prediction and no invented hazards or facts.

---

# 20. ALERT CENTER

Alerts are written to the store **before** dispatch: PostGIS when configured, otherwise the file store in `data/runtime/`, labelled as such. They are then sent by webhook (generic, Discord or Slack) with exponential-backoff retry (5 attempts). Pending dispatches resume after a restart. A failed webhook is never the only record.

Illustrative layout (dispatch status shows whatever the store records):

```text
TIER / KIND      CLASS                  EVENT           SITE                    STATE
CODE RED         Industrial fire        EVT-FAC-001-…   Paradip Petrochemical   dispatch status · attempts
ALERT            Industrial fire        EVT-FAC-003-…   Korba Thermal Power     awaiting operator · dispatch status
ALERT            Unmapped ind. cand.    EVT-…           Vapi (built-up)         review · dispatch status
WILDFIRE ROUTE   Wildfire               EVT-…           Similipal forest        NDRF / Forest Dept, spread bearing
WATCH            Industrial fire        EVT-FAC-009-…   Haldia Refinery         logged, monitored
—                Persistent source      EVT-FAC-002-…   Jamnagar Refinery       no alarm, feeds baseline
```

Dispatch statuses: `pending`, `sent`, `failed`, `not_configured`, `not_dispatched`, `suppressed_sample`.

Filter by class, tier / severity, location, time and dispatch status. SMS gateway is **roadmap**.

---

# 21. ANALYTICS PAGE

Charts computed from the dataset:

* Detections over time
* Classification distribution
* Industrial vs non-industrial events
* Active events by lifecycle
* FRP trends
* Persistent thermal sources and their baselines
* Facility anomalies (deviation ×)
* **Backtest report** (`data/derived/backtest_report.json`): per-class precision and recall, industrial-fire recall, false alerts per week, confusion matrix, and failures shown alongside successes.
  * A run on the sample dataset is labelled "self-consistency check, not a performance claim".
  * A historical-FIRMS run states its caveats.

No meaningless random graphs, and no accuracy figure that the backtest did not produce.

---

# 22. DEMO SCENARIOS (SAMPLE DATASET)

The sample dataset covers **21–23 Apr 2026**, with one earlier Karnal detection on 20 Apr. That window puts Punjab rabi stubble in season, falls in the forest-fire season, and has kilns operating.

Scenarios are **keyed by site**. The labels and tiers below are what the pipeline produces from the forward-modelled detections, and a scenario test asserts them.

| # | Site | Expected result | What it shows |
|---|---|---|---|
| 1 | **Paradip, FAC-001** | Industrial fire → **Code Red via explicit rule** | Radial expansion over 6 overpasses, saturated I4, baseline shattered, inside a CPCB Red polygon; MODIS merged as corroboration; SAR (sample) supports |
| 2 | **Korba, FAC-003** | Industrial fire → **Alert, awaiting operator** | Expanding over 2 overpasses (not enough for the rule); operator confirm would raise it to Code Red; SAR pending |
| 3 | **Haldia, FAC-009** | Industrial fire → **Watch** | Single hot detection ~3× baseline, not expanding; SAR does not support |
| 4 | **Jamnagar, FAC-002** | Persistent industrial thermal source | Tiny, very hot, static, on baseline; no alarm |
| 5 | **Kakinada, FAC-005** | Persistent industrial thermal source | Pilot flare; one high-scan-angle pixel flagged with capped confidence |
| 6 | **Newly mapped unit, FAC-015** (Bharuch) | Persistent source **unverified** (`persistent_source_unverified`) → **manual review** | Cold start: flare-like but no baseline, never auto-whitelisted |
| 7 | **Ludhiana farmland** | Agricultural fire, in season | Linear field-row burn; `seasonal_baseline=regional_default` |
| 8 | **Karnal farmland** | Agricultural fire, in season | Single field-bound pixel on `crop=wheat` land (`osm_crop_tag`); extinguished |
| 9 | **Similipal forest** | Wildfire | Irregular expansion drifting north-east; routed with spread bearing |
| 10 | **Uttarakhand reserve forest** | Wildfire | Radial growth in place |
| 11 | **Jharia, FAC-004** | Mining activity | Low, sustained smoulder, `LONG_SMEAR` history; whitelisted from alerts |
| 12 | **Neyveli, FAC-010** | Mining activity | Same pattern at a lignite mine |
| 13 | **Vapi, built-up, no polygon** | **Unmapped industrial candidate** | Hot, no map match: reviewed like an industrial fire, not dumped in Other; SAR `sar_baseline_unavailable` |
| 14 | **Chilika lake shore** | **Provisional** | Low-confidence pixel held; never dropped, never escalated |
| 15 | **Jabalpur roadside** | Other | Not hot, no polygon; surfaced for review |
| — | Deliberately bad rows | Rejected by the gate | Missing band, malformed time, impossible date, implausible band, invalid location, duplicate (idempotency key), each with a logged reason |

Paradip is the headline scenario. Contrasting it with Jamnagar (same class of site, opposite outcome) is the strongest single demonstration.

---

# 23. DATASET SWITCH AND SCENARIO SELECTION

There is no separate "Demo Mode" data generator. Instead:

* A **dataset switch** in the header: **Live FIRMS** / **Sample scenarios**. Live is available only when a FIRMS key is configured. Sample always shows the SAMPLE DATA badge.
* In sample mode, the presenter picks a scenario **by site** (e.g. "Paradip — FAC-001"). This jumps the map and evidence panel to that event. Nothing needs manual configuration.
* A manual refresh re-runs the pipeline. Results are cached, so the API does not call FIRMS on every request.

---

# 24. DATA ARCHITECTURE

Frontend types are re-exported from `shared/types.ts`. UI components never read JSON files directly; they call the backend API.

```text
shared/        pure TS engine (one implementation of the rules)
backend/       server.ts + modules (see §3); also serves the built dist/
db/schema.sql  landuse, detections (UNIQUE sensor, acq_time, lat, lon), events,
               alerts (UNIQUE event_id, kind), reviews (gold set), ingest_log,
               detection_attribution
scripts/       gen-sample, load-osm, db-load, classify-batch, fetch-firms-history
analytics/     site_baselines.py (Isolation Forest + DBSCAN), backtest.py
data/sample/   sample inputs (badged)
data/derived/  site_baselines.json, backtest_report.json
tests/         node:test unit, scenario and integration tests
src/           React frontend
```

API routes named in the plan:

```text
POST /api/auth/*                     login / logout / session
GET  /api/health                     unauthenticated health
GET  /api/status                     drives the status panel
GET  /api/pipeline/status            gate log, run stats, heartbeat
GET  /api/events?dataset=live|sample
GET  /api/events/:id
POST /api/events/:id/review          confirm / reject → gold set, may promote to Code Red
```

There are also facilities, alerts and manual-refresh routes; see `backend/server.ts` for the exact list.

---

# 25. TECHNOLOGY

Preserve the established stack (see §1):

* **Frontend:** React 19 + TypeScript + Vite + Tailwind + react-leaflet + Recharts
* **Backend:** Node 24 TypeScript by type stripping. That means no enums, no parameter properties, and `.ts` extensions on imports.
* **Database:** PostgreSQL + PostGIS via `docker-compose.yml`, bound to `127.0.0.1:5433`
* **Analytics:** Python for batch analytics and backtesting

**Roadmap only:** Celery/Redis scale-out (a lightweight scheduler polls FIRMS inside overpass windows now), SMS gateway, and role-based access with an audit log.

Do not over-engineer beyond the plan.

---

# 26. VISUAL DESIGN

The interface should look like a professional satellite intelligence platform, disaster-monitoring system or geospatial command centre. It should not look like a generic admin dashboard, a SaaS landing page or sci-fi, and it should avoid excessive glassmorphism or animation.

Prioritise the map, evidence, alerts, charts, clear hierarchy and readable data. Use restrained colours.

Class colours are consistent everywhere and come from `CLASS_COLORS`:

```text
Industrial fire                        red        #b42318
Unmapped industrial candidate          magenta    #be185d
Wildfire                               orange     #c2570c
Agricultural fire                      amber      #a16207
Mining activity                        purple     #6d3fa0
Persistent industrial thermal source   teal/cyan  #0e7490
Provisional                            slate      #64748b
Other                                  grey       #6b7280
```

The SAMPLE DATA badge must be visible but not garish. It must never be hidden on screenshots.

---

# 27. IMPORTANT UX PRINCIPLE

Every classification must answer:

> "Why did the system classify this event this way?"

A "Why this classification?" control shows:

```text
THERMAL       Dozier central / range, saturation, FRP
GEOGRAPHIC    tag + source, facility, distance, runner-ups, provenance
HISTORICAL    pattern, baseline, deviation × (or cold start → manual review)
KINEMATIC     pattern, expanding, overpasses, spread bearing
SEASONAL      in / off season, osm_crop_tag or regional_default (agriculture)
RULES         every rule with fired / not fired and its inputs; precedence winner
TIER          tier reason; Code Red rule checks
POST-EVENT    SAR supports / does not support [SAMPLE DATA]
```

---

# 28. DATA SOURCES PANEL

Replaces the old "Data Integration Status". Each row states what is actually in use now, read from `/api/status`:

```text
NASA FIRMS        Live via backend when FIRMS_MAP_KEY is configured; else sample dataset [SAMPLE DATA]
OpenStreetMap     Bulk-loaded polygons (PostGIS or in-memory); sample polygons badged; Overpass only refreshes
ESA WorldCover    Sample classes [SAMPLE DATA]; bulk raster load is roadmap
Site history      Sample history [SAMPLE DATA] in sample mode; baselines from Isolation Forest when present
CPCB category     Derived from industry type (not an official per-facility record)
Sentinel-1        Sample post-event results [SAMPLE DATA]; live fetch and coherence is roadmap
INSAT (MOSDAC)    Roadmap
Wind              Roadmap (feature and indicative downwind wedge)
TROPOMI methane   Roadmap (coarse emissions-monitoring layer for very large emitters only)
Gemini            Phrasing only; configured / not configured; calls and spend vs ceilings
```

---

# 29. ARCHITECTURE PAGE

Show the v3 phases, matching plan §4 and §5:

```text
FIRMS (VIIRS / MODIS)
    │
    ▼
Phase 1  Quality gate (reject bad bands/times, cap high-scan, merge VIIRS+MODIS,
         hold provisional, idempotent insert)
    │
    ▼
Phase 2  Dozier unmixing (central + range, saturation, unsolvable)
    │
    ▼
Phase 3  PostGIS join (OSM, WorldCover, facilities; nearest-first, runner-ups,
         unmapped) ◄── site history / persistence (cold start → manual review)
    │
    ▼
Phase 4  Rule classifier (precedence, rule trace, evidence score, seasonal prior, tiers)
    │
    ▼
Phase 5  Event lifecycle / de-dup (overpass-aware; active / quiet / extinguished)
    │
    ▼
Phase 7  Alerts: DB first → webhook with retry · template SITREP (LLM phrasing only)
         · dashboard (login)
    │
    ▼
Phase 6  Post-event checks: Sentinel-1 supports / does not support [SAMPLE DATA]
         (roadmap: geostationary between-overpass tracking)

Phase 8  Operator confirm/reject → gold set → learned model only if it beats the rules (roadmap)
```

Mark roadmap boxes visibly as Roadmap.

---

# 30. SAMPLE DATA QUALITY

Sample data is **forward-modelled**, not hand-typed (`scripts/gen-sample.ts`, `npm run sample:gen`):

* Each scenario specifies T_f, p and background. The generator computes Planck radiance in I4 and I5 and converts it back to brightness temperatures.
* **I4 is capped at 367 K**, where VIIRS saturates, so hot sources come out saturated as they would in reality. No sample pixel exceeds the cap.
* Rows use the FIRMS CSV schema, so sample and live data share one ingest path. The pipeline then recovers T_f and p, with ranges and flags.
* Relationships are internally consistent:
  * flares are tiny p, very hot, static, on baseline
  * industrial fires grow over overpasses and break baseline
  * stubble fires have large p, low T_f, and are field-bound
  * mines have low sustained T_f over a long smear
* Site history is 12 months before the window. FAC-015 has only a few weeks, so it cold-starts.
* Deliberately bad rows exercise the quality gate.
* `events.json` no longer exists. Events are pipeline output.

---

# 31. DO NOT DO / DO NOT SAY

Do **not**:

* Present sample data as live, or hide a SAMPLE DATA badge.
* Claim live Sentinel-1 processing, or describe SAR as "verified" or "positive". It "supports" or "does not support".
* Put SAR in the Code Red trigger.
* Let the LLM classify, add facts, or gate an alert.
* Claim the classifier is a trained AI model. It is transparent rules; the learned model is roadmap.
* Show accuracy figures the backtest did not produce, or any "99.8% accuracy" style number.
* Call the evidence score a probability.
* Auto-whitelist a cold-start or newly mapped site.
* Send an unmapped hot signature to "Other".
* Default a missing or invalid band to zero.
* Invent real emergency incidents, chemical hazards, or hazard predictions.
* Mark anything ✔ in plan §3 that the demo cannot show.
* Replace the architecture in `final_plan_v3.md`.

Do **not say** (checklist §7 and retired v1/v2 terms):

* "Detects fires the moment they start". Say instead: bounded by overpass cadence (hours).
* "proves" / "mathematically proves". Say instead: evidence supports; results are ranges.
* "Gas Flare" as a class. The class is **Persistent industrial thermal source**.
* "ESG Lie Detector" / "ESG dashboard". Say instead: emissions estimate / long-term monitoring.
* Any HAZMAT or chemical-hazard prediction claim.
* TROPOMI methane as a precursor or leak predictor.
* "The problem statement requires PostGIS / Twilio / Celery". It asks for GIS-based storage and visualization; PostGIS is our design answer.

---

# 32. DEMO FLOW (3–5 minutes)

### Step 1 — Log in

Show the login gate. The Command Center opens on **Sample scenarios** with the SAMPLE DATA badge. Say so up front; if a FIRMS key is configured, show Live FIRMS briefly.

### Step 2 — Command Center

Computed counts: events by class, industrial events by tier, items needing review. Also the status panel: dataset, spatial backend, store, heartbeat, and the gate log with rejected rows and reasons.

### Step 3 — GIS map

Show all classes, then filter to **Industrial fire**.

### Step 4 — Paradip, FAC-001

Open the evidence panel and show:

* the facility polygon and CPCB Red category
* the per-detection Dozier table (saturated I4 → lower bound; ranges, not single values)
* site history and the deviation ×
* radial expansion over 6 overpasses
* the MODIS corroboration merge

### Step 5 — "Why this classification?"

Walk through the rule trace, the precedence winner, the evidence score (not a probability), and the four Code Red rule checks all passing.

### Step 6 — Contrast

* **Jamnagar, FAC-002:** same kind of site, tiny static flare on baseline → persistent source, no alarm.
* **Korba:** Alert awaiting operator.
* **Haldia:** Watch.
* **FAC-015:** cold start → manual review, never whitelisted.
* **Vapi:** unmapped industrial candidate.

### Step 7 — Post-event check

Sentinel-1 **supports** the Paradip classification, with a **SAMPLE DATA** badge. Explain that it is post-event only and not in the trigger.

### Step 8 — SITREP and dispatch

Show the SITREP, marked template or LLM-phrased. Then the Alert Center: the alert was stored first, then dispatched, with its dispatch status and attempts.

### Step 9 — Operator review

Confirm Korba and show it promoted to Code Red. The confirmation is written to the gold set.

### Step 10 — Architecture and analytics

Show the v3 phases, the roadmap boxes and the backtest page. Close with:

```text
The classification, physics, rule trace, lifecycle, tiers and dispatch shown here are real
computations. With a FIRMS key they run on live data; without one, on a labelled sample
dataset. SAR is sample data; geostationary tracking, live SAR and wind are roadmap.
```

---

# 33. CODE QUALITY

Before finishing:

* `npm run typecheck`, `npm run lint` and `npm run build` are clean.
* `npm test` passes. It covers Dozier recovery, saturation and unsolvable cases; every gate rejection reason; precedence, cold start, unmapped and provisional; season calendars; lifecycle; dispatch retry; LLM fact check and timeout; auth; and the scenario test for every site in §22.
* Routing works, the map loads, every scenario resolves, and no page is empty.
* Loading and error states exist, and there are no console errors.
* Buttons do what they advertise: review, refresh, dataset switch, SITREP.
* A grep for retired terms (`Gas Flare`, `ESG`, `prove`, `mathematically`, `heuristicClassify`) finds nothing outside do-not-say guidance.

---

# 34. FINAL REQUIREMENT

Before calling the prototype complete, verify this chain end to end, on sample data and, when keys exist, on live data:

```text
FIRMS detection (live or sample)
        ↓
Quality gate (logged rejections, provisional hold, merge, dedup)
        ↓
Dozier unmixing (central + range, saturation)
        ↓
Spatial join (nearest-first, runner-ups, unmapped candidate)
        ↓
Site history (baseline, deviation, cold start)
        ↓
Rule classification (precedence, rule trace, seasonal prior)
        ↓
Evidence score (not a probability)
        ↓
Event lifecycle (active / quiet / extinguished)
        ↓
Tier (Watch / Alert / Code Red by rule or operator)
        ↓
Alert stored → webhook dispatch with retry
        ↓
Template SITREP (LLM phrasing only, fact-checked)
        ↓
Post-event SAR check (supports / does not support) [SAMPLE DATA]
        ↓
Incident dashboard + operator review → gold set
```

Finally, walk plan §3 ("Prototype Scope vs Roadmap") row by row against the running demo. Anything the demo cannot show goes to Roadmap.

The result should be something we can demonstrate to SIH evaluators as:

> "This is the working prototype of SATFIRE. It ingests FIRMS detections, gates them for quality, solves the Dozier physics, joins them to mapped land use and facility history, and classifies them with a transparent rule engine whose every decision is visible. Industrial fires are tiered for operator review and dispatched from a database record. Where we show sample data, it is labelled; SAR is a post-event check on sample data, and geostationary tracking is on the roadmap."
