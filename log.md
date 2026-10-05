# log.md — work done on SATFIRE v3

This file is a chronological record. Append new entries at the end. Open work is tracked in `to_do.md`.

## 2026-09-29: v3 build (from `final_plan_v3.md` + `v3_execution_checklist.md`)

### Starting point (as uploaded)
The React/Leaflet prototype plus the 258-line `backend/server.mjs` fell short of v3 in five ways:

- **Fake labels.** `heuristicClassify()` assigned labels by a lat/lon hash, and Gemini also
  *classified* detections.
- **Hand-typed outputs.** Every Dozier value, score, pattern and label was typed into
  `public/data/events.json`.
- **Physically impossible sample data.** Every "hot" sample pixel had I4 between 395 and 462 K, but
  VIIRS I4 saturates near 367 K.
- **Missing v3 components.** There was no quality gate, PostGIS, seasonal prior, alert tiers,
  dispatch, login, backtest or SAMPLE badges.
- **Wrong terminology.** It used the "Gas Flare" class and had hardcoded stat cards.

### Decisions
- **Dozier gate (deviation a, confirmed with the user).** The reference solver was tested
  numerically. A forward-modelled 1250 °C / 0.02 % flare returns a range of 379–1250 °C over a ±4 K
  background band. The reference gate "hot = lower bound ≥ 800 °C" therefore never fires for flares,
  so the classifier uses the central solve. The range is still reported, and `range_wide` lowers
  thermal confidence.
- **Other rule extensions (b–f).** These are documented in `agents.md` §6 and in the checklist:
  - (b) Watch-tier rule
  - (c) field-bound agricultural fires
  - (d) kiln operating season
  - (e) radial wildfire expansion
  - (f) gate-held rows are provisional

  (b), (c) and (e) each fix a case where the reference code sent a common real situation to "Other".
- **Backend in TypeScript,** run by Node 24's native type stripping, which matches plan §4.
  `shared/` is one engine for the backend, the UI, the batch backtest and the tests.
- **Sample data moved from `public/` to `data/sample/`,** because Vite would otherwise serve it
  unauthenticated and bypass the login gate. The frontend's static fallback was removed.
- **Git.** The repository was initialised at `FIRE RANGERS/`, with the as-uploaded state as the
  baseline commit.

### Work done (commit order)
1. **Baseline:** the prototype and documents as uploaded.
2. **Engine** (`shared/`):
   - quality gate
   - Dozier at ingestion
   - seasonal prior
   - kinematics
   - overpass-aware event linking and lifecycle
   - persistence engine with cold start
   - in-memory spatial join (nearest-first, runner-ups, unmapped)
   - classifier with precedence, trace, tiers and evidence score
   - SITREP template

   `scripts/gen-sample.ts` forward-models 85 FIRMS-format rows: 15 scenarios plus 6 deliberately
   bad rows. `events.json` was deleted.
3. **Backend:**
   - pipeline
   - PostGIS schema and layer (geography GiST indexes, idempotency key, versioned attribution)
   - file / PostGIS stores
   - DB-first webhook dispatch with backoff and resume
   - Gemini phrasing with fact check, timeout fallback and ceilings, off by default
   - scrypt + HMAC session login with rate limit
   - overpass-window scheduler and heartbeat
   - docker-compose, `db-init`, `db-load`, `load-osm`, `classify-batch`
   - `docs/api.md`
   - `docs/build-brief.md` aligned to v3
4. **Analytics** (`analytics/`):
   - IsolationForest per-site baselines and DBSCAN clusters (`site_baselines.py`)
   - backtest harness calling the TypeScript engine (`backtest.py`)
   - FIRMS archive fetcher for real labelled windows (`scripts/fetch-firms-history.ts`)
   - README and `.env.example` rewritten
5. **Performance:** history and polygon indexing for national-scale feeds. `agents.md` added.
6. **Real OSM context:** 989 OpenStreetMap polygons and 143 named facilities around the monitored
   sites (`data/osm/`).
   - Solar/wind/hydro plants are excluded as industrial anchors.
   - CPCB category is derived from industry type and labelled as derived.
   - Overpass returned 429/504 several times; Mathura needed a merge retry.
7. **Dashboard rebuilt** on the v3 contract: login, dataset switch, SAMPLE badges, status/heartbeat
   banners, full evidence panel, review, SITREP, alerts with dispatch status, analytics with the
   backtest, and architecture.

   Cold-start review routing was narrowed to baseline-dependent classes. It had been flagging
   wildfires for review.
