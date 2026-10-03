# SATFIRE v3 — Internal Execution Checklist (do NOT submit)

Deadline: 30 Sep 2026. Companion to `final_plan_v3.md`, which is the submission document.

## 1. Conclusion

* **v1** is the better *document*: standalone, mapped to the PS, physically careful.
* **v2 + the audit** are the better *engineering plan*: they know what the repo really does and cover the edge cases.
* **v3** is v1's body plus v2's robustness and critical path, with the audit triaged and v2's code bugs fixed. Repo-gap language stays in this file only.

## 2. Decisions Made

| Decision | Why |
|---|---|
| Stack in the doc matches the repo (Node/TypeScript backend, Python for batch and backtest) | The old plan said FastAPI while the repo is `server.mjs`. Judges can check this. If you would rather run FastAPI, change one line in section 4 of the plan. |
| Thermal-inertia layer dropped | Speculative: needs clean day/night pairs at ~4 km to predict material type |
| TROPOMI methane, CCTV/IoT → roadmap | Pixel size too coarse for per-facility baselines; data access unrealistic |
| Geostationary designed in, marked roadmap | Real value for between-overpass tracking, but data access is the long pole |
| Wind → feature, not "normalization" | No validated FRP correction formula |
| Celery/Redis → lightweight scheduler now | Too heavy for the time left; named as scale-out |
| "Gas flare" → "Persistent industrial thermal source" | PS names steel, power, LNG, kilns |
| SAR is post-event only, never in the Code Red trigger | Revisit is days |
| "ESG Lie Detector" renamed (emissions estimate) | Audit #35 |

## 3. Build Order (rough time-boxes, stop adding after step 8)

| # | Task | Time | Audit items | Status (2026-09-29) |
|---|---|---|---|---|
| 1 | Replace `heuristicClassify()` with the real rule engine (code in section 5) | 1 h | #1, #13, #15, #16 | Done: `shared/classify.ts`, with deviations a–f below |
| 2 | Real Dozier solve at ingestion, replacing hand-typed values in `events.json` | 1.5 h | #3, #9 | Done: `shared/dozier.ts` runs in the gate; `events.json` deleted, sample forward-modelled |
| 3 | Minimal PostGIS: schema, bulk-loaded polygons, nearest-first join | 2 h | #2, #14, #25 | Done: `db/schema.sql`, docker-compose, parity test vs the in-memory join passes |
| 4 | Quality gate plus timestamp guard in the backend (`server.mjs` → `backend/server.ts`) | 0.5 h | #9, #10, #11, #12, #26 | Done: `shared/qualityGate.ts` |
| 5 | "SAMPLE DATA" badge on every fallback or sample layer in the UI | 0.5 h | #5 | Done: SampleBadge on every sample layer, whole-app sample banner |
| 6 | Seasonal prior with regional default calendar | 0.5 h | #8, #21 | Done: `shared/season.ts` |
| 7 | Backtest script on historical FIRMS plus per-class precision/recall table | 2 h | #30 | Harness done; sample self-consistency report committed; real historical run pending FIRMS_MAP_KEY (to_do.md) |
| 8 | Login gate; DB-first webhook dispatch with retry; LLM fallback and spend ceiling | 1.5 h | #22, #24, #27, #29 | Done: `backend/auth.ts`, `dispatch.ts`, `llm.ts` |
| 9 | Stretch: pipeline heartbeat, indicative wind wedge | if time | #32 | Done: heartbeat warning; indicative wedge on Code Red incidents (Open-Meteo) |
| 10 | Rehearse the demo and the Q&A in section 6 | 1 h | | Open (team) |

**Before submitting:** flip any row in section 3 of the plan ("Prototype Scope vs Roadmap") that isn't actually done from ✔ to Roadmap. The plan must match what the demo does.

### Deviations from the section 5 reference code (as built)

Each deviation is documented in code (`shared/classify.ts`, `shared/dozier.ts`) and in `agents.md`.

* **a. Central solve for the thermal gates.** The classifier's thermal gates use the central Dozier solve. Run numerically, the reference lower-bound gate gives a routine 1250 °C / 0.02 % flare a range of 379–1250 °C, so the flare never counts as "hot". The range is still reported, and a `range_wide` flag lowers thermal confidence.
* **b. New `industrial_watch` rule.** Hot industrial heat that is above baseline but not a baseline-breaking expanding fire becomes Industrial fire at the Watch tier. The reference code returned "other" here, which left the Watch tier unreachable.
* **c. Field-bound agricultural fires.** The agricultural rule also accepts field-bound single or compact detections. Otherwise single-pixel stubble fires, the common case, all land in Other.
* **d. Kiln operating season.** Kiln heat outside the Nov–Jun operating season is never whitelisted.
* **e. Wildfire expansion shapes.** The wildfire rule accepts radial as well as irregular expansion in forest.
* **f. Gate-held detections.** Low-confidence detections held by the quality gate are classified provisional.
* **g. Polygon geometry type.** The schema stores polygons as `MultiPolygon` (OSM relations have several outer rings) and adds a `dataset` column. The geography GiST indexes and the idempotency key are as specified.

