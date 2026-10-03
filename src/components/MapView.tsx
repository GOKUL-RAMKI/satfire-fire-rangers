import { useEffect } from "react";
import { CircleMarker, GeoJSON, MapContainer, Polygon, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { PathOptions } from "leaflet";
import type { FeatureCollection } from "geojson";
import { offsetLatLon } from "../../shared/geo.ts";
import { CLASS_COLORS, CLASS_LABELS, TIER_LABELS } from "../../shared/labels.ts";
import type { LandTag, PolygonCollection, PolygonFeature, SatEvent } from "../../shared/types.ts";
import { fmtNum, fmtTime } from "../lib/format";
import { SampleBadge } from "./badges";

const TILE_URL: string = import.meta.env.VITE_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION: string =
  import.meta.env.VITE_TILE_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const TAG_COLORS: Record<LandTag, string> = {
  industrial: "#52525b",
  quarry: "#7e22ce",
  forest: "#15803d",
  farmland: "#b7791f",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function polygonPopup(f: PolygonFeature): string {
  const p = f.properties;
  return [
    `<b>${esc(p.name ?? p.id)}</b>`,
    `tag: ${esc(p.tag)}${p.facilityId ? ` · facility ${esc(p.facilityId)}` : ""}`,
    `CPCB: ${esc(p.cpcbCategory ?? "—")}`,
    `source: ${esc(p.source)}`,
    `refreshed: ${esc(fmtTime(p.refreshedAt))}`,
    p.mappedSince ? `mapped since: ${esc(p.mappedSince)}` : "",
  ]
    .filter(Boolean)
    .join("<br/>");
}

function FlyTo({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo([lat, lon], Math.max(map.getZoom(), 9), { duration: 0.8 });
  }, [lat, lon, map]);
  return null;
}

/** Indicative downwind wedge: fixed 5 km, ±20° around the downwind bearing. Not a dispersion model. */
function wedgePoints(lat: number, lon: number, toDeg: number): [number, number][] {
  const pts: [number, number][] = [[lat, lon]];
  for (let a = toDeg - 20; a <= toDeg + 20; a += 5) {
    const r = (a * Math.PI) / 180;
    pts.push(offsetLatLon(lat, lon, 5000 * Math.sin(r), 5000 * Math.cos(r)));
  }
  return pts;
}

function markerStyle(e: SatEvent, selected: boolean): { radius: number; path: PathOptions } {
  const label = e.classification.label;
  const color = CLASS_COLORS[label];
  if (label === "industrial_fire")
    return { radius: selected ? 12 : 9, path: { color: "#ffffff", weight: selected ? 4 : 2.5, fillColor: color, fillOpacity: 0.95 } };
  if (label === "provisional")
    return { radius: selected ? 9 : 6, path: { color, weight: selected ? 3 : 1.5, dashArray: "2 3", fillColor: color, fillOpacity: 0.2 } };
  if (label === "unmapped_industrial_candidate")
    return { radius: selected ? 11 : 8, path: { color: "#1d1b16", weight: selected ? 3 : 2, dashArray: "4 2", fillColor: color, fillOpacity: 0.9 } };
  return { radius: selected ? 9 : 6, path: { color: selected ? "#1d1b16" : color, weight: selected ? 3 : 1.5, fillColor: color, fillOpacity: 0.75 } };
}

export default function MapView({
  events,
  polygons,
  polygonSample = false,
  selectedId,
  onSelect,
  height = 520,
  showPolygons = true,
  flyToSelected = true,
  windToDeg = null,
}: {
  events: SatEvent[];
  polygons: PolygonCollection | null;
  polygonSample?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  height?: number;
  showPolygons?: boolean;
  /** Pan/zoom to the selected event (off for an implicit default selection). */
  flyToSelected?: boolean;
  /** Downwind bearing for the selected Code Red event; draws the indicative wedge. */
  windToDeg?: number | null;
}) {
  const selected = events.find((e) => e.id === selectedId) ?? null;
  // Draw non-selected first so the selected event sits on top.
  const ordered = [...events].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));

  return (
    <div className="relative overflow-hidden rounded border border-rule" style={{ height }}>
      {showPolygons && polygonSample && (
        <div className="absolute right-2 top-2 z-[500] flex items-center gap-1.5 bg-card/90 px-1.5 py-1 text-[10px] text-mute">
          <SampleBadge title="Facility / land-use polygons are sample data" /> polygons
        </div>
      )}
      <MapContainer center={[22.5, 80.5]} zoom={5} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={19} />
        {showPolygons && polygons && (
          <GeoJSON
            key={`${polygons.features.length}-${polygons.features[0]?.id ?? ""}`}
            data={polygons as unknown as FeatureCollection}
            style={(f) => {
              const tag = (f?.properties as PolygonFeature["properties"] | undefined)?.tag ?? "industrial";
              const c = TAG_COLORS[tag];
              return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.12, dashArray: tag === "industrial" ? undefined : "4 3" };
            }}
            onEachFeature={(f, layer) => layer.bindPopup(polygonPopup(f as unknown as PolygonFeature))}
          />
        )}
        {ordered.flatMap((e) => {
          const isSel = e.id === selectedId;
          const { radius, path } = markerStyle(e, isSel);
          return e.detections.map((d) => (
            <CircleMarker
              key={`${e.id}|${d.id}`}
              center={[d.lat, d.lon]}
              radius={radius}
              pathOptions={path}
              eventHandlers={{ click: () => onSelect(e.id) }}
            >
              <Popup>
                <b>{e.placeName}</b>
                <br />
                {CLASS_LABELS[e.classification.label]}
                {e.classification.tier ? ` · ${TIER_LABELS[e.classification.tier]}` : ""}
                <br />
                {d.sensor} · {fmtTime(d.acqTime)} · FRP {fmtNum(d.frpMW)} MW · conf {d.confidence}
                <br />
                <span style={{ fontFamily: "monospace", fontSize: 10 }}>{e.id}</span>
              </Popup>
            </CircleMarker>
          ));
        })}
        {selected && windToDeg !== null && selected.classification.tier === "code_red" && (
          <Polygon
            positions={wedgePoints(selected.lat, selected.lon, windToDeg)}
            pathOptions={{ color: "#b42318", weight: 1.5, dashArray: "5 4", fillColor: "#b42318", fillOpacity: 0.08 }}
          >
            <Tooltip sticky>Indicative downwind direction — not a dispersion model or an evacuation zone</Tooltip>
          </Polygon>
        )}
        {selected && flyToSelected && <FlyTo lat={selected.lat} lon={selected.lon} />}
      </MapContainer>
    </div>
  );
}

export function MapLegend({ showTags = true }: { showTags?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-rule bg-card p-2.5 text-[11px] text-ink">
      {Object.entries(CLASS_COLORS).map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className="dot rounded-full" style={{ background: v }} /> {CLASS_LABELS[k as keyof typeof CLASS_LABELS]}
        </span>
      ))}
      {showTags && (
        <span className="ml-auto inline-flex flex-wrap gap-2 text-faint">
          polygons:
          {Object.entries(TAG_COLORS).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="dot" style={{ background: v, opacity: 0.6 }} /> {k}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
