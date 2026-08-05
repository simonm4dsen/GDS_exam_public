"""Address geocoding via Denmark's DAWA/Datafordeler address-washer API, and
nearest-neighbor apartment search - ported from the original dawa_scrape_prod.py /
app.py Streamlit 'Search' page logic."""
from __future__ import annotations

import time
from typing import Optional

import geopandas as gpd
import requests
from shapely.geometry import Point

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
    min_addresses: int = 5,
    min_apartments: int = 50,
    max_iterations: int = 2000,
) -> gpd.GeoDataFrame:
    """Expands outward from (lat, lng) picking nearest not-yet-visited addresses
    until both the min_addresses and min_apartments thresholds are met - ported from
    the original Streamlit 'Search' page's expanding nearest-neighbor loop, with a
    hard iteration cap to guarantee termination."""
    search_gdf = gdf.copy()
    search_gdf["lnglat"] = search_gdf["lng"].astype(str) + "," + search_gdf["lat"].astype(str)

    points = [(lat, lng)]
    points_set = {(lat, lng)}
    collected_idx: list[int] = []
    count = 0
    iterations = 0

    while (count < min_apartments or len(points) <= min_addresses) and iterations < max_iterations:
        iterations += 1
        curr_point = points[len(points) - 1]

        if len(search_gdf) == 0:
            break

        neighborhood = search_gdf.sindex.nearest(Point(curr_point[1], curr_point[0]))
        indices = [int(i) for i in neighborhood[1]] if hasattr(neighborhood, "__len__") else [int(neighborhood)]

        for i in indices:
            count += 1
            row = search_gdf.iloc[i]
            lati, longi = float(row["lat"]), float(row["lng"])
            if (longi, lati) not in points_set:
                points.append((longi, lati))
                points_set.add((longi, lati))
            collected_idx.append(row.name)

        visited_lnglat = {",".join(map(str, tup)) for tup in points_set}
        search_gdf = search_gdf[~search_gdf["lnglat"].isin(visited_lnglat)]

    result = gdf.loc[gdf.index.isin(collected_idx)].copy()

    if len(result):
        min_p, max_p = result["adjusted_sqm_price"].min(), result["adjusted_sqm_price"].max()
        span = (max_p - min_p) or 1
        result["scaled_adjusted_sqm_price"] = (result["adjusted_sqm_price"] - min_p) / span

    return result