8. **Indicative downwind wedge on Code Red incidents.** Open-Meteo reanalysis gives Paradip 4.8 m/s
   from 221° on 2026-04-23 20:00Z, so the wedge points toward 41°. Wildfire routing summaries now
   state the spread bearing.
9. **Docs:**
   - plan §3/§4/Phase 7/§9 updated to match the build and mirrored to `docs/solution-plan.md`
   - checklist status column and deviations
   - `log.md`, `to_do.md`

### Verification (actual results, 2026-09-29)
- **Checks:** `tsc -b` clean · `oxlint` clean · `vite build` succeeds (bundle-size advisory only).
- **`npm test`: 53/53 pass.** Coverage:
  - Dozier recovery, saturation, invalid and unsolvable inputs
  - every gate rejection reason
  - precedence, cold start, unmapped, provisional, and deviations b–e
  - seasons and lifecycle
  - dispatch retry against a real failing local webhook, and give-up with the record kept
  - LLM fact-check rejection, timeout and ceilings
  - session signing and expiry, scheduler windows
  - the API end to end: 401s, login, Korba confirm to Code Red, template SITREP, rate limit
- **Scenarios.** All 15 sample scenarios land on their intended class and tier:

  | Site | Result |
  |---|---|
  | Paradip | Code Red by the explicit rule |
  | Korba | Alert |
  | Haldia | Watch |
  | Jamnagar, Kakinada | persistent source |
  | FAC-015 | `persistent_source_unverified` |
  | Ludhiana, Karnal | agricultural, in season |
  | Similipal, Uttarakhand | wildfire |
  | Jharia, Neyveli | mining |
  | Vapi | unmapped candidate |
  | Chilika | provisional |
  | Jabalpur | other |

- **PostGIS** (Docker `postgis/postgis:16-3.4`, PostGIS 3.4.3): 3/3 integration tests pass. The
  join agrees with the in-memory join on every sample detection (ranking, and distance within
  1 m + 1 %). Inserts are idempotent, and the indexes are on geography. The full server in PostGIS
  mode returns the same 15 classifications, and alerts, detections and attribution versions are
  stored in the DB.
- **Sample backtest** (self-consistency, *not a performance claim*):
  - 14/15 correct.
  - Industrial-fire recall 1.00 (the unmapped candidate counts as surfaced).
  - 0 false industrial alerts per week.
  - The one strict miss is Vapi: truth industrial fire, predicted unmapped candidate, by design.
- **Headless browser (Playwright) against the built app served by `npm start`:**
  - no page errors
  - login, overview, map, alerts, analytics, architecture
  - the Paradip incident with the wind wedge
  - Jamnagar persistent source
  - SAMPLE badges visible

  The frontend agent separately exercised a wrong password, scenario focus, review confirm and
  reject, the SITREP, the live/sample switch and logout.
- **Banned-term grep** (`Gas Flare|ESG|prove|mathematically|moment they start|heuristicClassify`):
  hits appear only in the do-not-say lists, the official PS text, and the plan's description of a
  "gas flare stack" as a phenomenon.

### Not verified (no `.env.local` / keys were available during the session)
The code is written and unit-tested, but none of these ran against a real service:

- the live FIRMS pull
- the real historical backtest
- Gemini phrasing
- webhook dispatch to a real endpoint

The commands are listed in `to_do.md` §A. Plan §3 keeps "FIRMS VIIRS ingestion ✔" and "template
SITREP with LLM phrasing ✔" on the basis that the user has the keys. **Verify them before
submitting, and flip the rows if they fail.**

## 2026-10-03 — provisional / unmapped logic fixes (no label-invariant changes)
- `provisional` still means all-held-by-gate or Dozier-unresolved; `unmapped_industrial_candidate`
  still means hot with `tag === null` and never falls into Other.
- A hot unmapped event held provisional now keeps `provisional` (never auto-escalated) but carries
  `hot_unmapped_while_provisional` plus a review reason and evidence, so the industrial signal is
  not silently dropped (`shared/classify.ts`, `shared/buildEvents.ts`).
- Mixed-confidence events (some but not all pixels held) are still classified normally but carry
  `partial_gate_hold`, an evidence note, and a review reason (`ClassifyInput.partialHold`).
