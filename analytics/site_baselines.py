"""Per-site FRP baselines and persistent hotspot clusters from site history (Phase 3 persistence).

For each site in a HistoryRecord list:
  * records are grouped into overpasses (records within 30 min of the overpass start are summed),
    exactly like perOverpassFrp() in shared/history.ts;
  * an Isolation Forest on per-overpass features (log FRP, hour-of-day sin/cos) separates routine
    overpasses (inliers) from anomalous ones (outliers: past fires, flaring upsets, glint);
    baselineFrpMW = median per-overpass FRP of the inliers. Sites with too few overpasses fall back
    to the plain median (method "median"), the same number the TS engine computes on its own;
  * DBSCAN with the haversine metric on record locations finds persistent hotspot clusters
    (e.g. individual flare stacks or kiln rows) and noise.

Output (default data/derived/site_baselines.json):
  { generatedAt, sample, source, method, params,
    baselines: { [siteKey]: { baselineFrpMW } },   <- flat map read by the TS engine (EngineResources.baselines)
    sites:     { [siteKey]: { baselineFrpMW, method, overpasses, inliers, outliers, clusters, noise, ... } } }

Only Isolation-Forest sites go into `baselines`: the engine labels every override as
baselineSource="isolation_forest", so median-fallback sites are left to the engine's own median.
The engine still applies its own cold-start rule (< 90 days of history, newly mapped facility) on top.

Leakage: compute baselines only from history that ends BEFORE the evaluation window.
All thresholds below are starting values, to be tuned on data (Phase 8).

Run: python analytics/site_baselines.py [--history PATH] [--out PATH] [--sample]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.ensemble import IsolationForest

ROOT = Path(__file__).resolve().parent.parent
EARTH_R_M = 6371008.8  # same mean radius as shared/geo.ts

# Starting parameters — to be tuned on data.
PARAMS = {
    "overpassBucketMin": 30,  # same as HISTORY.overpassBucketMin in shared/history.ts
    "minOverpassesForIsolationForest": 10,  # below this, plain median (method "median")
    # contamination: assumed share of non-routine overpasses at a site. sklearn's "auto" flagged ~40 %
    # of overpasses on steady flare histories (score offset -0.5 is too tight for 3-D features), so a
    # documented 5 % is used instead. To be tuned on data.
    "isolationForest": {"n_estimators": 200, "contamination": 0.05, "random_state": 26162},
    "features": ["log1p(frpMW per overpass)", "sin(hour of day UTC)", "cos(hour of day UTC)"],
    "dbscan": {"eps_m": 750, "min_samples": 3, "metric": "haversine"},
}


def parse_time(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def overpasses(records: list[dict]) -> list[dict]:
    """Sum FRP per overpass: a record within 30 min of the current overpass start joins it."""
    out: list[dict] = []
    start = None
    for r in sorted(records, key=lambda r: parse_time(r["acqTime"])):
        t = parse_time(r["acqTime"])
        if start is None or (t - start).total_seconds() > PARAMS["overpassBucketMin"] * 60:
            out.append({"t": t, "frpMW": float(r["frpMW"])})
            start = t
        else:
            out[-1]["frpMW"] += float(r["frpMW"])
    return out


def overpass_features(ops: list[dict]) -> np.ndarray:
    hours = np.array([o["t"].hour + o["t"].minute / 60 for o in ops])
    frp = np.array([o["frpMW"] for o in ops])
    ang = 2 * np.pi * hours / 24
    return np.column_stack([np.log1p(frp), np.sin(ang), np.cos(ang)])


def clusters_for(records: list[dict]) -> tuple[list[dict], int]:
    """DBSCAN (haversine) on record locations -> persistent clusters + noise count."""
    if len(records) < PARAMS["dbscan"]["min_samples"]:
        return [], len(records)
    coords = np.radians(np.array([[r["lat"], r["lon"]] for r in records], dtype=float))
    labels = DBSCAN(
        eps=PARAMS["dbscan"]["eps_m"] / EARTH_R_M,
        min_samples=PARAMS["dbscan"]["min_samples"],
        metric="haversine",
        algorithm="ball_tree",
    ).fit_predict(coords)
    clusters = []
    for k in sorted(set(labels) - {-1}):
        members = [r for r, lab in zip(records, labels) if lab == k]
        c_lat = float(np.mean([m["lat"] for m in members]))
        c_lon = float(np.mean([m["lon"] for m in members]))
        radius = max(haversine_m(c_lat, c_lon, m["lat"], m["lon"]) for m in members)
        clusters.append({
            "id": int(k),
            "centroidLat": round(c_lat, 5),
            "centroidLon": round(c_lon, 5),
            "members": len(members),
            "radiusM": round(radius),
            "medianFrpMW": round(float(np.median([m["frpMW"] for m in members])), 2),
        })
    clusters.sort(key=lambda c: -c["members"])
    return clusters, int(np.sum(labels == -1))


def site_baseline(records: list[dict]) -> dict:
    ops = overpasses(records)
    frp = np.array([o["frpMW"] for o in ops])
    median_all = float(np.median(frp))
    if len(ops) >= PARAMS["minOverpassesForIsolationForest"]:
        forest = IsolationForest(**PARAMS["isolationForest"])
        inlier = forest.fit_predict(overpass_features(ops)) == 1
        if not inlier.any():  # degenerate; never happens with contamination="auto" in practice
            inlier[:] = True
        baseline, method = float(np.median(frp[inlier])), "isolation_forest"
        outlier_frp = sorted(round(float(x), 2) for x in frp[~inlier])
        note = None
    else:
        inlier = np.ones(len(ops), dtype=bool)
        baseline, method, outlier_frp = median_all, "median", []
        note = f"only {len(ops)} overpasses (< {PARAMS['minOverpassesForIsolationForest']}); Isolation Forest skipped, plain median used"
    clusters, noise = clusters_for(records)
    times = [parse_time(r["acqTime"]) for r in records]
    return {
        "baselineFrpMW": round(baseline, 2),
        "method": method,
        "records": len(records),
        "overpasses": len(ops),
        "inliers": int(inlier.sum()),
        "outliers": int((~inlier).sum()),
        "outlierFrpMW": outlier_frp,
        "medianAllFrpMW": round(median_all, 2),
        "firstSeen": min(times).isoformat().replace("+00:00", "Z"),
        "lastSeen": max(times).isoformat().replace("+00:00", "Z"),
        "clusters": clusters,
        "noise": noise,
        "note": note,
    }


def compute(history: list[dict], *, source: str, sample: bool) -> dict:
    """Pure function used by the CLI and by analytics/backtest.py (real windows)."""
    by_site: dict[str, list[dict]] = defaultdict(list)
    for r in history:
        if r.get("frpMW") is None or r.get("lat") is None or r.get("lon") is None or not r.get("acqTime"):
            continue  # malformed record: skipped, never defaulted
        by_site[r["siteKey"]].append(r)
    sites = {key: site_baseline(recs) for key, recs in sorted(by_site.items())}
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sample": sample,
        "source": source,
        "method": "isolation_forest",
        "params": PARAMS,
        "baselines": {k: {"baselineFrpMW": s["baselineFrpMW"]} for k, s in sites.items() if s["method"] == "isolation_forest"},
        "sites": sites,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--history", default=str(ROOT / "data" / "sample" / "site_history.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "derived" / "site_baselines.json"))
    ap.add_argument("--sample", action="store_true", help="mark the output as derived from SAMPLE data")
    args = ap.parse_args()

    history_path = Path(args.history)
    history = json.loads(history_path.read_text(encoding="utf8"))
    try:
        source = str(history_path.resolve().relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        source = str(history_path)
    # Sample history is always sample data, even if --sample was forgotten.
    sample = args.sample or "data/sample" in source
    result = compute(history, source=source, sample=sample)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf8")

    print(f"{'site':<16}{'method':<18}{'overp':>6}{'in':>5}{'out':>5}{'baseline':>10}{'median':>9}{'clusters':>9}{'noise':>6}")
    for key, s in result["sites"].items():
        print(f"{key:<16}{s['method']:<18}{s['overpasses']:>6}{s['inliers']:>5}{s['outliers']:>5}"
              f"{s['baselineFrpMW']:>10.2f}{s['medianAllFrpMW']:>9.2f}{len(s['clusters']):>9}{s['noise']:>6}")
    print(f"{len(result['baselines'])} Isolation-Forest baselines, {len(result['sites'])} sites -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
