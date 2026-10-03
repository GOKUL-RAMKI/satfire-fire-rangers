# SATFIRE batch analytics

Python batch jobs for Phase 3 persistence baselines and the §7 validation backtest. Classification is
never reimplemented here: every backtest window goes through `node scripts/classify-batch.ts`, which
runs the same engine as the live pipeline (`shared/engine.ts`).

```bash
pip install -r analytics/requirements.txt        # numpy, scikit-learn (no GeoPandas needed)
```

## `site_baselines.py`: per-site baselines (Isolation Forest + DBSCAN)

```bash
python analytics/site_baselines.py --sample      # = npm run baselines -- --sample
#   --history data/sample/site_history.json  (HistoryRecord[])   --out data/derived/site_baselines.json
```

For each `siteKey`, the script:

* Groups records into overpasses. Records within 30 min of an overpass start are summed, the same way as `perOverpassFrp` in `shared/history.ts`.
* Fits an **Isolation Forest** on per-overpass features: log FRP, plus hour-of-day sin/cos. It uses `random_state=26162` and `contamination=0.05`. sklearn's `"auto"` setting flagged about 40% of overpasses on steady flare histories, so a documented 5% is used instead (to be tuned on data). The baseline is `baselineFrpMW = median FRP of inlier overpasses`. Sites with fewer than 10 overpasses skip the forest and use the plain median (`method: "median"`).
* Runs **DBSCAN** (haversine metric, eps 750 m, min_samples 3) on record locations. It reports persistent hotspot clusters (centroid, members, radius in m, median FRP) and a noise count.

The output has two top-level maps. `sites` holds the full per-site detail. `baselines` is the flat `{siteKey: {baselineFrpMW}}` map that `EngineResources.baselines` and `classify-batch.ts` read. Only Isolation Forest sites go into `baselines`, because the engine labels every override `baselineSource: "isolation_forest"`. Median-fallback sites are left to the engine's own median. The engine still applies its cold-start rule (under 90 days of history, or a newly mapped facility) on top.

**Leakage:** compute baselines only from history that ends before the period being classified.

## `backtest.py`: backtest harness (validation plan §7)

```bash
python analytics/backtest.py --spec analytics/backtest_sample.json
#   -> data/derived/backtest_report.json (BacktestReport, shared/types.ts) + data/derived/backtest_report.md
python analytics/backtest.py --spec analytics/backtest_real.json --out data/derived/backtest_real_report.json
```

The spec is a list of labelled windows: `{name, label, start, end, rowsPath | useSample, bbox?, historyPath?, polygonsPath?, facilitiesPath?}`. The report contains:

* per-class precision, recall, support and predicted count (`null` where undefined);
* industrial-fire recall;
* false industrial alerts per week;
* a confusion list;
* every failure with a short `why` built from `winningRule`, `fired` and `tier`.

The Markdown report also lists every event, including the successes.

