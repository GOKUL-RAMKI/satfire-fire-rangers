# SATFIRE — Solution & Workflow (v3) — SIH26162, NTRO

## 1. The Idea

Raw satellite thermal-anomaly feeds (NASA FIRMS) produce huge volumes of "hotspots," and most are noise: stubble burning, a quarry's heat, a gas flare stack. All look thermally similar to an early-stage industrial fire under simple brightness thresholding. SATFIRE is a geospatial intelligence layer between the raw feed and a human responder. It turns that stream into five evidence-ranked classes plus an honest "other" bucket:

1. Agricultural fire
2. Wildfire
3. Mining activity
4. Persistent industrial thermal source (flares, furnaces, kilns, power plants)
5. Industrial fire

It combines three kinds of evidence:

* **Physics** of the thermal signal: how hot, how large an area, how bright (Dozier sub-pixel unmixing, FRP).
* **Geography** of the location: what is actually built on that land (OpenStreetMap, ESA WorldCover, industrial-facility databases).
* **History** of the specific site: has this happened here before, and how often.

The result is a continuously monitored, low-false-positive alert layer, bounded honestly by satellite revisit cadence. It is designed to cut alert fatigue and flag probable industrial fires for verification and dispatch. It does not claim to catch every fire the instant it starts.

## 2. How SATFIRE Maps to the Problem Statement

| PS deliverable | SATFIRE component |
|---|---|
| (i) Classify and segregate industrial fires from forest fires and other natural fires | Phases 1–6: quality-gated ingestion, Dozier unmixing, geospatial and historical context, rule-based classification with a full evidence trail |
| (ii) GIS-based storage and map overlay of outputs | PostGIS storage; live Leaflet map with class-coloured overlays, facility layer, and click-through evidence panel per event (Phase 7) |

## 3. Prototype Scope vs Roadmap

| Component | In prototype | Roadmap |
|---|---|---|
| FIRMS VIIRS ingestion (India bounding box), sample fallback clearly labelled | ✔ | MODIS history for longer baselines |
| Data-quality gate (invalid bands, timestamps, scan angle, dedup) | ✔ | |
| Dozier two-band unmixing with saturation flag and uncertainty range | ✔ | Background from neighbouring pixels at scale |
| PostGIS spatial join, nearest-first tie-break, unmapped-facility state | ✔ | Larger facility-database coverage |
| Rule classifier with precedence, evidence panel, seasonal prior | ✔ | Learned model (Phase 8) |
| Live map with class overlays and facility layer | ✔ | |
| Tiered alerts, DB-first webhook dispatch, template SITREP with LLM phrasing | ✔ | SMS gateway |
| Access control on the dashboard | ✔ (login gate) | Role-based access, audit log |
| Geostationary (INSAT) between-overpass tracking | | ✔ |
| Sentinel-1 post-event structural check | Labelled sample data | ✔ Live fetch and coherence processing |
| Indicative downwind wedge for Code Red events (Open-Meteo 10 m wind) | ✔ | Wind as a classifier feature |
| Scheduler | Lightweight scheduler | Celery/Redis at scale |

## 4. Architecture & Tech Stack

```
FIRMS (VIIRS/MODIS) ──► Quality gate ──► Dozier unmix ──► PostGIS join (OSM, WorldCover, facilities)
                                                              │
                     Site history (persistence) ◄─────────────┤
                                                              ▼
                              Rule classifier (precedence, evidence, confidence)
                                                              │
                        Event lifecycle / de-dup ──► Alert tiers ──► Dashboard + webhook dispatch
                                                              │
                              Post-event checks (SAR, roadmap: geostationary)
```

