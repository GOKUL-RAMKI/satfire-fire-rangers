# SATFIRE v3 — HTTP API

All types are defined in `shared/types.ts`. Every route except `/api/health` and `/api/auth/*`
requires a session cookie (`satfire_session`). If it's missing or has expired, the route returns
`401 {"error":"unauthorized"}`.

`dataset` is a query parameter (`live` or `sample`). It defaults to `live` when a FIRMS key is
configured, and to `sample` otherwise. Sample data is labelled `sample: true` everywhere, and the UI
must show a SAMPLE DATA badge for it.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version }` (no auth) |
| POST | `/api/auth/login` | `{ username, password }` | `{ user }` + sets HttpOnly cookie; `401` on bad credentials, `429` when rate-limited |
| POST | `/api/auth/logout` | — | `{ ok: true }` |
| GET | `/api/auth/me` | — | `{ user }` or `401` |
| GET | `/api/status` | `?dataset=` | `PipelineStatus` (modes, heartbeat, gate log, scheduler, LLM ceilings) |
| GET | `/api/events` | `?dataset=` | `SatEvent[]` (sorted by severity, then most recent) |
| GET | `/api/events/:id` | `?dataset=` | `SatEvent` or `404` |
| POST | `/api/events/:id/review` | `{ dataset, decision: "confirm"\|"reject", note }` | `{ event: SatEvent, alert: AlertRecord \| null }`. Writes the gold set; confirming an Alert gives Code Red and a SITREP, then dispatch |
| POST | `/api/events/:id/sitrep` | `{ dataset }` | `{ text, phrasing: "template"\|"llm", note }`. The LLM only rephrases; on failure or timeout the raw template is returned |
| GET | `/api/alerts` | `?dataset=` (optional) | `AlertRecord[]` (DB-first records, with dispatch status) |
| GET | `/api/facilities` | `?dataset=` | `Facility[]` |
| GET | `/api/polygons` | `?dataset=` + `&bbox=w,s,e,n` (**required for live**) | GeoJSON `PolygonCollection` + `truncated` flag, capped at 2000 features per viewport. Live without bbox → `413`. |
| GET | `/api/cpcb` | — | CPCB category descriptions |
| GET | `/api/backtest` | — | `BacktestReport` or `404` if none has been generated |
| POST | `/api/pipeline/refresh` | `{ dataset }` | `PipelineStatus` after a manual run |
| GET | `/api/osm/context` | `?lat=&lon=` | Overpass lookup for the evidence panel only. Refresh path, not used for classification |
