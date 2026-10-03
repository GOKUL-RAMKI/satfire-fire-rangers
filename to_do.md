# to_do.md — open work for SATFIRE v3

Status as of 2026-09-29. Deadline 30 Sep 2026. Ordered by priority. See `log.md` for what is done.

## A. Before submission (tomorrow)

- [ ] **Create `satfire-master/satfire-master/.env.local`.** It is not in the repo and must never be
  committed. Set `FIRMS_MAP_KEY`, `DASHBOARD_PASSWORD` and `SESSION_SECRET`. Optionally set
  `GEMINI_API_KEY` + `LLM_PHRASING_ENABLED=true`, `ALERT_WEBHOOK_URL`, and
  `DATABASE_URL=postgres://satfire:satfire_dev@localhost:5433/satfire`.
- [ ] **Verify the live FIRMS path with the key.**
  1. Run `npm run dev` and log in.
  2. Switch the dataset to "Live FIRMS".
  3. Check that `/api/status` shows `lastRun.rows > 0`, a gate log and a heartbeat with no warning.
  4. Spot-check a few live events at monitored sites (Jamnagar, Paradip, Korba) for sensible class and context.
- [ ] **Run the real historical backtest** (checklist step 7):
  ```bash
  npm run firms:history          # ~10 min; writes data/backtest/
  python analytics/backtest.py --spec analytics/backtest_real.json --out data/derived/backtest_real_report.json
  ```
  - First, verify every window's bbox and dates on a map (`analytics/backtest_real.json`). They were
    chosen from memory.
  - Extend OSM coverage to those bboxes: `npm run osm:load -- --merge --only-extra --bbox <w,s,e,n> ...`.
  - Commit the report only if the numbers are real. Show failures as well as successes (plan §7).
- [ ] **Verify Gemini phrasing live.** Enable it, press "Generate SITREP" on the Paradip event, and
  confirm the result is either "LLM-phrased" or a template with the fact-check or timeout note.
- [ ] **Verify webhook dispatch against a real endpoint** (e.g. a Discord test channel), with
  `DISPATCH_SAMPLE_ALERTS=true` for the demo.
- [ ] **Rehearse the demo and the Q&A** in checklist §6 (step 10). Use the sample Scenarios menu:
  - Paradip → Code Red by the explicit rule
  - Korba → confirm → Code Red
  - the Jamnagar flare
  - FAC-015 cold start
  - the Vapi unmapped candidate
- [ ] **Re-walk plan §3 against the running demo** after any change (agents.md §1).

- [ ] Optional polish: code-split the dashboard bundle (Vite warns the single JS chunk is ~910 kB),
  and zoom the incident map closer so the 5 km wind wedge is easier to see.

## B. Tuning (needs real data / operator feedback)

- [ ] Tune the starting thresholds (`RULES`, `KIN`, `LIFECYCLE`, `HISTORY`, `GATE`) on the real
  backtest. Record before/after numbers in `log.md`.
- [ ] Decide how to treat routine non-tiny industrial heat (steel furnaces, power-plant boilers). It
  currently falls to Other for review when deviation is below 1.5×; the reference rules only
  whitelist tiny, very hot sources.
- [ ] Estimate the Dozier background from neighbouring pixels. FIRMS gives no neighbours, so the
  300 K default is flagged. This needs VIIRS L1B/L2 granules.
- [ ] Assign history by space rather than exact site key for live data: attribute stored detections
  to the polygon that contains them when polygons change.
- [x] Seed live site history with `npm run seed:history` (Jharia + Neyveli belts, 12,094 rows,
  2026-10-03; Jharia quarries at LONG_SMEAR). Note: `firms:history` output is backtest-shaped
  and never reaches the live pipeline; a baselines JSON alone cannot clear cold start.

## C. Data coverage

- [x] India-wide OSM: `npm run osm:india` (Geofabrik `india-latest.osm.pbf` → GDAL container →
  `data/runtime/osm/landuse_india.geojson`, 225,268 polygons). The tracked Overpass files remain
  the fallback. Covered earlier: Vijayanagar/JSW Toranagallu bbox.
- [x] WRI Global Power Plant Database as second anchor: `npm run osm:wri` (1,589 India plants,
  388 thermal circular anchors, OSM wins on overlap). GEM steel / oil & gas trackers still open.
- [ ] ESA WorldCover bulk tiles for land cover. Live mode currently has no WorldCover (status shows
  "unavailable"); sample mode uses sample points.
- [ ] Facility datasets as a second anchor: Global Energy Monitor
  steel/oil & gas trackers, VIIRS Nightfire flare catalogue, and the official CPCB Red category list.
  The CPCB category is currently derived from industry type and labelled as such.
- [ ] The OSM Mathura refinery polygon has no name, so it is not a named facility.

## D. Roadmap (plan §3 / §9; accounts to register)

- [ ] **Copernicus Data Space (free account):** live Sentinel-1 fetch and coherence processing, and
  backscatter change as a second post-event check. SAR is sample data today.
- [ ] **MOSDAC (ISRO) registration and approval (apply early):** INSAT geostationary tracking between
  overpasses. Flag `diurnal_data_unavailable` in eclipse season.
- [ ] **Wind as a classifier feature** (Open-Meteo / ERA5 via the Climate Data Store), then a fitted
  FRP correction once the gold set supports it.
- [ ] TROPOMI methane as a coarse emissions layer for very large emitters.
- [ ] A learned classifier, only when the operator gold set has at least 200 labelled events with a
  minimum per class and it beats the rules by 5 macro-F1 points without lowering industrial-fire
  recall (plan Phase 8).
- [ ] Celery/Redis scale-out, role-based access with an audit log, an offline-tolerant responder view,
  an SMS gateway, and a tile provider for production basemaps.
- [ ] Ground-truth fusion (CCTV/IoT) for facilities that share feeds.
