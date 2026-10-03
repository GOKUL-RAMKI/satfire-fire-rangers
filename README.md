# SATFIRE v3 — SIH26162 (NTRO)

SATFIRE is a geospatial intelligence layer that sits between NASA FIRMS thermal-anomaly detections
and a human responder. It sorts detections into five evidence-ranked classes plus an honest
"other" bucket:

- industrial fire
- wildfire
- agricultural fire
- mining activity
- persistent industrial thermal source (flares, furnaces, kilns, power plants)

It also keeps two review states: `unmapped_industrial_candidate` and `provisional`.

The product specification is `../../final_plan_v3.md`, mirrored in `docs/solution-plan.md`.

## What runs

Every step below is a real computation. Only data layers marked **SAMPLE** are sample data.

| Step | Code |
|---|---|
| FIRMS ingestion: VIIRS S-NPP / NOAA-20 / NOAA-21 primary, MODIS secondary | `backend/firms.ts` |
| Data-quality gate. Bad bands, bad timestamps and bad locations are rejected with a reason, never defaulted to 0. High scan angle is flagged. Low confidence is held as provisional. Idempotent dedup. MODIS is merged into VIIRS | `shared/qualityGate.ts` |
| Dozier two-band unmixing at ingestion. Central solve plus a range over a background band, with saturation / unsolvable / default-background flags | `shared/dozier.ts` |
| Spatial join, nearest-first. Rank 1 wins, runner-ups are stored, no match means unmapped. Uses PostGIS when `DATABASE_URL` is set, otherwise an in-memory join with the same semantics. The Dozier area shrinks the fence-line buffer | `backend/postgis.ts`, `shared/spatial.ts` |
| Persistence engine: active days, span, seasonality, baseline. Cold start (under 90 days of history, or newly mapped) is never auto-whitelisted | `shared/history.ts` |
| Event linking (overpass-aware), lifecycle (active / quiet / extinguished), kinematics | `shared/lifecycle.ts`, `shared/kinematics.ts` |
| Rule classifier with precedence, a full rule trace, seasonal prior, evidence score (not a probability), and tiers Watch / Alert / Code Red | `shared/classify.ts`, `shared/season.ts` |
| Alerts written to the store first, then sent by webhook with retry and backoff. Template SITREP with optional Gemini rephrasing, fact-checked, with a timeout fallback and rate/spend ceilings | `backend/pipeline.ts`, `dispatch.ts`, `llm.ts`, `shared/sitrep.ts` |
| Login gate, overpass-window scheduler, FIRMS heartbeat | `backend/auth.ts`, `scheduler.ts` |
| IsolationForest site baselines, DBSCAN site clusters, backtest | `analytics/` |

**Sample data** lives in `data/sample/`. It's forward-modelled with the Planck function by
`scripts/gen-sample.ts`, and VIIRS I4 is capped at its 367 K saturation level. It covers
Sentinel-1 post-event results, WorldCover points, site history and sample polygons, and the UI
labels all of it SAMPLE DATA.

## Run

Requires Node ≥ 22.18, which runs `.ts` natively. Python 3.11 with scikit-learn is only needed for
`analytics/`, and Docker only for PostGIS.

```bash
npm install
cp .env.example .env.local          # add FIRMS_MAP_KEY for live data; optional DASHBOARD_PASSWORD
npm run dev                         # API on :8787 + Vite UI on :5173
```

If `DASHBOARD_PASSWORD` is empty, the API prints a generated login at startup. Without
`FIRMS_MAP_KEY`, only the labelled sample dataset is served.

Production-style run, with one process serving the built UI and the API:

```bash
npm run build && npm start          # http://localhost:8787
```

### PostGIS (optional; the in-memory join is used otherwise)

```bash
npm run db:up                       # docker compose: postgis/postgis:16-3.4 on 127.0.0.1:5433
npm run db:init                     # apply db/schema.sql (idempotent)
npm run osm:load                    # real OSM polygons around monitored facilities -> data/osm/
npm run db:load                     # bulk-load polygons, bump attribution version, re-attribute
# then set DATABASE_URL in .env.local (see .env.example)
```

### Checks

```bash
npm run typecheck && npm run lint && npm test && npm run build
DATABASE_URL=postgres://satfire:satfire_dev@localhost:5433/satfire npm run test:integration
npm run baselines                   # analytics/site_baselines.py (IsolationForest + DBSCAN)
npm run backtest                    # analytics/backtest.py -> data/derived/backtest_report.json
```

## Sample scenarios (the Scenarios menu; sample window 21–23 Apr 2026)

| Site | Result |
|---|---|
| Paradip FAC-001 | Industrial fire → **Code Red** by the explicit rule (thermal, spatial, kinematic and historical all agree; SAR is not in the trigger) |
| Korba FAC-003 | Industrial fire → **Alert**, awaiting operator confirmation |
| Haldia FAC-009 | Industrial fire → **Watch** |
| Jamnagar FAC-002, Kakinada FAC-005 | Persistent industrial thermal source (Kakinada has a high-scan pixel, flagged and capped) |
| Newly mapped FAC-015 | `persistent_source_unverified`: cold start, manual review |
| Ludhiana, Karnal farmland | Agricultural, in season (regional default calendar / OSM `crop=wheat`); Karnal is extinguished |
| Similipal, Uttarakhand forest | Wildfire (irregular / radial expansion), routed with spread bearing |
| Jharia FAC-004, Neyveli FAC-010 | Mining |
| Built-up area near Vapi | `unmapped_industrial_candidate` (`sar_baseline_unavailable`) |
| Chilika lake shore | Provisional (low confidence, held) |
| Roadside near Jabalpur | Other (operator review) |

The sample feed also contains deliberately bad rows. The quality gate rejects each with a logged
reason, shown in `/api/status`: missing band, impossible date, bad time, zero band, bad latitude,
and a duplicate.

## Layout

```text
shared/     engine shared by backend, frontend, scripts and tests (one implementation of the rules)
backend/    HTTP API, pipeline, PostGIS, stores, dispatch, LLM phrasing, scheduler, auth
db/         PostGIS schema
scripts/    sample generator, OSM bulk loader, DB init/load, batch classifier, FIRMS archive fetch
analytics/  Python: site baselines (IsolationForest, DBSCAN) and backtest
data/       sample/ (SAMPLE), osm/ (bulk-loaded OSM), derived/ (analytics outputs), runtime/ (git-ignored)
src/        React + Leaflet dashboard
tests/      node:test unit, scenario and integration tests
docs/       solution plan (v3), API, build brief, problem statement
```

## Known limitations

See plan §8. In short:

- Polar-orbit revisit bounds detection latency.
- The Dozier inversion is approximate and often saturated for strong sources, so results are reported as ranges.
- FIRMS provides no neighbour pixels, so the background is a flagged 300 K default.
- SAR is post-event only, and sample data in this build.
- Classification thresholds are starting rules to be tuned on the backtest and on operator feedback.
