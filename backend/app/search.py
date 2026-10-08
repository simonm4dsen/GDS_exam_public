"""Address geocoding and adaptive nearest-neighbor apartment search."""
from __future__ import annotations

from functools import lru_cache
import re
import threading
import time
import unicodedata
from typing import Optional

import geopandas as gpd
import numpy as np
import requests

USER_AGENT = "CopenhagenHousing/1.0 (local address search)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_GEOCODER_LOCK = threading.Lock()
_LAST_GEOCODER_REQUEST = 0.0


class GeocodingError(Exception):
    """Raised when the external address geocoder cannot be reached."""


def _normalize_address_part(value: str) -> str:
    value = value.casefold().translate(str.maketrans({"æ": "ae", "ø": "oe", "å": "aa"}))
    value = unicodedata.normalize("NFKD", value)
    value = "".join(character for character in value if not unicodedata.combining(character))
    return " ".join(re.findall(r"[a-z0-9]+", value))


def _parse_street_number(address: str) -> tuple[Optional[str], Optional[str]]:
    street_part = address.split(",", 1)[0].strip()
    street_part = re.sub(
        r"\s+(?:\d+\s*)?(?:st|tv|th|mf|kl|kld)\.?\s*$",
        "",
        street_part,
        flags=re.IGNORECASE,
    ).strip()

    trailing_number = re.fullmatch(r"(.+?)\s+(\d+[a-z]?)", street_part, flags=re.IGNORECASE)
    if trailing_number:
        return trailing_number.group(1).strip(), trailing_number.group(2).upper()

    leading_number = re.fullmatch(r"(\d+[a-z]?)\s+(.+)", street_part, flags=re.IGNORECASE)
    if leading_number:
        return leading_number.group(2).strip(), leading_number.group(1).upper()
    return None, None


def _local_address_match(address: str, reference_addresses: gpd.GeoDataFrame) -> Optional[dict]:
    street, number = _parse_street_number(address)
    if not street or not number or not {"address", "lat", "lng"}.issubset(reference_addresses.columns):
        return None

    target_street = _normalize_address_part(street)
    matches: dict[str, list[tuple[int, float, float]]] = {}
    for row in reference_addresses[["address", "lat", "lng"]].dropna().itertuples(index=False):
        row_street, row_number = _parse_street_number(str(row.address))
        if not row_street or not row_number or _normalize_address_part(row_street) != target_street:
            continue
        numeric = re.fullmatch(r"(\d+)([A-Z]?)", row_number)
        if not numeric:
            continue
        matches.setdefault(row_number, []).append((int(numeric.group(1)), float(row.lat), float(row.lng)))

    if not matches:
        return None

    if number in matches:
        points = matches[number]
        lat = sum(point[1] for point in points) / len(points)
        lng = sum(point[2] for point in points) / len(points)
        return {
            "matched_address": f"{street} {number}",
            "confidence": "matched to nearby sale address",
            "lat": lat,
            "lng": lng,
        }

    target_numeric = re.fullmatch(r"(\d+)([A-Z]?)", number)
    if not target_numeric:
        return None
    target_value = int(target_numeric.group(1))
    buildings = []
    for building_number, points in matches.items():
        numeric = re.fullmatch(r"(\d+)([A-Z]?)", building_number)
        if not numeric:
            continue
        point = (
            sum(item[1] for item in points) / len(points),
            sum(item[2] for item in points) / len(points),
        )
        buildings.append((int(numeric.group(1)), point[0], point[1]))
    buildings.sort()
    lower = next((building for building in reversed(buildings) if building[0] < target_value), None)
    upper = next((building for building in buildings if building[0] > target_value), None)
    if lower and upper:
        if target_value - lower[0] > 20 or upper[0] - target_value > 20:
            return None
        ratio = (target_value - lower[0]) / (upper[0] - lower[0])
        lat = lower[1] + (upper[1] - lower[1]) * ratio
        lng = lower[2] + (upper[2] - lower[2]) * ratio
    else:
        closest = min(buildings, key=lambda building: abs(building[0] - target_value))
        if abs(closest[0] - target_value) > 2:
            return None
        lat, lng = closest[1], closest[2]

    return {
        "matched_address": f"{street} {number} (estimated from nearby sale addresses)",
        "confidence": "estimated from nearby sale addresses",
        "lat": lat,
        "lng": lng,
    }