- Unmapped calls with no land-cover fallback (live mode) carry `spatial_unverified_no_landcover`
  and an evidence note saying the call rests on polygon absence alone; the absence-hot basis is
  now listed under evidence-for instead of looking like pure counter-evidence.
- Fence-line buffer is now the Dozier fire radius clamped to [100, 150] m (was: capped at 50 m with
  no floor), so VIIRS geolocation error stops manufacturing false unmapped candidates. Both
  backends read the same per-detection `buffer_m`, so memory and PostGIS stay in sync; the
  transient default in `shared/qualityGate.ts` and `db/schema.sql` was updated to match.
- Verified: `npm run typecheck`, `npm run lint`, `npm test` (53/53 pass), `npm run build`.
  `npm run backtest` could not run here (python `sklearn` not installed — pre-existing env gap);
  scenario tests through the same engine path still pass. No sample expectation changed.

## 2026-10-03 — live unmapped at Vijayanagar power station was missing polygon coverage
- A live event at (15.180, 76.666), visually inside Vijayanagar Toranagallu Power Station on the
  OSM base tiles, classified `unmapped_industrial_candidate`. Correct behaviour given its inputs:
  neither `data/sample/landuse_polygons.geojson` (19 features) nor `data/osm/landuse.geojson`
  (989 features) had any polygon within 25 km — the Overpass loader only covers ±10 km around the
  monitored sample facilities, and Vijayanagar/JSW Toranagallu is not one of them. The base-map
  tiles render OSM; the classifier only sees the bulk-loaded polygons.
- Fix (data, not code): `npm run osm:load -- --merge --only-extra
  --bbox 76.573,15.090,76.759,15.270` → 1011 polygons (+22), 150 named facilities (+7), including
  `OSM-way-822601316` Vijayanagar Toranagallu Power Station (Thermal power plant, CPCB Red) and
  the enclosing `OSM-way-285680302` Jindal Steel Works (Steel plant, CPCB Red). Verified the point
  now joins at distance 0 → `industrial`.
- Note: the next pipeline run re-reads the file (PostGIS path re-bulk-loads on count mismatch and
  re-attributes), so refresh/re-run to see the event reclassify. Stored `CELL-*` history for that
  site does not transfer to the new facility site key (open work, `to_do.md` §B).

## 2026-10-03 — national polygon layer: whole-India OSM extract + WRI second anchor
- Requirement: the product must work for all of India, not just the sample-site bboxes. The
  Overpass focus loader only covers ±10 km around monitored facilities by design.
- Extract: `india-latest.osm.pbf` (Geofabrik, 1.6 GB, git-ignored in `data/runtime/osm/`) →
  `npm run osm:india` (new `scripts/load-india.ts`): GDAL `osgeo/gdal:ubuntu-small-3.6.3` filters
  the multipolygons layer with a shipped config (`scripts/osmconf.india.ini`: default osmconf +
  power/industrial/operator/product/company attributes; colon keys ride in other_tags), simplify
  ~5 m, then Node builds the layer with the shared `shared/osmTags.ts` mapping (extracted from
  `scripts/load-osm.ts`; parity proven over all 1011 stored features; the Overpass loader now
  imports it too). Alpine-small GDAL lacks GEOS so `-simplify` silently no-ops — ubuntu-small
  is required and pinned in the script.
- Yield: 225,268 polygons (industrial 29,886 / quarry 10,598 / farmland 108,363 / forest 76,421),
  6,551 named facilities → `data/runtime/osm/landuse_india.geojson` (247 MB) +
  `facilities_india.json`. Every real monitored plant verified present (Paradip, Mathura, Neyveli,
  Talcher, Durgapur, Barauni, Haldia, Korba, Bhilai, Vizag steel+refinery, Vijayanagar); Jharia
  coalfield has 100 quarry polygons. Sample scenario coordinates are synthetic demo points, so
  several don't sit on real polygons — expected, not a coverage gap.
- Second anchor: `npm run osm:wri` (new `scripts/load-wri.ts`): WRI Global Power Plant Database
  v1.3.0 (CC BY 4.0) → 1,589 India plants, 388 thermal-fuel synthetic circular anchors
  (capacity-scaled 250–800 m, marked fallback-only). Merged on top of OSM by
  `backend/livePolygons.ts`, which drops a synthetic polygon wherever an OSM polygon already
  anchors the site (347 dropped, 41 kept): 225,309 polygons / 8,140 facilities merged.
