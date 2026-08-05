"""Data loading & caching for the Copenhagen housing webapp backend."""
from __future__ import annotations

import functools
from pathlib import Path

import geopandas as gpd
import numpy as np

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

COMBINED_FILE = DATA_DIR / "combined_geodataframe.geojson"
LEGACY_FILE = DATA_DIR / "final_geodataframe_v2.geojson"
POSTNUMRE_FILE = DATA_DIR / "filtered_postnumre.geojson"
SOGNE_FILE = DATA_DIR / "sogne.geojson"


def _active_data_file() -> Path:
    return COMBINED_FILE if COMBINED_FILE.exists() else LEGACY_FILE


def custom_round(x: float, base: int = 5) -> int:
    return int(round(float(x * 100) / base))


@functools.lru_cache(maxsize=1)
def get_apartments() -> gpd.GeoDataFrame:
    gdf = gpd.read_file(_active_data_file())

    # required numeric columns may be missing/partial for new (core-only) rows
    gdf["adjusted_sqm_price"] = gdf.get("adjusted_sqm_price", gdf.get("square_meters_price"))
    gdf["adjusted_sqm_price"] = gdf["adjusted_sqm_price"].fillna(gdf.get("square_meters_price"))
    gdf = gdf.dropna(subset=["adjusted_sqm_price", "lat", "lng"])

    # Only "normal" (alm. frit salg) and "auction" registrations reflect
    # arm's-length market prices. "family" trades (familiehandel, i.e.
    # transfers between relatives, often below market value) and unclassified
    # "other" registrations are excluded so they don't skew price statistics.
    # Rows without a sale_type (legacy data predating this classification)
    # are kept, since the legacy dataset was already curated for market sales.
    MARKET_SALE_TYPES = {"normal", "auction"}
    if "sale_type" in gdf.columns:
        gdf = gdf[gdf["sale_type"].isna() | gdf["sale_type"].isin(MARKET_SALE_TYPES)]

    gdf["year"] = gdf["year"].astype(int)

    gdf["tooltip_price"] = gdf["adjusted_sqm_price"].astype(int).map("{:,.0f}".format)
    gdf["tooltip_address"] = gdf["address"].fillna("").apply(lambda a: a.strip().split(",")[0])

    min_p, max_p = gdf["adjusted_sqm_price"].min(), gdf["adjusted_sqm_price"].max()
    gdf["scaled_adjusted_sqm_price"] = (gdf["adjusted_sqm_price"] - min_p) / (max_p - min_p)
    gdf["color_int"] = gdf["scaled_adjusted_sqm_price"].apply(lambda x: custom_round(x, base=5))

    return gdf


@functools.lru_cache(maxsize=1)
def get_postnumre() -> gpd.GeoDataFrame:
    return gpd.read_file(POSTNUMRE_FILE)


@functools.lru_cache(maxsize=1)
def get_sogne() -> gpd.GeoDataFrame:
    return gpd.read_file(SOGNE_FILE)


def reload_data() -> None:
    """Clears caches - call after re-running the scraper/merge to pick up new data."""
    get_apartments.cache_clear()
    get_postnumre.cache_clear()
    get_sogne.cache_clear()
