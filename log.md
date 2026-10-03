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