Scoring rules (also written into each report's `caveat`):

* **Window-level weak labels.** Every event in a window gets the window's truth label, even if the box also holds an unrelated source (a kiln in a farmland box, a flare beside a forest).
* **`industrialFireRecall`** is the share of truth-`industrial_fire` events that were surfaced as `industrial_fire` or `unmapped_industrial_candidate`. The plan gives both the same review priority. Strict per-class recall is in `perClass`.
* **`falseIndustrialAlertsPerWeek`** counts events predicted `industrial_fire` or `unmapped_industrial_candidate` at tier `alert` or `code_red` whose truth is not `industrial_fire`, divided by the weeks in the union of all windows.
* **Empty windows.** A window with no accepted detection counts as one missed event scored `other`, so a missed fire is never silently dropped.
* **Real windows.** The fetched history is keyed by window name, but the engine only reads history whose `siteKey` equals the event's `siteKey`. The harness therefore:
  1. runs pass 1 without history to learn event site keys;
  2. re-keys each history record to the event with the nearest detection within 1.5 km;
  3. computes Isolation Forest baselines on that re-keyed history;
  4. runs the scored pass 2.

### `backtest_sample.json`: self-consistency only

This spec has one window per sample scenario (`useSample: true`, rows cut from `data/sample/firms_raw.json` by bbox, 2026-04-20 → 2026-04-23 22:00Z). It passes the Isolation Forest baselines from `data/derived/site_baselines.json` to the engine, so run `site_baselines.py` first.

Labels:

| Truth label | Windows |
|---|---|
| `industrial_fire` | FAC-001, FAC-003, FAC-009 |
| `persistent_source` | FAC-002, FAC-005, FAC-015 |
| `agricultural_fire` | Ludhiana, Karnal |
| `wildfire` | Similipal, Uttarakhand |
| `mining` | FAC-004 Jharia, FAC-010 Neyveli |
| `provisional` | Chilika lake shore |
| `other` | Jabalpur roadside |

**Choice:** the Vapi unmapped hot spot has truth `industrial_fire`. It is therefore a strict per-class miss (predicted `unmapped_industrial_candidate`), but it counts as surfaced in industrial-fire recall.

The sample was generated to exercise these scenarios, so near-perfect scores are expected. The report sets `sample: true` and says **"Self-consistency check on generated sample data — not a performance claim."**

### `backtest_real.json` + `scripts/fetch-firms-history.ts`: real historical backtest

```bash
npm run firms:history                 # needs FIRMS_MAP_KEY in .env.local (or the environment)
npm run osm:load                      # data/osm/landuse.geojson must cover the window bboxes (see below)
python analytics/backtest.py --spec analytics/backtest_real.json --out data/derived/backtest_real_report.json
npm run firms:history -- --dry-run    # no key, no network: fake CSV into the OS temp dir + a spec for backtest.py
```

The fetcher pulls `VIIRS_SNPP_SP` (standard-processing archive) from the FIRMS area API. It requests at most 10 days at a time, waits 2 s between requests, retries with backoff, and never prints the key.

It writes:

* `data/backtest/<window>.json`: FirmsRow list with a `source` field;
* `data/backtest/<window>_history.json`: the 365 days before the window start, as HistoryRecord list with `siteKey` = window name;
* `data/backtest/manifest.json`.

Existing files are skipped unless `--force` is given, and `--only a,b` limits the windows.

| Window | Truth | Dates | Why |
|---|---|---|---|
| punjab-sangrur-stubble-2023 | agricultural_fire | 2023-10-25 → 11-14 | Paddy-stubble peak, rural Sangrur |
| punjab-ludhiana-stubble-2023 | agricultural_fire | 2023-10-25 → 11-14 | Paddy-stubble peak, near Jagraon |
| jamnagar-refinery-2023 | persistent_source | 2023-03-01 → 03-28 | Routine refinery flares |
| jharia-coalfield-2023 | mining | 2023-03-01 → 03-28 | Coal-seam fires / open-cast mining |
| similipal-forest-fire-2021 | wildfire | 2021-02-25 → 03-10 | Similipal forest fires |
| uttarakhand-forest-fire-2021 | wildfire | 2021-04-01 → 04-10 | Pauri Garhwal forest fires |
| baghjan-blowout-fire-2020 | industrial_fire | 2020-06-09 → 06-22 | Baghjan-5 oil-well blowout fire |
| hpcl-vizag-refinery-fire-2021 | industrial_fire | 2021-05-25 → 05-26 | HPCL refinery fire (afternoon; may fall between overpasses) |

**OSM polygons are required for meaningful real results.** The engine reads `polygonsPath`, which defaults to `data/osm/landuse.geojson`. `npm run osm:load` (`scripts/load-osm.ts`) must include every bbox in `backtest_real.json`. Alternatively, set a per-window `polygonsPath`. Without polygons every event is unmapped, and the harness writes that warning into the report.

## Honest caveats

* The **sample** backtest is a self-consistency check, not a performance claim.
* The **real** windows, dates and bboxes were chosen from public reporting and recalled by the analyst. **Verify each bbox on a map before quoting results.** Labels are window-level weak labels, not per-event gold labels. Phase 8 forbids using weak labels to evaluate a learned model, and this harness does not do that. It measures the transparent rule engine.
* FIRMS standard-processing rows carry `type` (static land source). The engine uses it as `staticSourceFlag`. NRT rows do not have it.
* A short industrial fire can fall entirely between VIIRS overpasses (HPCL 2021 is included on purpose). Such a window scores as a miss.
* All thresholds (contamination 5%, 10-overpass minimum, DBSCAN 750 m / 3, re-key radius 1.5 km) are starting values, to be tuned on data.