* **Backend API:** Node.js / TypeScript (prototype backend; the rule engine is one shared TypeScript module used by the backend, dashboard and backtest)
* **Frontend:** React, Leaflet.js, Tailwind CSS
* **Spatial database:** PostgreSQL + PostGIS
* **Batch analytics and backtesting:** Python (NumPy, scikit-learn: Isolation Forest site baselines and DBSCAN site clustering now; gradient boosting for the Phase 8 learned model). The backtest calls the same TypeScript rule engine the live pipeline uses.
* **LLM (phrasing only):** Gemini API, with rate and cost ceilings
* **Data:** NASA FIRMS, OpenStreetMap, ESA WorldCover, open industrial-facility datasets (power, steel, oil and gas, flare catalogues), CPCB Red Category list, Sentinel-1 (Copernicus), INSAT via MOSDAC (roadmap)

## 5. Workflow

### Phase 1 — Ingestion & Data-Quality Gate

* **Primary feed:** VIIRS 375 m detections (I4 ~3.74 µm / I5 ~11.45 µm brightness temperatures, FRP, confidence, day/night, static-source flag). The India bounding box is a deliberate scope decision and is configurable.
* **Secondary feed:** MODIS 1 km, used to extend the historical lookback for persistence baselines. It is not mixed into the same physical solve as VIIRS.
* **Scheduling:** polling follows satellite overpass windows, not a fixed timer.
* **Quality gate before any physics:**
  * Missing or implausible band values are rejected, never defaulted to zero.
  * Malformed date/time fields are rejected with a logged reason.
  * High-scan-angle pixels (footprint grows from ~375 m to 1–2 km off-nadir) are flagged and have their confidence capped.
  * The same fire seen by VIIRS and MODIS in one pass window is merged into one event, with VIIRS primary and MODIS as corroboration.
  * Low-confidence detections near water or cloud edges are held as `provisional`. They are never silently dropped and never auto-escalated.
  * Inserts are idempotent on `(sensor, acq_time, lat, lon)`, so retries and concurrent workers cannot create duplicates.

### Phase 2 — Dozier Sub-Pixel Thermodynamic Unmixing

Solves the two-band Planck-function system to separate a blended pixel into **fire temperature (T_f)** and **sub-pixel fire area (p)**.

* **Background** is estimated from neighbouring non-fire pixels. A fixed default is a last resort and is flagged.
* **Uncertainty:** the solve is repeated across a background-temperature band, and the spread is reported as a range for T_f and p. It is never one exact number.
* **Saturation:** VIIRS I4 saturates near 367 K. Saturated pixels are flagged and their T_f is treated as a lower bound. For those, the classifier leans on the saturation flag, FRP and footprint growth instead of a precise temperature.
* An unsolvable pixel returns "unsolvable", not a guessed value.

### Phase 3 — Geospatial, Facility & Historical Context

* **Spatial join in PostGIS** (`ST_DWithin` on geography) against bulk-loaded OSM land-use polygons, WorldCover classes and facility databases. Bulk loading keeps live Overpass calls off the critical path.
* **Fence-line bleed:** the Dozier area estimate (p) shrinks the detection footprint before the boundary match.
* **Tie-break:** when several facilities match, the nearest wins. The runner-ups are stored in the event record so a reviewer can see the ambiguity.
* **Unmapped facilities:** a detection with an industrial-like signature but no map match is not sent to "Other". It becomes `unmapped_industrial_candidate`, with the same review priority as a matched industrial fire.
* **Persistence engine:** repeat detections at a site build a history (active days, span, seasonality, recurrence).
* **Cold start:** a site with fewer than three months of history, or newly mapped, gets no baseline. It is never auto-whitelisted as routine and is routed to manual review.
* **Provenance:** every facility record carries its data source and last-refresh date, including the CPCB category. When a polygon changes, historical detections are re-attributed and the attribution version is stored.

### Phase 4 — Evidence-Based Classification

Each label carries a **confidence score** built from thermal, spatial, historical, kinematic and verification evidence, plus the full list of rules that fired. Thresholds are starting rules to be tuned on data (Phase 8).

