# agents.md — instructions for agents working on SATFIRE

SATFIRE is the SIH26162 (NTRO) submission. It classifies NASA FIRMS thermal anomalies into five
evidence-ranked classes plus "other". Read this file before changing anything.

## 1. Source of truth (in priority order)

1. `final_plan_v3.md` is the submission document and the product spec. The code must do what it
   claims.
   - §3 "Prototype Scope vs Roadmap" must match the demo exactly.
   - If a ✔ row can't be shown, flip it to Roadmap. Never the reverse without shipping the feature.
2. `v3_execution_checklist.md` is internal and **not** for submission. It holds the build order,
   audit triage, reference code, judge Q&A and the §7 "Do Not Say" list.
3. The code in `satfire-master/satfire-master/`.

Other documents:

- `satfire-master/satfire-master/docs/solution-plan.md` is an **identical copy** of
  `final_plan_v3.md`, because the repo folder may be submitted alone. Edit both together.
- `docs/problem-statement.md` is the official PS text. Don't edit it.
- `SIH26162_Problem_Statement.md` (workspace root) is an unofficial "blueprint". Its SQL, Twilio and
  Celery lines are **not** PS requirements (checklist §4 note on #2 and §7), so don't cite it as the
  PS.
- `log.md` records work done; append to it. `to_do.md` lists open work; keep it current.

## 2. Layout (`satfire-master/satfire-master/`)

| Path | What |
|---|---|
| `shared/` | Pure TypeScript engine used by backend, frontend, scripts and tests. **One implementation of the rules.** `types.ts` is the data contract |
| `backend/` | `server.ts` (HTTP API, docs/api.md), `pipeline.ts`, `postgis.ts`, `store.ts`, `dispatch.ts`, `llm.ts`, `auth.ts`, `scheduler.ts`, `firms.ts`, `osm.ts`, `sampleData.ts` (Node-only loaders live here, never in `shared/`) |
| `db/schema.sql` | PostGIS schema (idempotent) |
| `scripts/` | `gen-sample.ts`, `load-osm.ts`, `db-init.ts`, `db-load.ts`, `classify-batch.ts`, `fetch-firms-history.ts` |
| `analytics/` | Python: `site_baselines.py` (IsolationForest, DBSCAN), `backtest.py` |
| `data/sample/` | SAMPLE dataset, generated. Regenerate with `npm run sample:gen`; don't hand-edit |
| `data/osm/` | Bulk-loaded OSM polygons and facilities (live context) |
| `data/derived/` | Analytics outputs (baselines, backtest reports) |
| `data/runtime/` | Git-ignored file store (alerts, reviews, live history) |
| `src/` | React + Leaflet dashboard |
| `tests/` | `node:test`. `tests/integration/` needs PostGIS |

## 3. Commands

```bash
npm install
npm run dev                      # API :8787 + UI :5173 (login printed if DASHBOARD_PASSWORD unset)
npm run typecheck && npm run lint && npm test && npm run build
npm run db:up && npm run db:init && npm run db:load      # PostGIS on 127.0.0.1:5433
DATABASE_URL=postgres://satfire:satfire_dev@localhost:5433/satfire npm run test:integration
npm run sample:gen               # regenerate data/sample (deterministic)
npm run osm:load                 # Overpass bulk load around monitored facilities
npm run baselines && npm run backtest
```

`npm test` does **not** typecheck. Always run `npm run typecheck` too.

## 4. TypeScript on Node (type stripping)

The backend and scripts run as `.ts` directly on Node ≥ 22.18. That means:

- Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Relative imports carry the `.ts` extension.
- Use `import type` for types.
- Nothing in `shared/` may import `node:*`; it's bundled into the browser.

## 5. Invariants (do not break; each one is a plan or checklist commitment)

- **Never default a band to 0.** Missing or implausible values are rejected by the quality gate, and
  every rejection has a logged reason.
- **Dozier is reported as a range, never one exact number.** Saturated values are lower bounds;
  unsolvable pixels return `unsolvable`. The default 300 K background is flagged.
- **Precedence:** Industrial fire > (Watch) > Wildfire > Agricultural (off-season) > Mining >
  Persistent source > Persistent source unverified > Agricultural (in-season) > Other. Every fired
  rule is logged.
- **Cold start** (under 90 days of history, or newly mapped): no baseline, never auto-whitelisted,
  routed to manual review.
- **Unmapped industrial-like heat** becomes `unmapped_industrial_candidate`, reviewed like an
  industrial fire. It never falls into Other.
- **SAR (Sentinel-1) is post-event only.** It reports "supports" or "does not support" and is never
  part of the Code Red trigger.
- **Code Red** requires operator confirmation, or the explicit rule where thermal, spatial,
  kinematic and historical signals all agree.
- **DB-first dispatch:** the alert record is written before any webhook call. Failed dispatches are
  retried with backoff and never lost.
- **The LLM only rephrases the SITREP template.** It never classifies, never adds facts (fact check),
  and never gates an alert. On failure or timeout the raw template goes out. Rate and spend ceilings
  apply. It is off by default.
- **Login gate** on every `/api/*` route except health and auth. Don't put data under `public/`;
  Vite serves that folder unauthenticated.
- **Every sample or fallback layer shows a SAMPLE DATA badge** in the UI and `sample: true` in the
  API.
- **No FIRMS key, secret, `.env*` file (other than `.env.example`), or `data/runtime/` is ever
  committed.**

## 6. Deliberate deviations from the checklist reference code

These are documented in `shared/classify.ts` / `shared/dozier.ts` and justified in `log.md`:

- **(a)** Thermal gates (`hot`, `tiny`, mining heat) use the **central** Dozier solve. With the
  reference code's lower bound of a ±4 K background band, a 1250 °C / 0.02 % flare returns a range of
  379–1250 °C and is never "hot". The range is still reported, and a `range_wide` flag down-weights
  thermal confidence.
- **(b)** Adds an `industrial_watch` rule (Watch tier). The reference code sent hot, non-expanding
  industrial heat above baseline to "other", which left the plan's Watch tier unreachable.
- **(c)** The agricultural rule accepts field-bound single or compact detections, not only
  `linear-field`.
- **(d)** Brick-kiln seasonal check: kiln heat outside Nov–Jun is not whitelisted.
- **(e)** Wildfire accepts radial as well as irregular expansion in forest.
- **(f)** Rows held by the quality gate (low confidence) are classified `provisional`.

To tune a threshold, change `RULES` / `KIN` / `LIFECYCLE` / `HISTORY` / `GATE`, run
`npm test && npm run backtest`, and record the before/after in `log.md`. To add a rule, add it to
`applyRules` with a trace entry, place it in `PRECEDENCE` (`shared/labels.ts`), and add a unit test
and, if relevant, a sample scenario in `scripts/gen-sample.ts` plus `tests/scenarios.test.ts`.

## 7. Language (checklist §7)

Never write:

- "the PS requires PostGIS/Twilio/Celery"
- "detects fires the moment they start", "proves", "mathematically proves"
- "ESG Lie Detector"
- TROPOMI as a leak predictor
- "Gas Flare" as a class (it's "Persistent industrial thermal source")
- "verified" for SAR

Don't claim anything in plan §3 that the demo can't show.

## 8. Git

- Git root is this workspace folder (`FIRE RANGERS/`).
- Commit each coherent unit with a message saying what and why. Never push, never add a remote.
- **No AI attribution anywhere**: no `Co-Authored-By`, no "Generated with" footers.
- Never commit secrets. Never force-push, rewrite history, or skip hooks.
