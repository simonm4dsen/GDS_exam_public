# Copenhagen Ejerlejlighed Prices

Historical + ongoing sale-price data for condos ("ejerlejligheder") in Copenhagen and
the surrounding area, and a webapp to explore it.

## Project layout

- `scraper/` — reusable Boligsiden.dk scraper. Run `backfill` once to build a full
  historical dataset, then `update` periodically (e.g. via a monthly cron/scheduled
  task) to append newly-registered sales.
- `data/` — GeoJSON datasets:
  - `final_geodataframe_v2.geojson` — legacy, enriched dataset (up to mid-2022;
    includes noise/energy/POI-distance/parish enrichment columns that can no longer
    be recomputed).
  - `boligsiden_scraped.geojson` — output of the new scraper (core fields only).
  - `combined_geodataframe.geojson` — merged legacy + new dataset served by the backend
    (produced by `scraper/merge_datasets.py`).
- `backend/` — FastAPI app serving the combined dataset as GeoJSON plus an
  address-search endpoint (geocoding + nearest-neighbor apartment lookup).
- `frontend/` — React/Vite + MapLibre GL + deck.gl webapp (replaces the old Streamlit
  `app.py`), with Home (apartment/postal/parish map views) and Search pages.
- `analysis.ipynb`, `dawa_scrape_prod.py` — legacy exploratory notebook / DAWA
  geocoding helper kept for reference; the geocoding logic now also lives in
  `backend/app/search.py`.

## Running the scraper

```bash
# Full historical backfill (safe to re-run - overwrites data/boligsiden_scraped.geojson):
python -m scraper.boligsiden_scraper backfill --out data/boligsiden_scraped.geojson

# Periodic incremental update (only fetches sales newer than the last run's watermark):
python -m scraper.boligsiden_scraper update --out data/boligsiden_scraped.geojson

# Merge legacy + scraped data into the file the backend serves:
python -m scraper.merge_datasets
```

## Running the backend

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8811
```

After re-running the scraper/merge scripts, either restart the backend or call
`POST /api/reload-data` to pick up the new data without a restart.

## Running the frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend expects the backend at `http://127.0.0.1:8811` by default; override with
a `VITE_API_BASE` env var if needed.