| Class | Spatial anchor | Thermal signature | Temporal / spatial behaviour | Action |
|---|---|---|---|---|
| **Agricultural fire** | Farmland (OSM, WorldCover cropland) | Large p, low T_f (~300–500°C) | In-season; burns out in ~24–48 h; field-bound | No dispatch. Log for environmental tracking. |
| **Wildfire** | Forest, wood, national park | Growing p, medium-to-high T_f | Sudden vs site history; multi-pixel expansion | Route coordinates and spread direction to NDRF and Forest Departments. |
| **Mining activity** | Quarry or mine polygons | Low-to-medium p, low sustained T_f | Months-to-years, static or very slow | Whitelist from alerts. Feed long-term monitoring. |
| **Persistent industrial thermal source** | Industrial polygons, facility-database points, static-source flag; brick kilns handled with a seasonal check | Very small p, very high or saturated | Steady, repeating; static one-pixel footprint | No alarm. Feed emissions estimate and the site baseline. |
| **Industrial fire** | Inside an industrial polygon or facility footprint | Growing footprint with very high or saturated readings | FRP and footprint break the site's baseline; expanding | Tiered alert (below). |

**Precedence.** When several rules fire, the most safety-critical wins, and every fired rule is logged:

`Industrial fire > Wildfire > Agricultural (off-season) > Mining > Persistent source > Agricultural (in-season) > Other`

**Seasonal prior.** Agricultural confidence is adjusted by season. Where OSM farmland polygons lack crop or season tags, which is most of them, a regional default calendar applies and the record is marked `seasonal_baseline=regional_default`, which lowers its weight.

**Alert tiers for industrial fire:**

* **Watch:** a single detection above baseline, or an unclear fit. Logged and monitored.
* **Alert:** baseline-breaking spike plus footprint growth. Sent to operators for verification.
* **Code Red:** several independent signals agree and an operator or explicit rule confirms. Generates the situation report.

**Other / unclassified:** anomalies that fit no class stay in "Other" with their evidence and are surfaced for operator review.

### Phase 5 — Event Lifecycle & De-duplication

* Detections are linked into one ongoing event when they are close in space and time. The linking window is overpass-aware.
* An event is marked "extinguished" only after an extended quiet window, so one missed overpass (for example cloud) does not falsely close a live event.
* FRP trend across the event's life is a supporting signal, since it varies with viewing angle and sensor.
* **Roadmap:** the INSAT geostationary thermal curve (~30-minute cadence, ~4 km pixels) fills the gaps between VIIRS passes. A flare shows a flat or periodic curve, and a growing fire shows escalation. It helps mainly for larger events. During satellite eclipse-season gaps the system degrades to VIIRS-only and flags `diurnal_data_unavailable`, never reading a data gap as "no escalation".

### Phase 6 — Post-Event Verification

* For events escalating toward "industrial fire," clustering separates a radially expanding footprint (uncontained) from a static one (contained furnace).
* Sentinel-1 SAR coherence is compared before and after the event to look for structural or surface change. It works through cloud and darkness, but revisit is measured in days, so it is a **post-event confirmation layer**, not a live trigger.
* If no pre-event SAR baseline exists (a newly commissioned facility), the system records `sar_baseline_unavailable` and relies on thermal and spatial evidence. It does not silently skip the step.
* Results are reported as "supports" or "does not support" the thermal classification, never as proof.
* Any sample or fallback data shown in the interface is visibly labelled as sample data.

### Phase 7 — Dashboard, Reporting & Dispatch

* **Live map:** filterable, class-coloured overlays, an industrial-facility layer, and a click-through evidence panel for each event (signals used, confidence, fired rules, site history).
* **Dispatch order:** every alert is written to the database first, then dispatched by webhook. Failed dispatches are retried with backoff, so a failed webhook is never the only record.
* **Situation report:** template-based, populated from facility metadata, the Dozier range, CPCB category and the evidence list. An LLM only rephrases the fixed template and never invents facts. If the LLM call fails or times out, the raw template goes out immediately. The LLM never gates an alert.
* **Cost control:** LLM calls have rate and spend ceilings.
* **Access control:** the dashboard requires login, since it shows live industrial-site data.
* **Indicative downwind wedge** for Code Red events, drawn from 10 m wind speed and direction (Open-Meteo). It shows the direction responders should consider and is not a dispersion model or an evacuation zone. If the wind reading is unavailable, the wedge is omitted rather than guessed.

