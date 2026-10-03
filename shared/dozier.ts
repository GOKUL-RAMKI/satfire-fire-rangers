// Dozier (1981) two-band sub-pixel unmixing for VIIRS I4 (~3.74 µm) / I5 (~11.45 µm).
// Based on the reference solver in v3_execution_checklist.md §5, with two additions:
//   * the central solve (at the assumed background) is returned alongside the range, and the
//     classifier gates on it (agents.md deviation a — the lower bound of a ±σ background band
//     collapses for small-area hot sources such as flares);
//   * flags for default background, partial range, wide range and daytime reflected solar.

import type { DozierResult } from "./types.ts";

export const C2 = 14387.77; // µm·K, second radiation constant
export const WL4 = 3.74;
export const WL5 = 11.45;
export const I4_SAT_K = 367; // approximate VIIRS I4 saturation; verify against product docs
export const I5_SAT_K = 380;
export const DEFAULT_BG_K = 300;
export const DEFAULT_BG_SIGMA_K = 4;
const SIGMA_SB = 5.670374419e-8;

// Relative spectral radiance; the constant factor cancels in the p ratios.
export const planck = (tK: number, wl: number) => 1 / (wl ** 5 * (Math.exp(C2 / (wl * tK)) - 1));
/** Inverse of `planck`: brightness temperature for a relative radiance. */
export const brightnessT = (L: number, wl: number) => C2 / (wl * Math.log(1 + 1 / (L * wl ** 5)));

export function solveOnce(b4: number, b5: number, bgK: number): { tfK: number; p: number } | null {
  const L4 = planck(b4, WL4), L5 = planck(b5, WL5);
  const B4 = planck(bgK, WL4), B5 = planck(bgK, WL5);
  if (L4 <= B4 || L5 <= B5) return null; // not warmer than background
  const resid = (tf: number) => (L4 - B4) / (planck(tf, WL4) - B4) - (L5 - B5) / (planck(tf, WL5) - B5);
  let lo = 500, hi = 2000, flo = resid(lo);
  if (flo * resid(hi) > 0) return null; // no root in bounds
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, fm = resid(mid);
    if (flo * fm <= 0) hi = mid;
    else { lo = mid; flo = fm; }
  }
  const tfK = (lo + hi) / 2;
  const p = (L4 - B4) / (planck(tfK, WL4) - B4);
  return p > 0 && p <= 1 ? { tfK, p } : null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function dozierUnmix(
  b4: number | null,
  b5: number | null,
  opts: { bgK?: number; bgSigmaK?: number; bgSource?: "default_300K" | "neighbour_median"; dayNight?: "D" | "N" } = {},
): DozierResult {
  const bgK = opts.bgK ?? DEFAULT_BG_K;
  const bgSigmaK = opts.bgSigmaK ?? DEFAULT_BG_SIGMA_K;
  const backgroundSource = opts.bgSource ?? "default_300K";
  const base = {
    backgroundK: bgK,
    backgroundSigmaK: bgSigmaK,
    backgroundSource,
    tfCentralC: null,
    pCentralPct: null,
    tfRangeC: null,
    pRangePct: null,
  };
  // never default a band to 0: missing or implausible input is "invalid", not a guess
  if (b4 === null || b5 === null || !(b4 >= 200 && b5 >= 200)) {
    return { ...base, status: "invalid", saturated: false, flags: ["invalid_band_input"] };
  }
  const flags: string[] = [];
  if (backgroundSource === "default_300K") flags.push("background_default");
  if (opts.dayNight === "D") flags.push("daytime_reflected_solar");
  const saturated = b4 >= I4_SAT_K - 0.5 || b5 >= I5_SAT_K - 0.5;
  if (saturated) flags.push("saturated");

  const bgs = [bgK - bgSigmaK, bgK, bgK + bgSigmaK];
  const solves = bgs.map((bg) => solveOnce(b4, b5, bg));
  const central = solves[1];
  const sols = solves.filter((s): s is { tfK: number; p: number } => s !== null);
  if (!sols.length) return { ...base, status: "unsolvable", saturated, flags };
  if (sols.length < solves.length) flags.push("partial_range");

  const tfC = sols.map((s) => s.tfK - 273.15);
  const pPct = sols.map((s) => s.p * 100);
  const tfRangeC: [number, number] = [r1(Math.min(...tfC)), r1(Math.max(...tfC))];
  const pRangePct: [number, number] = [r4(Math.min(...pPct)), r4(Math.max(...pPct))];
  if (tfRangeC[1] - tfRangeC[0] > 300 || pRangePct[1] > 2 * Math.max(pRangePct[0], 1e-6)) flags.push("range_wide");

  return {
    ...base,
    status: saturated ? "saturated_lower_bound" : "ok",
    saturated,
    tfCentralC: central ? r1(central.tfK - 273.15) : null,
    pCentralPct: central ? r4(central.p * 100) : null,
    tfRangeC,
    pRangePct,
    flags,
  };
}

/** MODIS is not mixed into the VIIRS physical solve (plan Phase 1). */
export function dozierNotApplicable(reason: string): DozierResult {
  return {
    status: "not_applicable",
    saturated: false,
    tfCentralC: null,
    pCentralPct: null,
    tfRangeC: null,
    pRangePct: null,
    backgroundK: DEFAULT_BG_K,
    backgroundSigmaK: DEFAULT_BG_SIGMA_K,
    backgroundSource: "default_300K",
    flags: [reason],
  };
}

/**
 * Forward model used by the sample generator and tests: pixel brightness temperatures and FRP for a
 * fire of temperature tfC occupying pPct % of a pixel over a background bgK.
 */
export function forwardModel(tfC: number, pPct: number, bgK: number, pixelAreaM2: number) {
  const tf = tfC + 273.15;
  const p = pPct / 100;
  const b4 = brightnessT(p * planck(tf, WL4) + (1 - p) * planck(bgK, WL4), WL4);
  const b5 = brightnessT(p * planck(tf, WL5) + (1 - p) * planck(bgK, WL5), WL5);
  const frpMW = (SIGMA_SB * pixelAreaM2 * p * (tf ** 4 - bgK ** 4)) / 1e6;
  return { b4, b5, frpMW };
}

/** Fire radius (m) implied by a sub-pixel fraction, used to shrink the footprint before the boundary match. */
export function fireRadiusM(pPct: number, pixelAreaM2: number): number {
  return Math.sqrt(((pPct / 100) * pixelAreaM2) / Math.PI);
}
