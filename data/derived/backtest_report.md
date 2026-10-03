# SATFIRE backtest — sample

> **SAMPLE DATA.** Self-consistency check on generated sample data — not a performance claim.

Generated 2026-10-03T13:15:48Z. Classifier: `scripts/classify-batch.ts` (the live engine, `shared/engine.ts`).

**Caveat.** Self-consistency check on generated sample data — not a performance claim. Windows are the sample scenarios (scripts/gen-sample.ts) with their intended labels; the Vapi unmapped candidate is given truth industrial_fire, so it appears as a strict per-class miss (predicted unmapped_industrial_candidate) but counts as surfaced in industrialFireRecall. Window-level weak labels: every event in a window is assigned the window's truth label. industrialFireRecall counts industrial_fire and unmapped_industrial_candidate predictions as surfaced; strict per-class recall is in perClass. A window with no detection counts as one missed event scored as 'other'.

## Headline

| Metric | Value |
|---|---|
| Windows | 15 |
| Scored events | 15 (14 correct, 1 failures) |
| Industrial-fire recall (industrial_fire or unmapped candidate surfaced) | 1.00 |
| False industrial alerts per week (alert/code_red, truth not industrial_fire) | 0.00 |
| Weeks covered (union of windows) | 0.56 |

## Per-class precision / recall

| Class | Precision | Recall | Support (truth) | Predicted |
|---|---|---|---|---|
| industrial_fire | 1.00 | 0.75 | 4 | 3 |
| wildfire | 1.00 | 1.00 | 2 | 2 |
| agricultural_fire | 1.00 | 1.00 | 2 | 2 |
| mining | 1.00 | 1.00 | 2 | 2 |
| persistent_source | 1.00 | 1.00 | 3 | 3 |
| unmapped_industrial_candidate | 0.00 | — | 0 | 1 |
| provisional | 1.00 | 1.00 | 1 | 1 |
| other | 1.00 | 1.00 | 1 | 1 |

— = undefined (no predictions / no truth events for that class).

## Confusion (truth → predicted)

| Truth | Predicted | Count |
|---|---|---|
| industrial_fire | industrial_fire | 3 |
| industrial_fire | unmapped_industrial_candidate ✗ | 1 |
| wildfire | wildfire | 2 |
| agricultural_fire | agricultural_fire | 2 |
| mining | mining | 2 |
| persistent_source | persistent_source | 3 |
| provisional | provisional | 1 |
| other | other | 1 |

## Failures

| Window | Event | Truth | Predicted | Why |
|---|---|---|---|---|
| sample-vapi-unmapped | `EVT-CELL-20.37-72.93-20260422` | industrial_fire | unmapped_industrial_candidate | no facility/land-use polygon match; industrial-like thermal signature; tier alert; flagged for review |

## Every event, by window (successes and failures)

| Window | Truth | Event | Predicted | Tier | Winning rule | Pixels | Peak FRP MW | OK |
|---|---|---|---|---|---|---|---|---|
| sample-FAC-001-paradip | industrial_fire | `EVT-FAC-001-20260421` | industrial_fire | code_red | industrial_fire | 20 | 374.30 | ✓ |
| sample-FAC-003-korba | industrial_fire | `EVT-FAC-003-20260422` | industrial_fire | alert | industrial_fire | 4 | 125.10 | ✓ |
| sample-FAC-009-haldia | industrial_fire | `EVT-FAC-009-20260422` | industrial_fire | watch | industrial_watch | 1 | 45.10 | ✓ |
| sample-vapi-unmapped | industrial_fire | `EVT-CELL-20.37-72.93-20260422` | unmapped_industrial_candidate | alert | — | 1 | 113 | ✗ |
| sample-FAC-002-jamnagar | persistent_source | `EVT-FAC-002-20260421` | persistent_source | — | persistent_source | 5 | 8.60 | ✓ |
| sample-FAC-005-kakinada | persistent_source | `EVT-FAC-005-20260421` | persistent_source | — | persistent_source | 3 | 7.30 | ✓ |
| sample-FAC-015-bharuch-new | persistent_source | `EVT-FAC-015-20260421` | persistent_source | — | persistent_source_unverified | 2 | 11.20 | ✓ |
| sample-ludhiana-farmland | agricultural_fire | `EVT-POLY-AGRI-LDH-20260422` | agricultural_fire | — | agri_in_season | 9 | 47.10 | ✓ |
| sample-karnal-farmland | agricultural_fire | `EVT-POLY-AGRI-KNL-20260420` | agricultural_fire | — | agri_in_season | 1 | 49.70 | ✓ |
| sample-similipal-forest | wildfire | `EVT-POLY-FOR-SIM-20260421` | wildfire | — | wildfire | 13 | 259.80 | ✓ |
| sample-uttarakhand-forest | wildfire | `EVT-POLY-FOR-UK-20260422` | wildfire | — | wildfire | 9 | 176.90 | ✓ |
| sample-FAC-004-jharia | mining | `EVT-FAC-004-20260422` | mining | — | mining | 6 | 2.70 | ✓ |
| sample-FAC-010-neyveli | mining | `EVT-FAC-010-20260421` | mining | — | mining | 2 | 5.70 | ✓ |
| sample-chilika-lakeshore | provisional | `EVT-CELL-19.72-85.32-20260423` | provisional | — | — | 1 | 5.60 | ✓ |
| sample-jabalpur-roadside | other | `EVT-CELL-23.01-80.01-20260422` | other | — | — | 1 | 6.30 | ✓ |

## Windows

| Window | Truth label | Start | End | Rows in | Gate rejections | Detections |
|---|---|---|---|---|---|---|
| sample-FAC-001-paradip | industrial_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 26 | 5 | 20 |
| sample-FAC-003-korba | industrial_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 4 | 0 | 4 |
| sample-FAC-009-haldia | industrial_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 1 | 0 | 1 |
| sample-vapi-unmapped | industrial_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 1 | 0 | 1 |
| sample-FAC-002-jamnagar | persistent_source | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 5 | 0 | 5 |
| sample-FAC-005-kakinada | persistent_source | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 3 | 0 | 3 |
| sample-FAC-015-bharuch-new | persistent_source | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 2 | 0 | 2 |
| sample-ludhiana-farmland | agricultural_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 9 | 0 | 9 |
| sample-karnal-farmland | agricultural_fire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 1 | 0 | 1 |
| sample-similipal-forest | wildfire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 13 | 0 | 13 |
| sample-uttarakhand-forest | wildfire | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 9 | 0 | 9 |
| sample-FAC-004-jharia | mining | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 6 | 0 | 6 |
| sample-FAC-010-neyveli | mining | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 2 | 0 | 2 |
| sample-chilika-lakeshore | provisional | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 1 | 0 | 1 |
| sample-jabalpur-roadside | other | 2026-04-20T00:00:00Z | 2026-04-23T22:00:00Z | 1 | 0 | 1 |

## Run notes

* Isolation-Forest baselines from data/derived/site_baselines.json passed to the engine for 10 sites (method isolation_forest, sample=True).
