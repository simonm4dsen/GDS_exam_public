"""FastAPI backend for the Copenhagen housing webapp.

Serves the combined (legacy + newly scraped) apartment sale dataset as GeoJSON,
aggregated postal-code / parish statistics, and an address-search endpoint
(geocoding + nearest-neighbor apartment lookup).
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import data, search

app = FastAPI(title="Copenhagen Housing API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _geojson_response(gdf) -> dict:
    return json.loads(gdf.to_json())


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/meta")
def meta() -> dict:
    gdf = data.get_apartments()
    years = sorted(int(y) for y in gdf["year"].unique())
    postals = sorted(int(p) for p in gdf["postal"].dropna().unique())
    return {"min_year": years[0], "max_year": years[-1], "years": years, "postals": postals}


@app.get("/api/apartments")
def apartments(
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
    postal: Optional[int] = Query(None),
    limit: Optional[int] = Query(None, le=50000),
) -> dict:
    gdf = data.get_apartments()
    if year_min is not None:
        gdf = gdf[gdf["year"] >= year_min]
    if year_max is not None:
        gdf = gdf[gdf["year"] <= year_max]
    if postal is not None:
        gdf = gdf[gdf["postal"] == postal]
    if limit:
        gdf = gdf.head(limit)
    return _geojson_response(gdf)


@app.get("/api/postal-stats")
def postal_stats(
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
) -> dict:
    gdf = data.get_apartments()
    if year_min is not None:
        gdf = gdf[gdf["year"] >= year_min]
    if year_max is not None:
        gdf = gdf[gdf["year"] <= year_max]

    grouped = gdf.groupby(["postal", "kommune"]).agg(
        adjusted_sqm_price_mean=("adjusted_sqm_price", "mean"),
        adjusted_sqm_price_median=("adjusted_sqm_price", "median"),
        n_sales=("adjusted_sqm_price", "count"),
    ).reset_index()
    grouped["postal"] = grouped["postal"].astype(str)

    post = data.get_postnumre().drop(columns=["id"], errors="ignore").copy()
    post["POSTNR_TXT"] = post["POSTNR_TXT"].astype(str)

    merged = post.merge(grouped, left_on="POSTNR_TXT", right_on="postal")
    return _geojson_response(merged)


@app.get("/api/parish-stats")
def parish_stats(
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
) -> dict:
    gdf = data.get_apartments()
    if "sognekode" not in gdf.columns:
        raise HTTPException(404, "sognekode not available in current dataset")
    if year_min is not None:
        gdf = gdf[gdf["year"] >= year_min]
    if year_max is not None:
        gdf = gdf[gdf["year"] <= year_max]

    grouped = gdf.dropna(subset=["sognekode"]).groupby(["sognekode"]).agg(
        adjusted_sqm_price_mean=("adjusted_sqm_price", "mean"),
        adjusted_sqm_price_median=("adjusted_sqm_price", "median"),
        n_sales=("adjusted_sqm_price", "count"),
    ).reset_index()
    grouped["SOGNEKODE"] = grouped["sognekode"].astype(str)

    sogne = data.get_sogne().copy()
    sogne["SOGNEKODE"] = sogne["SOGNEKODE"].astype(str)

    merged = sogne.merge(grouped, on="SOGNEKODE")
    return _geojson_response(merged)


@app.get("/api/search")
def search_address(
    address: str = Query(..., min_length=3),
    min_addresses: int = Query(5, ge=1, le=25),
    min_apartments: int = Query(50, ge=10, le=500),
) -> dict:
    geocoded = search.geocode(address)
    if geocoded["lat"] is None or geocoded["lng"] is None:
        raise HTTPException(404, f"Could not geocode address: {address}")

    gdf = data.get_apartments()
    nearby = search.nearest_apartments(
        gdf, geocoded["lat"], geocoded["lng"], min_addresses=min_addresses, min_apartments=min_apartments
    )

    return {
        "query": address,
        "matched_address": geocoded["matched_address"],
        "confidence": geocoded["confidence"],
        "lat": geocoded["lat"],
        "lng": geocoded["lng"],
        "count": len(nearby),
        "apartments": _geojson_response(nearby),
    }


@app.post("/api/reload-data")
def reload_data() -> dict:
    """Clears in-memory data caches - call after re-running the scraper/merge scripts
    so the API picks up newly written GeoJSON files without a full restart."""
    data.reload_data()
    return {"status": "reloaded"}