- Wiring: live dataset uses the national file when present, else the tracked focus files
  (fresh clones keep today's behaviour); `scripts/db-load.ts` loads the same merged layer.
  The 247 MB file is mtime-cached (5.5 s first read, instant after; index 0.7 s; 100 joins
  15 ms). PostGIS stays the primary backend at national scale.
- PostGIS: `loadPolygons` now batched (UNNEST, 1000/batch — the row-by-row version would have
  taken ~1 h for 225k rows); `live: loaded 225309 polygons` verified. PostGIS-vs-memory join
  parity confirmed on live points (Vijayanagar industrial/0 m both backends).
- Env notes (this machine): Docker Desktop was started (daemon was down); port 5433 is taken
  by another project's Postgres, so the SATFIRE PostGIS runs on 5434
  (`DATABASE_URL=postgres://satfire:satfire_dev@localhost:5434/satfire`). Repo defaults
  unchanged. `py -m pip install scikit-learn` done → `npm run baselines` + `npm run backtest`
  run: 14/15 strict (Vapi by design), industrialFireRecall 1.00, 0 false alerts/week.
- Still open: GEM steel/oil/gas trackers, ESA WorldCover live fallback, India-wide real
  backtest (`to_do.md` §C). One debug-script `setval` mishap (sequence reset to 1) was caught
  and repaired during verification — repo code unaffected.

## 2026-10-03 — live tab freeze + empty live mode fixed at national scale
- Symptoms: (1) "Page Unresponsive" in live mode, (2) no live points. Root causes, both from the
  national layer landing without a serving strategy: `DataProvider` fetched the whole 247 MB /
  225k-feature collection on every dataset view and `MapView` rendered it as Leaflet SVG paths.
  Empty live was the freeze masking the paint, plus `.env.local` pointing at port 5433 (another
  project's Postgres) so the server silently fell back to file store + 6 s in-memory joins.
- Fix: `GET /api/polygons?dataset=live` now requires `bbox=w,s,e,n` (else 413) and returns a
  capped viewport set (2000, `truncated` flag) — PostGIS `ST_Intersects` on the geography index,
  memory fallback via `featuresInBbox` (`shared/spatial.ts`). The map refetches per viewport on
  pan/zoom (debounced, aborted). Sample layer (19 features) still serves whole. Facilities page
  got search + 60/page pagination (8,140 live cards were a second DOM bomb). Map page got a
  reason-aware live empty-state; FIRMS/heartbeat banners already existed in `StatusBanner`.
- `.env.local` DATABASE_URL → `localhost:5434`. FIRMS key probed live: valid (day-range 1 empty,
  day-range 2 returns rows — NRT latency, not a key problem).
- Smoke numbers (real server, PostGIS, national layer): live pull 2,840 rows → 1,289 events;
  `/api/events?dataset=live` 2.7 s; viewport bbox (Vijayanagar area) 279 polygons in ~700 ms;
  full-layer request correctly 413. `backend/livePolygons.ts` gained a cached layer index.
- Verified: typecheck, lint, `npm test` 55/55 (new: viewport-cap unit test + bbox endpoint
  contract test incl. 413/400), `test:integration` 3/3, build, backtest unchanged (14/15 strict,
  recall 1.00, 0 false/week). Note: the bbox API test parses the 247 MB file where present
  (~12 s); instant on fresh clones with the focus file.

## 2026-10-03 — farmland-shows-as-unmapped: diagnosis, rural mapping, triage, weak-shape gate
- The event in question (EVT-CELL-12.41-77.07, 12.4131/77.0688, single static daytime pixel,
  FRP 2.5 MW, Dozier central 1225 °C with range 244–1225 °C): label came from exactly two
  inputs — central-hot (≥800 °C) + `tag === null`. Kinematics never enters that rule (it fires
  before the rule table). Answered in chat; this entry records the remedies.
- Step 0 diagnosis (local PBF spot extract, no network): within 1.5 km only power towers/lines,
  a village node and residential polygons ~1 km out — no farmland of any tag. The "Farmland"
  was a tile-legend artifact. `tag === null` was correct, not a data gap.
- Step 1 rural mapping: `farm/farmyard/meadow/orchard/vineyard/grass/plant_nursery` →
  `farmland` in `shared/osmTags.ts` (parks/gardens stay out), mirrored in the GDAL extract
  filter and the Overpass loader query. National farmland 108,363 → 142,748 (+34,385);
  `db:load` v5 (259,667 polygons). Live proof: 3 agricultural events now keyed to `OSM-india`
  farmland polygons (`agri_in_season`). Residual truth: most Indian fields are simply unmapped
  in OSM — topology cannot fix that; steps 2–3 handle it.
- Step 2 triage: `classification.reviewPriority` high/medium/low (null when no review needed).
  Alert-tier review → high, except weak-thermal unmapped → low; everything else → medium.
  Alerts review queue sorts by priority then recency; Events table shows the priority badge.
- Step 3 gate (all had to hold, all held): single + static + unsaturated + daytime +
  `range_wide` unmapped → `other` (`unmapped_weak_thermal`, still `needsReview`, no Alert tier).
  Saturated pixels (real energy) and nighttime pixels (no solar contamination) stay candidates —
  the Vapi sample is saturated, so the demo and backtest are unchanged (14/15, recall 1.00).
  Live pull 3,122 rows / 1,398 events: unmapped alerts 28 → 11, all 11 high priority
  (6 saturated, 5 multi-pixel); 12 demoted, every one single/static/unsaturated/low, none lost
  from review. Old alert records for demoted events remain as history; the queue shows current labels.
- Also fixed: Docker Desktop Windows bind mounts need the `//d/...` form (`D:/...` silently
  mounts empty) — `scripts/load-india.ts` now builds the mount arg accordingly.
- Verified: typecheck, lint, `npm test` 58/58 (new: rural-tag, weak-shape, priority tests),
  `test:integration` 3/3, build, backtest. Still open: GEM trackers, WorldCover fallback.

## 2026-10-03 — mining and persistent: cold-start mining rule, history seeder, provisional flavors
- Recheck overturned the first plan: `firms:history` writes backtest files the live pipeline
  never reads, and a baselines file alone cannot clear cold start (records required). Built
  `npm run seed:history` instead (fetch 12 months per bbox in 5-day FIRMS chunks — dated
  queries cap at 5, not 10 — gate, attribute to polygon ids, idempotent insert + site keys,
  pattern report per site). Jharia belt: 12,084 rows, quarry polygons at LONG_SMEAR with
  200+ active days. Neyveli belt: only 10 rows in 12 months (genuinely quiet).
- New `mining_cold_start` rule (precedence right after `mining`): quarry + single/static-compact
  + unsaturated + Tf < 400 °C + cold start → mining, tier none, unconditional review. Dispersed
  and expanding shapes excluded (mine fire vs wildfire-on-mine stays human-or-history work).
- New `Classification.provisionalKind` (backend, mirrors early-return order):
  low_confidence / unsolvable_cool / modis_only. Events-table sub-badge; review queue sorts
  untrusted pixels first.
- Live pull 3,122 rows / 1,398 events: mining 0 → 4 (1 LONG_SMEAR seeded, 3 cold-start);
  provisional flavors 666 unsolvable_cool / 207 low_confidence / 43 modis_only. Routine
  non-tiny industrial heat stays in Other per operator call.
- Verified: typecheck, lint, `npm test` 60/60, integration 3/3, build, backtest unchanged.

## 2026-10-04 � overlap priority, wildfire thermal veto, Code Red runner-up scan, narrow-range display

Friend-review of a Chirimiri-type case (coal mine under a generic forest polygon, ~313 �C
expanding heat routed to Forest Dept as wildfire) held up on all five claims; fixed four
engine/UX causes, left precedence order untouched (spec invariant):

- Fix 1 spatial tie-break (`shared/spatial.ts`, `backend/postgis.ts`, `db/schema.sql`):
  distance still dominates, but 0 m ties now break by tag priority
  industrial > quarry > forest > farmland, then polygon id. Same semantics in the
  in-memory join (`compareMatches`/`TAG_PRIORITY`), the PostGIS LATERAL join
  (`CASE tag ...` in both ORDER BYs) and the event majority vote. Runner-ups were
  already plumbed end-to-end; they were just ignored for the label.
- Fix 5 wildfire thermal veto (`shared/classify.ts`, new `RULES.wildfireMinC = 450`):
  unsaturated forest expansion below 450 �C no longer fires `wildfire` � it falls to
  `other` with a `wildfire_thermal_veto` flag + trace detail + evidence line (smoldering,
  not open flame). Saturated and genuinely hot (=450 �C) wildfires unchanged.
- Fix 3 Code Red (`shared/classify.ts` `codeRedRule`): the spatial check now scans the
  primary match AND runner-ups for a CPCB Red industrial polygon at 0 m and names which
  one triggered it. Other three signals must still agree; only `industrial_fire`
  escalates, so a forest-winner with a Red runner-up shows the signal without a false
  Code Red tier. Fence-line near-miss (Red at 5 m) still fails � must be inside.
- Fix 4 Dozier display (`shared/dozier.ts`, `src/lib/format.ts`,
  `src/components/evidence/DozierSection.tsx`): 1-decimal rounding can render a narrow
  spread as `313�313 �C`. The range tuple is still reported (never a bare number); new
  `range_narrow` flag plus `tfText`/`isNarrowTfRange` explain it as below-0.1 �C precision
  (usually default 300 K background) in the header, the explainer line and the table
  cell. Header comment in `classify.ts` documents veto + runner-up scan as deviations
  g/h; precedence order NOT changed.
- Before/after: `npm test` 60/60 ? 65/65 (5 new: 0 m tie-break, vote tie-break, veto,
  runner-up Red incl. fence-line negative, narrow-range text); typecheck, lint, build
  pass; `npm run backtest` metrics unchanged (report diff is timestamp-only; strict
  industrial_fire per-class recall 0.75 is the pre-existing Vapi truth-label caveat,
  industrialFireRecall 1.00).

## 2026-10-04 � live-history audit (why provisional/unmapped/other stay full)

Question: can MODIS/VIIRS history classify the pile? Audit (PostGIS down,
`ECONNREFUSED 127.0.0.1:5433`, so file store `data/runtime/store.json` audited):
- File store: 4,553 live records / 1,730 sites, but max span 3.8 d
  (2026-09-29..2026-10-03) � 0 sites >= 90 d, so effectively 100% cold start there.
  Top sites are Raniganj/Jharia-belt coal CELLs + OSM ways.
- Alerts in file mode: 41 unmapped / 4 industrial_fire / 2 wildfire � mapping gap dominates.
- Sensor finding: HistoryRecord carries no sensor field, so history is sensor-blind by
  design. Live fetch pulls VIIRS SNPP+NOAA20+NOAA21 + MODIS (`config.ts:77`); gate merges
  co-located MODIS into VIIRS corroboration (`qualityGate.ts:171-191`) and lone MODIS
  stays provisional (`dozierNotApplicable`), but all surviving detections (VIIRS + lone
  MODIS + provisional) are appended to history (`pipeline.ts:184-187`). Seed script
  defaults to VIIRS_SNPP_SP only, Jharia+Neyveli belts. No live baselines file exists
  (`site_baselines_live.json` missing; sample file covers 10 sites) � live falls back to
  engine median, which still needs records + 90 d span.
- Structural limits confirmed: provisional returns before history is read; unmapped
  returns before history rules (history never supplies a tag); `other` is helped only
  where history makes mining/persistent/industrial-watch fire. 1 km MODIS FRP mixing
  with 375 m VIIRS FRP in one baseline is an unacknowledged caveat � per-sensor history
  would need a HistoryRecord schema change (proposed, not implemented).

## 2026-10-04 � full-belt seed verified + live baselines built (steps 3-4)

User seeded 6 belts x VIIRS_SNPP_SP x 12 mo: 48,045 rows accepted, 0 rejections,
35,941 inserted (rest idempotent overlap with the earlier Jharia/Neyveli seed).
Step 3 audit of PostGIS live (53,174 detections, all keyed): sensors VIIRS_SNPP
49,690 + NOAA20 1,853 + NOAA21 1,461 (live NRT pulls) + MODIS_TERRA 88 +
MODIS_AQUA 82 (lone MODIS from live pulls � confirms MODIS enters history as
sensor-blind FRP records). 513/8,625 keyed sites clear the 90-day span
(distribution: 513 >= 90 d, 885 at 30-90 d, 7,227 < 30 d � long tail of young
CELLs graduates via nightly pulls). Top sites span ~364 d (seed + live pulls).
bbox-4 Korba/Ib matched only 41% (10,069/24,618) vs 69-87% elsewhere � mapping
gap, not history; those CELLs can only ever be unmapped candidates.
Step 4: dumped live history and ran site_baselines.py (no --sample) ->
data/derived/site_baselines_live.json (sample:false): 201 IsolationForest
baselines / 8,625 sites. Pipeline picks it up as baselinesFor(live); status
should flip to "IsolationForest inlier median". Label impact pending step 5
(live pipeline refresh + before/after cold-start/mining/persistent/Code Red).

## 2026-10-04 � step 5 refresh: seed drains cold start share, mining 2->6

Live pipeline refresh after full-belt seed + site_baselines_live.json (201
IsolationForest baselines / 8,625 sites). Before -> after: events 904 -> 1,315
(+411 fresh October fire-season pulls, incl. Punjab/Haryana stubble clusters);
cold start 895 (99%) -> 1,254 (95%); provisional 639 -> 868; other 256 -> 417;
mining 2 -> 6 (LONG_SMEAR quarries graduating as predicted); class coverage 5/8.
History line now "Stored live detections (postgis), baselines: IsolationForest
inlier median". Verdict: seed works where history is decisive; absolute bucket
growth is denominator growth (new sites are cold start by definition), so track
cold-start share + mining/persistent/deviation from here. Provisional/unmapped
flat-or-growing is expected (structural: gate/physics pre-history, history never
supplies a tag). Noted: scheduler shows enabled:false � tail graduates only on
manual refresh until re-enabled. Next: mapping work (Korba/Ib bbox-4 matched only
41%; CELL-22.04-83.73 CONSISTENT n=1284 stays unmapped candidate despite baseline).

## 2026-10-04 � mapping audit: Korba gap is distance, not tags (WS1 rejected by evidence)

Workstream 1 gap audit over bbox-4 (Korba/Ib, 82.4,21.6,84.2,22.6): 24,916 live
detections, 14,589 CELL (59% unmapped, matches seed 41% matched). CELL thermal
split: 433 saturated + 263 hot-unsat (unmapped candidates) vs 13,893 cool
unsolved (other) + 1,994 gate-provisional. Overpass probe at CELL-22.04-83.73
found two named quarries (Garjanbahal + Basundhara West, MCL) � but DB check
shows them 1.3-1.4 km from the cluster center, far outside the 100-150 m
fence-line buffer. The mines ARE mapped (47 quarries in bbox-4); the fires burn
beyond attribution range. Near-miss census: 23 CELL within 150 m, 723 at
150-500 m of quarry/industrial (5%), 2,043 within 500 m of any polygon (14%),
only 3 hot within 500 m of quarry/industrial. 86% is >500 m from any polygon:
genuinely unmapped rural heat (fields/scrub/soil), correctly other/unmapped.
Verdict: tag-filter extension REJECTED � no spoil-heap/pit objects found, tags
are fine. Reprioritized: WorldCover live fallback first (converts the 13.9k cool
+ stubble clusters to agri logging), GEM coal extents second (captures part of
the 723 near-miss where lease footprints exceed OSM ways). No code changed;
scratch audit scripts removed.

## 2026-10-04 � WorldCover live fallback: point-sampled, wired, verified

Replaces bulk-raster ambition with point sampling: `scripts/sample-worldcover.ts`
(new, `npm run wc:sample`) batches live CELL sites by 3� tile and samples ESA
WorldCover v200 COGs once per tile (GDAL container over /vsicurl/, HTTP timeouts
so a stalled tile fails fast; `--tile`, `--radius-km`, `--dry-run` flags; output
merges so batched runs accumulate). 8,072 CELL sites / 65 tiles -> 8,062 points in
data/runtime/landcover_live.json (10 nodata at tile ocean edges): 5,913 Cropland
-> farmland, 959 Tree cover -> forest, 145 Built-up + 1,045 other classes stay
untagged by design (same WORLDCOVER_TAG as sample). Only consulted when no
polygon wins, so it can log agri fires and route thermal-ok wildfires but never
create industrial/Code Red. Wiring: worldCoverSource gains "live"
(types/buildEvents/spatial/engine), backend/worldcover.ts cached loader,
pipeline prefers the file (status flips unavailable->live), FallbackBadge (not
SampleBadge � real data, coarser layer) in status + evidence, stale "no live
fallback" comments fixed. Tests 65 -> 68 (live-tag parity incl. agri_off_season
via live fallback, loader missing/present); typecheck/lint/build pass; backtest
unchanged (sample path untouched). Live delta pending server restart + refresh.
