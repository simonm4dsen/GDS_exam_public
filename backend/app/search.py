"""Address geocoding via Denmark's DAWA/Datafordeler address-washer API, and an
adaptive nearest-neighbor apartment search for the webapp's Search page."""
from __future__ import annotations

import time
from typing import Optional

import geopandas as gpd
import numpy as np
import requests

USER_AGENT = "Mozilla/5.0 (compatible; didactic-engine-webapp/1.0)"


def search_address(address: str) -> Optional[dict]:
    url = f"https://api.dataforsyningen.dk/datavask/adgangsadresser?betegnelse={address}"
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        return r.json()
    except Exception:
        time.sleep(2)
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
            return r.json()
        except Exception:
            return None


def extract_coordinates(payload: dict) -> tuple[Optional[float], Optional[float]]:
    try:
        href = payload["resultater"][0]["adresse"]["href"]
    except Exception:
        return None, None
    try:
        r = requests.get(href, headers={"User-Agent": USER_AGENT}, timeout=10)
        coords = r.json()["adgangspunkt"]["koordinater"]
        return coords[0], coords[1]
    except Exception:
        return None, None


def json_best_match_name(payload: dict) -> str:
    address_dict = payload["resultater"][0]["adresse"]
    full_name = ""
    address_format = ["vejnavn", "husnr", "supplerendebynavn", ",", "postnr", "postnrnavn"]
    for x in address_format:
        if x == ",":
            full_name += ","
        elif address_dict.get(x) is not None:
            full_name += address_dict[x] + " "
    return full_name[:-1]


def geocode(address: str) -> dict:
    """Returns {matched_address, confidence, lat, lng} or all-None fields if not found."""
    payload = search_address(address)
    if payload is None or not payload.get("resultater"):
        return {"matched_address": None, "confidence": None, "lat": None, "lng": None}

    confidence = payload.get("kategori")
    matched_name = json_best_match_name(payload)
    lng, lat = extract_coordinates(payload)
    return {"matched_address": matched_name, "confidence": confidence, "lat": lat, "lng": lng}


def nearest_apartments(
    gdf: gpd.GeoDataFrame,
    lat: float,
    lng: float,
    min_addresses: int = 4,
    max_addresses: int = 40,
    max_apartments: int = 400,
    gap_factor: float = 3.0,
    min_gap_m: float = 40.0,
) -> gpd.GeoDataFrame:
    """Selects the searched address plus nearby addresses using an adaptive
    distance cutoff instead of a fixed radius.

    Buildings/entrances (grouped by rounded lat/lng, since a building's units all
    share the same geocoded point) are ranked by (haversine) distance from the
    search point. We always keep at least `min_addresses` of the nearest ones,
    then keep expanding outward one building at a time as long as consecutive
    buildings are still "close together" - i.e. the gap to the next building is
    not much larger than the typical gap seen so far. This naturally adapts to
    local address density: in a dense city block it keeps going for many
    buildings, while in a sparse rural area it stops after just a couple of
    nearby buildings instead of reaching out an arbitrary fixed radius to find
    more. All apartment units (all floors, all sale years) at each selected
    building are included in the result.
    """
    valid = gdf.dropna(subset=["lat", "lng"]).copy()
    if valid.empty:
        return gdf.iloc[0:0].copy()

    # Group by rounded coordinates (~0.1m precision) - proxy for "building/entrance",
    # since individual apartment units within a building share the same geocoded point.
    valid["_loc_key"] = valid["lat"].round(6).astype(str) + "," + valid["lng"].round(6).astype(str)
    locations = valid.drop_duplicates(subset=["_loc_key"])[["_loc_key", "lat", "lng"]].reset_index(drop=True)

    # Vectorized haversine distance (meters) from the search point to every building.
    earth_radius_m = 6_371_000.0
    lat1, lng1 = np.radians(lat), np.radians(lng)
    lat2, lng2 = np.radians(locations["lat"].to_numpy()), np.radians(locations["lng"].to_numpy())
    dlat, dlng = lat2 - lat1, lng2 - lng1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlng / 2) ** 2
    locations["distance_m"] = 2 * earth_radius_m * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    locations = locations.sort_values("distance_m", kind="stable").reset_index(drop=True)

    distances = locations["distance_m"].to_numpy()
    n = min(len(distances), max_addresses)

    cutoff = min(min_addresses, n)
    for i in range(min_addresses, n):
        gap = distances[i] - distances[i - 1]
        running_avg_gap = distances[i - 1] / max(i, 1)
        if gap > max(min_gap_m, gap_factor * running_avg_gap):
            break
        cutoff = i + 1

    keep_order = list(locations["_loc_key"].iloc[:cutoff])
    selected_keys = set(keep_order)
    result = valid[valid["_loc_key"].isin(selected_keys)].drop(columns="_loc_key")

    if len(result) > max_apartments:
        # Keep apartments from the closest buildings first if the cap is hit.
        rank = {k: i for i, k in enumerate(keep_order)}
        result = (
            valid[valid["_loc_key"].isin(selected_keys)]
            .assign(_rank=lambda d: d["_loc_key"].map(rank))
            .sort_values("_rank")
            .head(max_apartments)
            .drop(columns=["_loc_key", "_rank"])
        )

    if len(result):
        min_p, max_p = result["adjusted_sqm_price"].min(), result["adjusted_sqm_price"].max()
        span = (max_p - min_p) or 1
        result["scaled_adjusted_sqm_price"] = (result["adjusted_sqm_price"] - min_p) / span

    return result
