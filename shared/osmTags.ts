// Shared OpenStreetMap tag -> land-use / facility-type / CPCB logic.
// One implementation used by every polygon loader (Overpass focus-region loader,
// Geofabrik national extract, reprocess path). Pure functions only — no node:*
// imports, so this file stays safe to bundle into the browser.
// CPCB 2016 categorisation by industry type — derived, not an official per-facility record.

import type { CpcbCategory, LandTag } from "./types.ts";

const NON_THERMAL_POWER = /^(solar|wind|hydro|tidal)$/;

export function tagOf(t: Record<string, string>): LandTag | null {
  // solar / wind / hydro plants are not thermal sources: they are no industrial anchor
  if (t.power === "plant" && NON_THERMAL_POWER.test(t["plant:source"] ?? "") && t.landuse !== "industrial") return null;
  if (t.landuse === "quarry" || t.industrial === "mine" || t.landuse === "mine") return "quarry";
  if (t.landuse === "industrial" || t.power === "plant" || t.man_made === "works" || t.man_made === "kiln" || t.industrial === "brickyard") return "industrial";
  if (t.landuse === "farmland") return "farmland";
  if (t.landuse === "forest" || t.natural === "wood") return "forest";
  return null;
}

export function typeOf(t: Record<string, string>): { type: string; kiln: boolean } {
  if (t.man_made === "kiln" || t.industrial === "brickyard") return { type: "Brick kiln", kiln: true };
  if (t.industrial === "refinery" || t.industrial === "oil_refinery") return { type: "Oil refinery", kiln: false };
  if (t.industrial === "petrochemical") return { type: "Petrochemical complex", kiln: false };
  if (t.power === "plant") return { type: NON_THERMAL_POWER.test(t["plant:source"] ?? "") ? "Power plant (non-thermal)" : "Thermal power plant", kiln: false };
  if (/steel|iron/.test(t.industrial ?? "") || t.product === "steel") return { type: "Steel plant", kiln: false };
  if (t.industrial === "fertilizer" || t.industrial === "chemical") return { type: t.industrial === "fertilizer" ? "Fertilizer plant" : "Chemical plant", kiln: false };
  if (t.industrial === "mine" || t.landuse === "quarry") return { type: "Mine / quarry", kiln: false };
  // fall back to the name when OSM has no industrial=* detail (still a derived type, see cpcbSource)
  const name = `${t.name ?? ""} ${t["name:en"] ?? ""}`.toLowerCase();
  if (/refiner/.test(name)) return { type: "Oil refinery", kiln: false };
  if (/petrochem/.test(name)) return { type: "Petrochemical complex", kiln: false };
  if (/steel|ispat/.test(name)) return { type: "Steel plant", kiln: false };
  if (/thermal power|power station|super thermal|\bstps\b|\btps\b/.test(name)) return { type: "Thermal power plant", kiln: false };
  if (/fertili[sz]er/.test(name)) return { type: "Fertilizer plant", kiln: false };
  if (/brick/.test(name)) return { type: "Brick kiln", kiln: true };
  if (/\bcoal\b|colliery|lignite/.test(name)) return { type: "Mine / quarry", kiln: false };
  return { type: "Industrial site", kiln: false };
}

const RED = new Set(["Oil refinery", "Petrochemical complex", "Thermal power plant", "Steel plant", "Fertilizer plant", "Chemical plant", "Mine / quarry"]);

export function cpcbOf(type: string): CpcbCategory | null {
  return RED.has(type) ? "Red" : type === "Brick kiln" ? "Red" : null;
}
