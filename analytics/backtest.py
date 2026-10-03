"""Backtest harness (validation plan §7): per-class precision/recall, industrial-fire recall and false
industrial alerts per week over labelled FIRMS windows. Failures are reported as well as successes.

Every window is classified by `node scripts/classify-batch.ts` — the SAME engine as the live
pipeline (shared/engine.ts). No classification rule is reimplemented here.

Spec (JSON): either a bare list of windows or
  { dataset, sample, caveat, baselinesPath?, windows: [
      { name, label (ClassKey truth), start, end,            # ISO datetime, or YYYY-MM-DD (end inclusive)
        useSample? | rowsPath?,                              # rows: sample FIRMS rows, or a JSON FirmsRow list
        bbox?: [west, south, east, north],                   # optional row filter (used to cut sample scenarios)
        historyPath?, polygonsPath?, facilitiesPath?, now? } ] }

Labels are WINDOW-LEVEL WEAK LABELS: every event in a window gets the window's truth label, even if
the window also contains an unrelated source (a kiln inside a farmland box, a flare beside a forest).

Scoring rules (all stated in the report caveat):
  * per-class precision/recall are strict (predicted label == truth label); null when undefined;
  * industrialFireRecall = share of truth-industrial_fire events SURFACED as industrial, i.e. predicted
    industrial_fire or unmapped_industrial_candidate (the plan routes both to operators with the same
    priority); the strict per-class recall is in perClass;
  * falseIndustrialAlertsPerWeek = events predicted industrial_fire / unmapped_industrial_candidate
    with tier alert or code_red whose truth is not industrial_fire, divided by the weeks covered by
    the union of all windows;
  * a window with no accepted detection counts as ONE missed event, scored as "other" (nothing was
    surfaced), so a missed fire is never silently dropped from the table.

Real (non-sample) windows: the fetched history is keyed by window name, but the engine only reads
history whose siteKey equals the event's siteKey (facility id / polygon id / CELL-lat-lon). So the
harness runs a first pass without history to learn each event's siteKey, re-keys every history
record to the siteKey of the event with the nearest detection within 1.5 km, computes Isolation-Forest
baselines on that re-keyed history (analytics/site_baselines.py) and runs the scored second pass.

Run: python analytics/backtest.py --spec analytics/backtest_sample.json
     python analytics/backtest.py --spec analytics/backtest_real.json --out data/derived/backtest_real_report.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_baselines  # noqa: E402  (same directory)

ROOT = Path(__file__).resolve().parent.parent
CLASSES = [
    "industrial_fire",
    "wildfire",
    "agricultural_fire",
    "mining",
    "persistent_source",
    "unmapped_industrial_candidate",
    "provisional",
    "other",
]
INDUSTRIAL_PREDICTIONS = {"industrial_fire", "unmapped_industrial_candidate"}
ALERT_TIERS = {"alert", "code_red"}
REKEY_RADIUS_M = 1500  # same radius the engine uses for CELL-* history (shared/engine.ts)
NO_DETECTION_ID = "(no detection in window)"

WEAK_LABEL_CAVEAT = (
    "Window-level weak labels: every event in a window is assigned the window's truth label. "
    "industrialFireRecall counts industrial_fire and unmapped_industrial_candidate predictions as surfaced; "
    "strict per-class recall is in perClass. A window with no detection counts as one missed event scored as 'other'."
)


# ---------------------------------------------------------------- time helpers

def parse_bound(value: str, *, end: bool) -> datetime:
    """ISO datetime, or YYYY-MM-DD (start -> 00:00Z, end -> inclusive, 23:59:59Z)."""
    if len(value) == 10:
        d = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
        return d + timedelta(days=1, seconds=-1) if end else d
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds").replace("+00:00", "Z")


def row_time(row: dict) -> datetime | None:
    try:
        date, t = row.get("acq_date", "").strip(), row.get("acq_time", "").strip().zfill(4)
        return datetime.strptime(f"{date} {t}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def weeks_covered(windows: list[dict]) -> float:
    """Length of the union of all window intervals, in weeks."""
    spans = sorted((w["_start"], w["_end"]) for w in windows)
    total, cur_s, cur_e = timedelta(0), None, None
    for s, e in spans:
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += cur_e - cur_s
    return total.total_seconds() / (7 * 86400)


# ---------------------------------------------------------------- inputs

def load_json(path: str | Path):
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    return json.loads(p.read_text(encoding="utf8"))


def abs_path(path: str) -> str:
    p = Path(path)
    return str(p if p.is_absolute() else ROOT / p)


def window_rows(w: dict) -> list[dict]:
    if w.get("rowsPath"):
        data = load_json(w["rowsPath"])
        rows = data["rows"] if isinstance(data, dict) else data
    elif w.get("useSample"):
        rows = load_json("data/sample/firms_raw.json")["rows"]
    else:
        raise SystemExit(f"window {w['name']}: needs rowsPath or useSample")
    out = []
    for r in rows:
        if w.get("bbox"):
            # Rows with an invalid location cannot be assigned to a box; they are dropped here (the
            # quality gate would reject them anyway). Everything else goes through the engine's gate.
            west, south, east, north = w["bbox"]
            try:
                lat, lon = float(r.get("latitude", "")), float(r.get("longitude", ""))
            except ValueError:
                continue
            if not (south <= lat <= north and west <= lon <= east):
                continue
        # Rows whose time does not parse are KEPT so the quality gate rejects them with a logged reason.
        t = row_time(r)
        if t is not None and not (w["_start"] <= t <= w["_end"]):
            continue
        out.append(r)
    return out


# ---------------------------------------------------------------- engine

def classify(request: dict) -> dict:
    proc = subprocess.run(
        ["node", "scripts/classify-batch.ts"],
        input=json.dumps(request).encode("utf8"),
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"classify-batch failed:\n{proc.stderr.decode('utf8', 'replace')}")
    return json.loads(proc.stdout.decode("utf8"))


def detection_points(event: dict) -> list[tuple[float, float]]:
    """Detection ids are sensor|acqTime|lat|lon (shared/qualityGate.ts detectionKey)."""
    pts = []
    for did in event.get("detectionIds", []):
        parts = did.split("|")
        try:
            pts.append((float(parts[2]), float(parts[3])))
        except (IndexError, ValueError):
            pass
    return pts or [(event["lat"], event["lon"])]


def rekey_history(history: list[dict], events: list[dict], window: str) -> tuple[list[dict], int]:
    """Attribute each history record to the nearest first-pass event (by detection) within 1.5 km."""
    targets = [(e["siteKey"], lat, lon) for e in events for lat, lon in detection_points(e)]
    out, matched = [], 0
    for r in history:
        best, best_d = None, REKEY_RADIUS_M
        for key, lat, lon in targets:
            d = site_baselines.haversine_m(r["lat"], r["lon"], lat, lon)
            if d <= best_d:
                best, best_d = key, d
        matched += best is not None
        out.append({**r, "siteKey": best or f"HIST-{window}"})
    return out, matched


def run_window(w: dict, sample_baselines: dict | None, notes: list[str]) -> dict:
    rows = window_rows(w)
    req: dict = {"rows": rows, "now": w.get("now") or iso(w["_end"])}
    if w.get("useSample"):
        req["useSample"] = True
        if sample_baselines:
            req["baselines"] = sample_baselines
        return {"rows": len(rows), **classify(req)}

    polygons = abs_path(w.get("polygonsPath") or "data/osm/landuse.geojson")
    if not Path(polygons).exists():
        notes.append(f"{w['name']}: polygon file {w.get('polygonsPath') or 'data/osm/landuse.geojson'} missing - "
                     "no land-use context, every event is unmapped (results not meaningful)")
    req["polygonsPath"] = polygons
    if w.get("facilitiesPath"):
        req["facilitiesPath"] = abs_path(w["facilitiesPath"])
    if not w.get("historyPath"):
        return {"rows": len(rows), **classify(req)}

    history = load_json(w["historyPath"])
    first = classify(req)  # pass 1: learn event siteKeys (independent of history)
    rekeyed, matched = rekey_history(history, first["events"], w["name"])
    baselines = site_baselines.compute(rekeyed, source=w["historyPath"], sample=False)["baselines"]
    notes.append(f"{w['name']}: {len(history)} history records, {matched} re-keyed to window events, "
                 f"{len(baselines)} Isolation-Forest baselines")
    req["history"] = rekeyed
    if baselines:
        req["baselines"] = baselines
    return {"rows": len(rows), **classify(req)}


# ---------------------------------------------------------------- metrics

def why(e: dict) -> str:
    label, rule, fired, tier = e["label"], e.get("winningRule"), e.get("fired") or [], e.get("tier")
    if e["id"] == NO_DETECTION_ID:
        return "no FIRMS detection passed the gate in this window (revisit gap, cloud or below detection limit)"
    if label == "provisional":
        s = "held provisional by the quality gate (low-confidence pixel); not scored by the rules"
    elif label == "other":
        s = "no class rule fired"
    elif label == "unmapped_industrial_candidate":
        s = "no facility/land-use polygon match; industrial-like thermal signature"
    else:
        s = f"rule {rule} won" + (f" over {', '.join(f for f in fired if f != rule)}" if len(fired) > 1 else "")
    if tier:
        s += f"; tier {tier}"
    if e.get("needsReview"):
        s += "; flagged for review"
    return s


def score(windows: list[dict], results: dict[str, dict]) -> tuple[list[dict], dict]:
    scored = []  # (window, truth, event)
    for w in windows:
        events = results[w["name"]]["events"]
        if not events:
            events = [{"id": NO_DETECTION_ID, "label": "other", "tier": None, "winningRule": None, "fired": [],
                       "needsReview": False, "detectionIds": [], "siteKey": "-", "peakFrpMW": None}]
        for e in events:
            scored.append({"window": w["name"], "truth": w["label"], "event": e})

    truth_n = Counter(s["truth"] for s in scored)
    pred_n = Counter(s["event"]["label"] for s in scored)
    tp = Counter(s["truth"] for s in scored if s["truth"] == s["event"]["label"])
    per_class = []
    for c in CLASSES:
        per_class.append({
            "label": c,
            "precision": round(tp[c] / pred_n[c], 3) if pred_n[c] else None,
            "recall": round(tp[c] / truth_n[c], 3) if truth_n[c] else None,
            "support": truth_n[c],
            "predicted": pred_n[c],
        })

    ind = [s for s in scored if s["truth"] == "industrial_fire"]
    ind_recall = round(sum(s["event"]["label"] in INDUSTRIAL_PREDICTIONS for s in ind) / len(ind), 3) if ind else None
    false_alerts = [s for s in scored if s["event"]["label"] in INDUSTRIAL_PREDICTIONS
                    and s["event"].get("tier") in ALERT_TIERS and s["truth"] != "industrial_fire"]
    weeks = weeks_covered(windows)

    pairs = Counter((s["truth"], s["event"]["label"]) for s in scored)
    confusion = [{"truth": t, "predicted": p, "count": n}
                 for (t, p), n in sorted(pairs.items(), key=lambda kv: (CLASSES.index(kv[0][0]), CLASSES.index(kv[0][1])))]
    failures = [{"window": s["window"], "eventId": s["event"]["id"], "truth": s["truth"],
                 "predicted": s["event"]["label"], "why": why(s["event"])}
                for s in scored if s["truth"] != s["event"]["label"]]
    metrics = {
        "perClass": per_class,
        "industrialFireRecall": ind_recall,
        "falseIndustrialAlertsPerWeek": round(len(false_alerts) / weeks, 3) if weeks > 0 else None,
        "weeksCovered": round(weeks, 3),
        "confusion": confusion,
        "failures": failures,
    }
    return scored, metrics


# ---------------------------------------------------------------- output

def fmt(x, none: str = "—") -> str:
    return none if x is None else f"{x:.2f}" if isinstance(x, float) else str(x)


def write_markdown(path: Path, report: dict, scored: list[dict], results: dict, notes: list[str]) -> None:
    L = []
    L.append(f"# SATFIRE backtest — {report['dataset']}")
    L.append("")
    if report["sample"]:
        L.append("> **SAMPLE DATA.** Self-consistency check on generated sample data — not a performance claim.")
        L.append("")
    L.append(f"Generated {report['generatedAt']}. Classifier: `scripts/classify-batch.ts` (the live engine, `shared/engine.ts`).")
    L.append("")
    L.append(f"**Caveat.** {report['caveat']}")
    L.append("")
    n_events = len(scored)
    n_ok = sum(s["truth"] == s["event"]["label"] for s in scored)
    L.append("## Headline")
    L.append("")
    L.append("| Metric | Value |")
    L.append("|---|---|")
    L.append(f"| Windows | {len(report['windows'])} |")
    L.append(f"| Scored events | {n_events} ({n_ok} correct, {n_events - n_ok} failures) |")
    L.append(f"| Industrial-fire recall (industrial_fire or unmapped candidate surfaced) | {fmt(report['industrialFireRecall'])} |")
    L.append(f"| False industrial alerts per week (alert/code_red, truth not industrial_fire) | {fmt(report['falseIndustrialAlertsPerWeek'])} |")
    L.append(f"| Weeks covered (union of windows) | {report['weeksCovered']} |")
    L.append("")
    L.append("## Per-class precision / recall")
    L.append("")
    L.append("| Class | Precision | Recall | Support (truth) | Predicted |")
    L.append("|---|---|---|---|---|")
    for c in report["perClass"]:
        L.append(f"| {c['label']} | {fmt(c['precision'])} | {fmt(c['recall'])} | {c['support']} | {c['predicted']} |")
    L.append("")
    L.append("— = undefined (no predictions / no truth events for that class).")
    L.append("")
    L.append("## Confusion (truth → predicted)")
    L.append("")
    L.append("| Truth | Predicted | Count |")
    L.append("|---|---|---|")
    for c in report["confusion"]:
        mark = "" if c["truth"] == c["predicted"] else " ✗"
        L.append(f"| {c['truth']} | {c['predicted']}{mark} | {c['count']} |")
    L.append("")
    L.append("## Failures")
    L.append("")
    if report["failures"]:
        L.append("| Window | Event | Truth | Predicted | Why |")
        L.append("|---|---|---|---|---|")
        for f in report["failures"]:
            L.append(f"| {f['window']} | `{f['eventId']}` | {f['truth']} | {f['predicted']} | {f['why']} |")
    else:
        L.append("None.")
    L.append("")
    L.append("## Every event, by window (successes and failures)")
    L.append("")
    L.append("| Window | Truth | Event | Predicted | Tier | Winning rule | Pixels | Peak FRP MW | OK |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for s in scored:
        e = s["event"]
        L.append(f"| {s['window']} | {s['truth']} | `{e['id']}` | {e['label']} | {e.get('tier') or '—'} | "
                 f"{e.get('winningRule') or '—'} | {len(e.get('detectionIds', []))} | {fmt(e.get('peakFrpMW'))} | "
                 f"{'✓' if s['truth'] == e['label'] else '✗'} |")
    L.append("")
    L.append("## Windows")
    L.append("")
    L.append("| Window | Truth label | Start | End | Rows in | Gate rejections | Detections |")
    L.append("|---|---|---|---|---|---|---|")
    for w in report["windows"]:
        r = results[w["name"]]
        L.append(f"| {w['name']} | {w['label']} | {w['start']} | {w['end']} | {r['rows']} | {len(r['rejections'])} | {w['detections']} |")
    if notes:
        L.append("")
        L.append("## Run notes")
        L.append("")
        L.extend(f"* {n}" for n in notes)
    path.write_text("\n".join(L) + "\n", encoding="utf8")


def main() -> int:
    ap = argparse.ArgumentParser(description="SATFIRE backtest harness (validation plan §7)")
    ap.add_argument("--spec", default=str(ROOT / "analytics" / "backtest_sample.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "derived" / "backtest_report.json"))
    ap.add_argument("--md", default=None, help="markdown report path (default: --out with .md)")
    ap.add_argument("--baselines", default=None,
                    help="site_baselines.json whose `baselines` map is passed to sample windows (overrides spec baselinesPath)")
    ap.add_argument("--no-baselines", action="store_true", help="let the engine use its own median baselines")
    args = ap.parse_args()

    spec = load_json(args.spec)
    if isinstance(spec, list):
        spec = {"windows": spec}
    windows = spec["windows"]
    for w in windows:
        if w["label"] not in CLASSES:
            raise SystemExit(f"window {w['name']}: unknown label {w['label']}")
        w["_start"], w["_end"] = parse_bound(w["start"], end=False), parse_bound(w["end"], end=True)
        if w.get("rowsPath") and not (ROOT / w["rowsPath"]).exists() and not Path(w["rowsPath"]).exists():
            raise SystemExit(f"window {w['name']}: {w['rowsPath']} not found — fetch it first "
                             f"(npm run firms:history -- --spec {args.spec}). No results are produced without data.")

    sample_baselines = None
    baselines_path = None if args.no_baselines else (args.baselines or spec.get("baselinesPath"))
    notes: list[str] = []
    if baselines_path:
        b = load_json(baselines_path)
        sample_baselines = b.get("baselines") or None
        notes.append(f"Isolation-Forest baselines from {baselines_path} passed to the engine for "
                     f"{len(sample_baselines or {})} sites (method {b.get('method')}, sample={b.get('sample')}).")
    elif any(w.get("useSample") for w in windows):
        notes.append("No baseline file: sample windows used the engine's own median per-overpass baselines.")

    results = {}
    for w in windows:
        results[w["name"]] = run_window(w, sample_baselines, notes)
        ev = results[w["name"]]["events"]
        print(f"  {w['name']:<32} truth={w['label']:<30} rows={results[w['name']]['rows']:<5} "
              f"events={len(ev):<3} predicted={','.join(sorted({e['label'] for e in ev})) or '(none)'}")

    scored, metrics = score(windows, results)
    is_sample = bool(spec.get("sample", False))
    caveat = " ".join(x for x in [spec.get("caveat", ""), WEAK_LABEL_CAVEAT] if x)
    polygon_notes = [n for n in notes if "polygon file" in n]
    if polygon_notes:
        caveat += " OSM land-use polygons were missing for some windows; those events had no spatial context."
    report = {
        "generatedAt": iso(datetime.now(timezone.utc)),
        "dataset": spec.get("dataset", "sample" if is_sample else "firms_archive"),
        "sample": is_sample,
        "caveat": caveat,
        "windows": [{"name": w["name"], "label": w["label"], "start": w["start"], "end": w["end"],
                     "detections": sum(len(e.get("detectionIds", [])) for e in results[w["name"]]["events"])}
                    for w in windows],
        **metrics,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf8")
    md = Path(args.md) if args.md else out.with_suffix(".md")
    write_markdown(md, report, scored, results, notes)

    print(f"\n{'class':<31}{'prec':>6}{'recall':>8}{'support':>9}{'pred':>6}")
    for c in report["perClass"]:
        print(f"{c['label']:<31}{fmt(c['precision'], '-'):>6}{fmt(c['recall'], '-'):>8}{c['support']:>9}{c['predicted']:>6}")
    print(f"industrialFireRecall={fmt(report['industrialFireRecall'], '-')} "
          f"falseIndustrialAlertsPerWeek={fmt(report['falseIndustrialAlertsPerWeek'], '-')} "
          f"weeksCovered={report['weeksCovered']} failures={len(report['failures'])}")
    for n in notes:
        print(f"note: {n}")
    print(f"-> {out}\n-> {md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
