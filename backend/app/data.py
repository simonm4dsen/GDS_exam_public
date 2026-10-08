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


def _mark_price_outliers(gdf: gpd.GeoDataFrame, min_group_size: int = 10) -> gpd.GeoDataFrame:
    """Flags (but does not drop) rows whose adjusted_sqm_price is an outlier.

    Uses the classic 1.5*IQR fence, computed per postal code so local price
    levels (which vary a lot across the city) aren't compared directly to one
    another. Postal groups with too few sales for a reliable IQR fall back to
    the dataset-wide fence. This is a "soft" removal: an `is_outlier` column
    is added and normal endpoints filter it out by default, but the rows stay
    in the underlying data/file for later inspection or re-inclusion.
    """
    prices = gdf["adjusted_sqm_price"]
    global_q1, global_q3 = prices.quantile([0.25, 0.75])
    global_iqr = global_q3 - global_q1
    global_lo = global_q1 - 1.5 * global_iqr
    global_hi = global_q3 + 1.5 * global_iqr

    def _bounds(group: "gpd.pd.Series") -> tuple[float, float]:
        if len(group) < min_group_size:
            return global_lo, global_hi
        q1, q3 = group.quantile([0.25, 0.75])
        iqr = q3 - q1
        if iqr <= 0:
            return global_lo, global_hi
        return q1 - 1.5 * iqr, q3 + 1.5 * iqr

    if "postal" in gdf.columns:
        bounds_by_postal = prices.groupby(gdf["postal"]).apply(_bounds)
        lo = gdf["postal"].map(lambda p: bounds_by_postal.get(p, (global_lo, global_hi))[0])
        hi = gdf["postal"].map(lambda p: bounds_by_postal.get(p, (global_lo, global_hi))[1])
    else:
        lo, hi = global_lo, global_hi

    gdf["is_outlier"] = (prices < lo) | (prices > hi)
    return gdf


# Reference year used to normalize historical prices to a common price level,
# analogous to a housing price index (P_t_normalized = P_t * index[BASE_YEAR] / index[year_of_sale]).
# Anchored to the most recent year with data (2026) so displayed prices reflect
# current price levels.
BASE_YEAR = 2026


def _compute_year_price_index(gdf: gpd.GeoDataFrame) -> "gpd.pd.Series":
    """Per-year median adjusted_sqm_price over non-outlier sales - the price
    level used as the denominator/numerator when normalizing sale prices to
    a common (BASE_YEAR) price level."""
    clean = gdf.loc[~gdf["is_outlier"]]
    return clean.groupby("year")["adjusted_sqm_price"].median()


def _add_normalized_price(gdf: gpd.GeoDataFrame, year_index: "gpd.pd.Series") -> gpd.GeoDataFrame:
    if year_index.empty:
        gdf["normalized_sqm_price"] = gdf["adjusted_sqm_price"]
        return gdf

    if BASE_YEAR in year_index.index:
        base_value = year_index.loc[BASE_YEAR]
    else:
        # Fall back to whichever indexed year is closest to BASE_YEAR if there's
        # no (non-outlier) data for BASE_YEAR itself.
        nearest_year = min(year_index.index, key=lambda y: abs(y - BASE_YEAR))
        base_value = year_index.loc[nearest_year]

    year_index_map = year_index.to_dict()
    ratio = gdf["year"].map(lambda y: base_value / year_index_map.get(y, base_value))
    gdf["normalized_sqm_price"] = gdf["adjusted_sqm_price"] * ratio
    return gdf


@functools.lru_cache(maxsize=1)
def _load_apartments() -> gpd.GeoDataFrame:
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

    gdf = _mark_price_outliers(gdf)

    year_index = _compute_year_price_index(gdf)
    gdf = _add_normalized_price(gdf, year_index)

    gdf["tooltip_price"] = gdf["normalized_sqm_price"].astype(int).map("{:,.0f}".format)
    gdf["tooltip_address"] = gdf["address"].fillna("").apply(lambda a: a.strip().split(",")[0])

    # Colour scale (and the map layers built from it) are driven by the
    # normalized price so sale prices are visually comparable across years;
    # it's fit on non-outlier prices so a handful of extreme sales don't wash
    # out the colour range for everything else. Outlier rows still get a
    # (clamped) colour value in case they're ever rendered.
    clean_prices = gdf.loc[~gdf["is_outlier"], "normalized_sqm_price"]
    min_p, max_p = clean_prices.min(), clean_prices.max()
    scaled = (gdf["normalized_sqm_price"] - min_p) / (max_p - min_p)
    gdf["scaled_adjusted_sqm_price"] = scaled.clip(0, 1)
    gdf["color_int"] = gdf["scaled_adjusted_sqm_price"].apply(lambda x: custom_round(x, base=5))

    return gdf


def get_apartments(include_outliers: bool = False) -> gpd.GeoDataFrame:
    """Returns the apartment sales dataset.

    Outliers on adjusted_sqm_price are "soft removed": they stay in the
    underlying data (flagged via `is_outlier`) but are excluded here by
    default so they don't skew search results/statistics. Pass
    `include_outliers=True` to get the full, unfiltered dataset (e.g. for
    debugging or a future "show outliers" toggle).
    """
    gdf = _load_apartments()
    if include_outliers:
        return gdf
    return gdf[~gdf["is_outlier"]]


@functools.lru_cache(maxsize=1)
def get_map_points() -> dict:
    """Builds a compact, address-level map payload once per data-cache lifetime."""
    gdf = get_apartments()
    clean_prices = gdf["normalized_sqm_price"].sort_values().to_numpy()
    price_min = float(clean_prices[0])
    price_max = float(clean_prices[-1])
    pad = (price_max - price_min or 1) * 0.08

    map_sales = gdf[["lat", "lng", "year", "tooltip_address", "normalized_sqm_price"]].sort_values(
        "year", ascending=False
    )
    grouped = map_sales.groupby(["lat", "lng"], sort=False).agg(
        address=("tooltip_address", "first"),
        average_price=("normalized_sqm_price", "mean"),
        years=("year", list),
        prices=("normalized_sqm_price", list),
    )

    points = []
    for row in grouped.itertuples():
        lat, lng = row.Index
        points.append(
            {
                "lat": float(lat),
                "lng": float(lng),
                "address": str(row.address),
                "averageNormalizedPrice": float(row.average_price),
                "sales": [
                    {"year": int(year), "normalizedSqmPrice": float(price)}
                    for year, price in zip(row.years, row.prices)
                ],
            }
        )

    return {
        "count": len(points),
        "sale_count": len(gdf),
        "price_scale": {
            "min": price_min,
            "max": price_max,
            "p33": float(np.quantile(clean_prices, 1 / 3)),
            "p67": float(np.quantile(clean_prices, 2 / 3)),
            "domain_min": price_min - pad,
            "domain_max": price_max + pad,
        },
        "points": points,
    }


@functools.lru_cache(maxsize=1)
def get_postnumre() -> gpd.GeoDataFrame:
    return gpd.read_file(POSTNUMRE_FILE)


@functools.lru_cache(maxsize=1)
def get_sogne() -> gpd.GeoDataFrame:
    return gpd.read_file(SOGNE_FILE)


def reload_data() -> None:
    """Clears caches - call after re-running the scraper/merge to pick up new data."""
    _load_apartments.cache_clear()
    get_map_points.cache_clear()
    get_postnumre.cache_clear()
    get_sogne.cache_clear()
