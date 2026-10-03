# Smart India Hackathon (SIH) 2026 - Problem Statement Blueprint
## Problem Statement ID: SIH26162
### AI-Based Detection and Classification of Industrial Fires and Persistent Thermal Sources

---

## 📌 1. Official Problem Metatags
* **Problem Statement ID:** [SIH26162](https://www.sihbuddy.in/ps/SIH26162)
* **Problem Statement Title:** AI-Based Detection and Classification of Industrial Fires and Persistent Thermal Sources Using NASA FIRMS, OSM & Satellite Data
* **Theme:** Disaster Management
* **Category:** Software
* **Complexity Level:** Hard
* **Sponsoring Organization:** National Technical Research Organisation (NTRO)
* **Cash Prize:** ₹1,00,000

---

## 🔍 2. Detailed Problem Description
Industrial manufacturing sites, oil refineries, and chemical production facilities frequently generate heavy thermal signatures due to routine operations (e.g., gas flaring, high-temperature kiln operations, blast furnaces). Global space-based tracking sensors, such as NASA's Fire Information for Resource Management System (FIRMS), reliably detect these raw anomalies. 

However, spaceborne arrays struggle to differentiate between regular industrial heat signatures and true, unplanned structural emergencies (e.g., equipment failures, chemical explosions, structural factory fires). This limitation produces excessive informational noise for national security and safety analysts. 

The **National Technical Research Organisation (NTRO)** requires an automated, intelligent geospatial framework capable of cleansing non-emergency telemetry and isolating sudden, uncontrolled industrial hazard events in near-real-time.

---

## ⚙️ 3. Input Data Streams & Integrations
To architect a robust, production-ready minimum viable product (MVP), your solution must pull data from the following domains:

1. **NASA FIRMS Telemetry:** Real-time ingestion of active thermal coordinates via MODIS (1km resolution) and VIIRS (375m resolution). Crucial metrics include Fire Radiative Power (FRP), brightness temperatures (`Bright_ti4`, `Bright_ti5`), acquisition times, and spatial confidence intervals.
2. **OpenStreetMap (OSM) Vectors:** Extracted GIS shapefiles mapping precise geographical borders for heavy industrial regions, oil grids, manufacturing parks, and warehouses.
3. **Multi-Spectral Satellite Imagery:** Dynamic programmatic extraction of optical, Near-Infrared (NIR), and Short-Wave Infrared (SWIR) bands from arrays like Sentinel-2 or Landsat to run structural change detection and analyze smoke plumes.
4. **Historical Baselines:** Archival thermal records to train models on seasonal agricultural burning, standard regional flare behaviors, and localized environmental heat.

---

## 🚀 4. Functional Capabilities & Deliverables
Your team's software prototype must execute four core computational tasks:

* **Contextual Spatial Mapping:** Automated geometric mapping that correlates raw thermal vectors against known industrial infrastructure polygons using database queries.
* **Smart Noise Reduction Pipeline:** Algorithmic filtering to disregard consistent, safe industrial heat signatures (e.g., persistent refinery flaring) and agricultural crop fires.
* **Risk Prioritization Engine:** An AI engine that measures anomaly escalation (e.g., rapidly spiking FRP or expanding spatial footprints) to output prioritized danger scores.
* **Low-Latency Operations Dashboard:** A responsive, interactive GIS mapping dashboard displaying rapid event timelines, spatial heat arrays, and multi-channel telemetry streams for response teams.

---

## 🏗️ 5. Recommended Architecture & Tech Stack
To successfully navigate the 36-hour hackathon environment, utilize this integrated, scalable framework:

| Architecture Layer | Technology Options | Core Utility |
| :--- | :--- | :--- |
| **Frontend/GIS User Interface** | React.js / Vue.js + Mapbox GL JS / Leaflet | Vector mapping, custom tile rendering, realtime websocket alerts. |
| **Geospatial Backend** | Python (FastAPI / Django) + GeoPandas | Spatial geometry, coordinate transformations, buffer parsing. |
| **Database & Vector Indexing** | PostgreSQL + PostGIS Extension | R-Tree spatial indexing for fast `ST_Contains` and `ST_DWithin` queries. |
| **AI / Core Compute Models** | Scikit-Learn (Random Forests) + PyTorch / TensorFlow | Tabular temporal classification + CNNs for multi-band imagery parsing. |
| **Data Pipelines & Ingestion** | Celery + Redis | Asynchronous scheduling of NASA FIRMS API endpoints and imagery fetchers. |

---

## 📈 6. Core Database Strategy (PostGIS Snippet)
A fundamental requirement is filtering incoming coordinates against industrial zones. Ensure your database executes spatial indexes efficiently using query structures similar to this:

```sql
-- Create an spatial index on OSM industrial structures for high-speed indexing
CREATE INDEX idx_osm_industrial_geom ON osm_industrial_zones USING GIST(geom);

-- Match FIRMS coordinate against industrial areas within a 50-meter safety buffer
SELECT 
    firms.id AS alert_id,
    firms.frp,
    osm.name AS facility_name,
    ST_Distance(firms.geom, osm.geom) AS distance_meters
FROM 
    incoming_firms_alerts firms,
    osm_industrial_zones osm
WHERE 
    ST_DWithin(firms.geom, osm.geom, 50);
```

---

## 🗓️ 7. 36-Hour Hackathon Execution Roadmap

### ⏳ Hours 00 - 08: Pipeline & Ingestion Setup
* **Backend Devs:** Write Python scripts to pull live/historical data feeds from the NASA FIRMS API. Set up PostgreSQL with the PostGIS extension.
* **Frontend Devs:** Spin up the base dashboard frame, configure the Mapbox/Leaflet container, and test rendering mock coordinate pins on the map.
* **ML Devs:** Clean historical dataset inputs and prepare baseline profiles for known, non-threatening industrial heat sources.

### ⏳ Hours 08 - 20: Core Model Development
* **Backend Devs:** Build API routes linking the database query layer to the frontend. Implement spatial buffer calculation logic.
* **Frontend Devs:** Build UI overlays for facility telemetry sheets, historical timeline charts, and emergency priority color codes.
* **ML Devs:** Train the tabular classifier on FIRMS telemetry (FRP spikes, timing anomalies) and hook up image processing modules to evaluate Sentinel-2 SWIR bands for smoke/burn verification.

### ⏳ Hours 20 - 30: System Synthesis & Alert Pipeline
* **Full Team:** Connect backend calculations to the frontend visual layers.
* **Features:** Integrate automatic notification systems (e.g., Twilio API or Discord Webhooks) that trigger when the anomaly risk threshold passes critical values.
* **Refinement:** Fine-tune spatial algorithms to prevent localized crop fires near factory boundaries from triggering industrial fire alerts.

### ⏳ Hours 30 - 36: Polish, Test, and Pitch Simulation
* Run complete performance evaluations using simulated historical refinery disasters.
* Cache geospatial queries to maximize map load speeds.
* Record clean UI walkthroughs and lock down the judging deck.