## 4. Audit Triage (all 36)

| Bucket | Items |
|---|---|
| **Fix now** (build order above) | #1, #2, #3, #9, #13, #15, #16, #26, #27 |
| **In the design, cheap to implement** | #7, #10, #11, #12, #14, #22, #24, #25, #28, #30, #35 |
| **Handled in the doc, roadmap in code** | #5, #6, #8, #17, #18, #19, #20, #21, #23, #29, #31, #32, #33, #36 |
| **Pitch statement only** | #4 (say the learned model is deliberately deferred), #34 (resolved: v3 uses one numbering) |

Note on #2: the audit quotes a "problem statement SQL snippet". The PS text (`ps.md`) contains no SQL, Twilio or Celery requirement. Present PostGIS as *your* design answer to deliverable (ii), not as something the PS demanded.

## 5. Reference Code (fixed versions of v2's snippets)

These fix v2's bugs: `mean(None)` crashes on saturated or cold-start inputs; the "honest range" was a hardcoded ±40 K; the flare rule ran before the industrial-fire rule; input saturation was never checked; and the GIST index was on geometry while queries used geography.

### Dozier unmixing (TypeScript)

```ts
const C2 = 14387.77;                      // µm·K
const WL4 = 3.74, WL5 = 11.45;
const I4_SAT_K = 367, I5_SAT_K = 380;     // approximate; verify against VIIRS product docs
// relative radiance: the constant factor cancels in the p ratios
const planck = (tK: number, wl: number) => 1 / (wl ** 5 * (Math.exp(C2 / (wl * tK)) - 1));

function solveOnce(b4: number, b5: number, bgK: number) {
  const L4 = planck(b4, WL4), L5 = planck(b5, WL5);
  const B4 = planck(bgK, WL4), B5 = planck(bgK, WL5);
  if (L4 <= B4 || L5 <= B5) return null;                 // not warmer than background
  const resid = (tf: number) =>
    (L4 - B4) / (planck(tf, WL4) - B4) - (L5 - B5) / (planck(tf, WL5) - B5);
  let lo = 500, hi = 2000, flo = resid(lo);
  if (flo * resid(hi) > 0) return null;                  // no root in bounds
  for (let i = 0; i < 60; i++) {                         // bisection
    const mid = (lo + hi) / 2, fm = resid(mid);
    if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
  }
  const tfK = (lo + hi) / 2;
  const p = (L4 - B4) / (planck(tfK, WL4) - B4);
  return p > 0 && p <= 1 ? { tfK, p } : null;
}

export function dozierUnmix(b4: number, b5: number, bgK = 300, bgSigmaK = 4) {
  if (!(b4 >= 200 && b5 >= 200)) return { status: "invalid" as const };  // never default to 0
  const saturated = b4 >= I4_SAT_K - 0.5 || b5 >= I5_SAT_K - 0.5;
  // bgK should be the median of neighbouring non-fire pixels; 300 K default is last resort, flag it
  const sols = [bgK - bgSigmaK, bgK, bgK + bgSigmaK]
    .map(bg => solveOnce(b4, b5, bg))
    .filter((s): s is { tfK: number; p: number } => s !== null);
  if (!sols.length) return { status: "unsolvable" as const, saturated };
  const tfC = sols.map(s => s.tfK - 273.15), pPct = sols.map(s => s.p * 100);
  return {
    status: saturated ? ("saturated_lower_bound" as const) : ("ok" as const),
    saturated,
    tfRangeC: [Math.min(...tfC), Math.max(...tfC)] as [number, number],
    pRangePct: [Math.min(...pPct), Math.max(...pPct)] as [number, number],
  };
}
```

### Classifier with precedence and cold-start handling (TypeScript)