@lru_cache(maxsize=512)
def _geocode_cached(address: str) -> dict:
    global _LAST_GEOCODER_REQUEST

    street, number = _parse_street_number(address)
    query_variants = [address]
    if street and number:
        query_variants.extend([f"{street} {number}", street])
    queries = list(dict.fromkeys(query_variants))

    results = []
    road_fallback = None
    for query in queries:
        with _GEOCODER_LOCK:
            wait = 1.0 - (time.monotonic() - _LAST_GEOCODER_REQUEST)
            if wait > 0:
                time.sleep(wait)
            try:
                response = requests.get(
                    NOMINATIM_URL,
                    params={
                        "q": query,
                        "format": "jsonv2",
                        "addressdetails": 1,
                        "limit": 5,
                        "countrycodes": "dk",
                        "accept-language": "da",
                    },
                    headers={"User-Agent": USER_AGENT},
                    timeout=10,
                )
                response.raise_for_status()
                results = response.json()
            except (requests.RequestException, ValueError) as exc:
                raise GeocodingError("The address lookup service is unavailable.") from exc
            finally:
                _LAST_GEOCODER_REQUEST = time.monotonic()
        for result in results:
            details = result.get("address", {})
            result_street = details.get("road") or result.get("name")
            if street and result_street and _normalize_address_part(result_street) != _normalize_address_part(street):
                continue
            if number and details.get("house_number"):
                if details["house_number"].casefold() != number.casefold():
                    continue
                break
            if road_fallback is None and result_street:
                road_fallback = result
        else:
            continue
        break
    else:
        results = [road_fallback] if road_fallback else []

    if not results:
        return {"matched_address": None, "confidence": None, "lat": None, "lng": None}

    result = results[0]
    try:
        lat = float(result["lat"])
        lng = float(result["lon"])
    except (KeyError, TypeError, ValueError) as exc:
        raise GeocodingError("The address lookup service returned invalid coordinates.") from exc

    details = result.get("address", {})
    road = details.get("road")
    house_number = details.get("house_number")
    postcode = details.get("postcode")
    city = details.get("city") or details.get("town") or details.get("suburb")
    street_address = " ".join(part for part in (road, house_number) if part)
    locality = " ".join(part for part in (postcode, city) if part)
    matched_name = ", ".join(part for part in (street_address, locality) if part)

    has_house_number = bool(result.get("address", {}).get("house_number"))
    return {
        "matched_address": matched_name or result.get("display_name"),
        "confidence": result.get("type") if has_house_number or not number else "street-level fallback",
        "lat": lat,
        "lng": lng,
    }


def geocode(address: str, reference_addresses: Optional[gpd.GeoDataFrame] = None) -> dict:
    """Resolve a Danish address, using known local building points when useful."""
    address = address.strip()
    _, number = _parse_street_number(address)
    local_match = _local_address_match(address, reference_addresses) if reference_addresses is not None else None
    if local_match and local_match["confidence"] == "matched to nearby sale address":
        return local_match

    try:
        geocoded = _geocode_cached(address)
    except GeocodingError:
        if local_match:
            return local_match
        raise
    if number and geocoded["confidence"] == "street-level fallback" and not local_match:
        return {"matched_address": None, "confidence": None, "lat": None, "lng": None}
    if geocoded["lat"] is None and local_match:
        return local_match
    if local_match and geocoded["confidence"] == "street-level fallback":
        return local_match
    return geocoded


def nearest_apartments(
    gdf: gpd.GeoDataFrame,
    lat: float,
    lng: float,
    min_addresses: int = 4,
    max_addresses: int = 150,
    max_apartments: int = 1200,
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
        price_col = "normalized_sqm_price" if "normalized_sqm_price" in result.columns else "adjusted_sqm_price"
        min_p, max_p = result[price_col].min(), result[price_col].max()
        span = (max_p - min_p) or 1
        result["scaled_adjusted_sqm_price"] = (result[price_col] - min_p) / span

    return result