### Phase 8 — Continuous Learning & Evaluation

* The classifier starts on transparent, explainable rules. Operator confirm/reject builds a gold-labelled set over time.
* **Proposed replacement rule:** a learned model replaces the rules only if, on the gold set, it beats them on macro-F1 by a set margin (proposed: 5 points) without lowering industrial-fire recall. The gold set must also reach a minimum size (proposed: 200 labelled events, with a minimum count per class) so the comparison is meaningful.
* Weak-labelled bootstrap data is never used for that evaluation, since it would be circular.
* Persistence-derived features are excluded whenever a persistence-related label is being learned or evaluated.
* A model is deliberately not trained before a gold set exists. Starting with transparent rules is a design decision, not a shortcut.

## 6. Reliability & Failure Handling

| Situation | Behaviour |
|---|---|
| Missing or invalid band value | Detection rejected with a logged reason; never defaulted to zero |
| Malformed timestamp | Row rejected; clustering never sees an invalid time |
| Saturated or unsolvable pixel | Flagged; classification uses saturation flag, FRP, footprint growth |
| VIIRS and MODIS see the same fire | Merged into one event; VIIRS primary |
| Overlapping facility polygons | Nearest wins; runner-ups logged |
| No facility match, industrial signature | `unmapped_industrial_candidate`, reviewed like a matched industrial fire |
| New or unbaselined facility | Manual review; never auto-whitelisted |
| Two or more rules fire | Precedence order applied; all fired rules logged |
| Overpass API slow or rate-limited | Bulk-loaded PostGIS polygons are primary; Overpass only refreshes |
| Webhook fails during Code Red | Alert already in DB; retried with backoff |
| LLM report fails | Raw template dispatched immediately |
| Duplicate processing by concurrent workers | Idempotent insert key rejects duplicates at the DB |
| Poller silently stops | Heartbeat check on last successful FIRMS pull raises an operator warning |
| Cloud blocks a required reading (roadmap layers) | Widen the pairing window; if still incomplete, omit the prediction instead of guessing |

## 7. Validation Plan

* **Backtest** over historical FIRMS data covering:
  * documented industrial fires
  * known stubble-burning seasons
  * forest-fire events
  * steady flare, furnace and kiln sites
* **Report** per-class precision and recall, industrial-fire recall, and false alerts per week. Failures are shown as well as successes.
* **Operator feedback** from the live dashboard feeds the gold set (Phase 8).

## 8. Known Limitations

* Polar-orbit revisit means detection can lag an event by hours. Geostationary data narrows this only for larger events, at ~4 km resolution.
* The Dozier inversion is approximate and often saturated for strong sources, so results are ranges and thresholds need tuning on real data.
* OSM industrial coverage varies by region, so facility databases are a second anchor.
* SAR confirmation is delayed by revisit and cannot support real-time decisions.
* The downwind wedge is a rough direction aid, not a dispersion model.

## 9. Roadmap

* INSAT geostationary between-overpass tracking (Phase 5).
* Live Sentinel-1 fetch and coherence processing; backscatter-change as a second post-event check.
* Wind as a classifier feature, then a fitted FRP correction once the gold set supports it.
* TROPOMI methane as a coarse emissions-monitoring layer for very large emitters (5–7 km pixels).
* Learned classifier once the gold set meets the Phase 8 criteria.
* Celery/Redis scale-out, role-based access with audit log, offline-tolerant responder view.
* Ground-truth fusion (CCTV/IoT) for facilities that share feeds.
