-- SATFIRE v3 PostGIS schema. Based on v3_execution_checklist.md §5:
--   * GiST indexes are on the SAME type the queries use (geom::geography)
--   * inserts are idempotent on (sensor, acq_time, lat, lon)
--   * nearest facility wins; runner-ups are kept; no rows = unmapped
-- Additions: dataset column (live / sample), provenance and attribution versioning,
-- events-derived alerts (DB-first dispatch), operator reviews (gold set), ingest log.
-- Idempotent: safe to run repeatedly (npm run db:init).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('attribution_version', '1') ON CONFLICT (key) DO NOTHING;

-- Bulk-loaded land-use / facility polygons (OSM or sample). Overpass only refreshes this table.
CREATE TABLE IF NOT EXISTS osm_landuse (
  id                  SERIAL PRIMARY KEY,
  poly_id             TEXT NOT NULL,
  dataset             TEXT NOT NULL DEFAULT 'live',
  tag                 TEXT NOT NULL,                 -- industrial | quarry | forest | farmland
  facility_id         TEXT,
  facility_name       TEXT,
  cpcb_category       TEXT,
  source              TEXT NOT NULL,                 -- provenance
  refreshed_at        TIMESTAMPTZ NOT NULL,          -- last refresh of this record
  mapped_since        TIMESTAMPTZ,                   -- newly mapped sites are cold-start
  osm_tags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_version INTEGER NOT NULL DEFAULT 1,
  geom                GEOMETRY(MultiPolygon, 4326) NOT NULL,
  UNIQUE (dataset, poly_id)
);
CREATE INDEX IF NOT EXISTS idx_landuse_geog ON osm_landuse USING GIST ((geom::geography));
CREATE INDEX IF NOT EXISTS idx_landuse_dataset ON osm_landuse (dataset);

CREATE TABLE IF NOT EXISTS firms_detections (
  id           SERIAL PRIMARY KEY,
  det_key      TEXT NOT NULL UNIQUE,                 -- sensor|acq_time|lat|lon (application key)
  dataset      TEXT NOT NULL DEFAULT 'live',
  sensor       TEXT NOT NULL,
  acq_time     TIMESTAMPTZ NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lon          DOUBLE PRECISION NOT NULL,
  frp_mw       NUMERIC,
  confidence   TEXT,
  daynight     TEXT,
  scan_km      NUMERIC,
  track_km     NUMERIC,
  gate_status  TEXT NOT NULL DEFAULT 'ok',
  tf_range_c   NUMRANGE,
  p_range_pct  NUMRANGE,
  status       TEXT DEFAULT 'ok',                    -- Dozier status
  dozier       JSONB,
   buffer_m     DOUBLE PRECISION NOT NULL DEFAULT 150,
  site_key     TEXT,                                 -- set after event assembly; feeds site history
  geom         GEOMETRY(Point, 4326) NOT NULL,
  UNIQUE (sensor, acq_time, lat, lon)                -- idempotency key
);
CREATE INDEX IF NOT EXISTS idx_det_geog ON firms_detections USING GIST ((geom::geography));
CREATE INDEX IF NOT EXISTS idx_det_site ON firms_detections (dataset, site_key);

-- Every attribution is versioned: when polygons change, detections are re-attributed.
CREATE TABLE IF NOT EXISTS detection_attribution (
  det_key             TEXT NOT NULL,
  poly_id             TEXT NOT NULL,
  rank                INTEGER NOT NULL,
  distance_m          DOUBLE PRECISION NOT NULL,
  attribution_version INTEGER NOT NULL,
  attributed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (det_key, attribution_version, rank)
);

-- Alerts are written here FIRST; webhook dispatch happens after and is retried with backoff.
CREATE TABLE IF NOT EXISTS alerts (
  id               TEXT PRIMARY KEY,
  dataset          TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,                    -- watch | alert | code_red | wildfire_route
  created_at       TIMESTAMPTZ NOT NULL,
  record           JSONB NOT NULL,                   -- full AlertRecord
  dispatch_status  TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  UNIQUE (dataset, event_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_alerts_pending ON alerts (dispatch_status, next_attempt_at);

-- Operator confirm / reject: the gold-labelled set for Phase 8.
CREATE TABLE IF NOT EXISTS reviews (
  dataset   TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  decision  TEXT NOT NULL CHECK (decision IN ('confirm', 'reject')),
  label     TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  by_user   TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (dataset, event_id)
);

-- Quality-gate rejections with their logged reason.
CREATE TABLE IF NOT EXISTS ingest_log (
  id        SERIAL PRIMARY KEY,
  dataset   TEXT NOT NULL,
  run_at    TIMESTAMPTZ NOT NULL,
  row_index INTEGER NOT NULL,
  reason    TEXT NOT NULL,
  detail    TEXT NOT NULL,
  source    TEXT
);