```ts
type Rng = [number, number] | null;
interface Det  { tfRangeC: Rng; pRangePct: Rng; saturated: boolean; expanding: boolean; pattern: string }
interface Ctx  { tag: "industrial" | "quarry" | "forest" | "farmland" | null }   // null = unmapped
interface Hist { deviationX: number | null; pattern?: string }                   // null = cold start

const PRECEDENCE = ["industrial_fire", "wildfire", "agri_off_season", "mining",
  "persistent_source", "persistent_source_unverified", "agri_in_season"] as const;

export function classify(d: Det, c: Ctx, h: Hist, inSeason: boolean) {
  const flags: string[] = [];
  const hot  = d.saturated || (d.tfRangeC?.[0] ?? 0) >= 800;
  const tiny = (d.pRangePct?.[1] ?? 100) < 0.1;          // percent of pixel; tune on data
  const coldStart = h.deviationX === null;
  if (coldStart) flags.push("cold_start_manual_review");

  if (d.tfRangeC === null && !d.saturated) return { label: "provisional", fired: [], flags };
  if (c.tag === null && hot) return { label: "unmapped_industrial_candidate", fired: [], flags };

  const fired: string[] = [];
  const ind = c.tag === "industrial";
  if (ind && d.expanding && hot && (coldStart || (h.deviationX as number) >= 3)) fired.push("industrial_fire");
  if (c.tag === "forest" && d.pattern === "irregular-expansion") fired.push("wildfire");
  if (c.tag === "farmland" && d.pattern === "linear-field") fired.push(inSeason ? "agri_in_season" : "agri_off_season");
  if (c.tag === "quarry" && h.pattern === "LONG_SMEAR" && !d.saturated && (d.tfRangeC?.[1] ?? Infinity) < 400) fired.push("mining");
  if (ind && !d.expanding && hot && tiny)
    fired.push(coldStart ? "persistent_source_unverified"   // never auto-whitelist
                         : (h.deviationX as number) < 1.5 ? "persistent_source" : "");

  const label = PRECEDENCE.find(r => fired.includes(r)) ?? "other";
  return { label, fired: fired.filter(Boolean), flags };   // log every fired rule
}
```

Confidence is a separate weighted evidence score (thermal, spatial, historical, kinematic, verification) and is not shown here.

### PostGIS (index on the same type the queries use, idempotency, nearest-first)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE osm_landuse (
  id SERIAL PRIMARY KEY, tag TEXT NOT NULL, facility_name TEXT,
  cpcb_category TEXT, source TEXT, refreshed_at TIMESTAMPTZ,
  geom GEOMETRY(Polygon, 4326) NOT NULL);
CREATE INDEX idx_landuse_geog ON osm_landuse USING GIST ((geom::geography));

CREATE TABLE firms_detections (
  id SERIAL PRIMARY KEY, sensor TEXT NOT NULL, acq_time TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL,
  frp_mw NUMERIC, tf_range_c NUMRANGE, p_range_pct NUMRANGE,
  status TEXT DEFAULT 'ok',
  geom GEOMETRY(Point, 4326) NOT NULL,
  UNIQUE (sensor, acq_time, lat, lon));           -- idempotency key
CREATE INDEX idx_det_geog ON firms_detections USING GIST ((geom::geography));

-- nearest facility wins (rank 1); rank 2-3 are runner-ups to store on the event; no rows = unmapped
SELECT f.id AS detection_id, m.id AS facility_id, m.tag, m.distance_m,
       ROW_NUMBER() OVER (PARTITION BY f.id ORDER BY m.distance_m) AS rank
FROM firms_detections f
LEFT JOIN LATERAL (
  SELECT o.id, o.tag, ST_Distance(f.geom::geography, o.geom::geography) AS distance_m
  FROM osm_landuse o
  WHERE ST_DWithin(f.geom::geography, o.geom::geography, 50)
  ORDER BY distance_m LIMIT 3
) m ON TRUE;
```

## 6. Likely Judge Questions

| Question | Honest answer |
|---|---|
| "Is the Dozier output computed live?" | Yes, per detection at ingestion, reported as a range with saturation flagged. Show the code path. |
| "Where's the AI?" | Isolation Forest baselines and DBSCAN clustering on site history now; a learned classifier replaces the rules only when it beats them on operator-labelled data. Deliberate, not skipped. |
| "How fast can you detect a fire?" | Bounded by overpass cadence (hours). Geostationary is the roadmap answer for larger events. |
| "What about false alarms?" | Show the backtest table: per-class precision and recall and false alerts per week. |
| "What if OSM doesn't have the factory?" | It becomes `unmapped_industrial_candidate` and is reviewed like an industrial fire. |
| "Is the SAR live?" | Not yet. It is a post-event check (revisit is days), shown with a sample-data badge. |
| "What if a new plant has no history?" | Manual review; never auto-whitelisted. |

## 7. Do Not Say

* "The problem statement requires PostGIS/Twilio/Celery" (it doesn't; it asks for a GIS-based storage and visualization solution).
* "Detects fires the moment they start", "proves", "mathematically proves".
* Anything labelled ✔ in the prototype table that the demo can't show.
* TROPOMI methane as a precursor/leak predictor.
