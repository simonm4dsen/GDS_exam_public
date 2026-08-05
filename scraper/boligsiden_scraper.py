#!/usr/bin/env python
# coding: utf-8
"""
Boligsiden.dk scraper for historical / ongoing condo ("ejerlejlighed") sales in and
around Copenhagen.

Data source
-----------
Boligsiden exposes a public, unauthenticated JSON API at ``api.boligsiden.dk`` that
backs their own website. The relevant endpoint for this scraper is::

    GET https://api.boligsiden.dk/search/cases

Confirmed (empirically, since this API isn't formally documented) working query
parameters:

- ``zipCodes``       repeated per postal code, e.g. ``zipCodes=2100&zipCodes=1050``.
                      Comma-separated lists are NOT accepted (treated as one bad
                      literal value and silently match nothing) - always repeat the key.
- ``addressTypes``   enum, must be one of the API's known values. ``condo`` is the
                      value for ejerlejlighed (villa/house types use other values).
                      Passing a wrong enum value (e.g. ``ejerlejlighed``) yields a
                      400 error, which is how this was confirmed.
- ``page`` / ``per_page``  standard pagination. per_page up to (at least) 500 works.

Unknown parameter *names* are silently ignored (the API just returns its default,
unfiltered result set) rather than erroring - so care must be taken to verify a
parameter is actually being applied (as done above) rather than assuming silence
means success.

Each "case" in the response corresponds to a single address (an apartment unit) and
carries a ``registrations`` array with the *entire* historical sale record for that
address (date, amount, area, perAreaPrice, ...), not just the most recent/current
listing. That means a single pass over all target postal codes is enough to recover
full sales history for backfilling, and re-running later naturally surfaces any new
registrations that have appeared since (see the incremental "update" mode below).

Output schema (kept intentionally narrower than the legacy final_geodataframe_v2.geojson)
-------------------------------------------------------------------------------------
Per user decision, enrichment columns from the old dataset that can no longer be
recomputed here (noise, energy distances, POI distances, sognekode/parish) are
dropped. Only core fields are written for scraped rows:

    address, address_url, city, kommune, postal, lat, lng,
    square_meters, square_meters_price, latest_sale_price, latest_sale_date, year,
    energy, case_id, address_id, registration_id, source

Usage
-----
    # Full historical backfill for all known postal codes:
    python -m scraper.boligsiden_scraper backfill --out data/boligsiden_scraped.geojson

    # Later, periodic incremental update (only fetches registrations newer than the
    # watermark recorded by the previous run):
    python -m scraper.boligsiden_scraper update --out data/boligsiden_scraped.geojson
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, Iterator

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("boligsiden_scraper")

API_BASE = "https://api.boligsiden.dk"
CASES_ENDPOINT = f"{API_BASE}/search/cases"
ADDRESS_TYPE_CONDO = "condo"
PER_PAGE = 500
USER_AGENT = "Mozilla/5.0 (compatible; didactic-engine-research-scraper/1.0; +https://github.com/)"
REQUEST_TIMEOUT = 20
MAX_RETRIES = 3
SLEEP_BETWEEN_REQUESTS = 0.5  # seconds - be polite to the API

DATA_DIR = Path(__file__).resolve().parent
POSTAL_CODES_FILE = DATA_DIR / "postal_codes.json"
DEFAULT_STATE_FILE = DATA_DIR / "scrape_state.json"
DEFAULT_OUT_FILE = DATA_DIR.parent / "data" / "boligsiden_scraped.geojson"


def load_postal_codes(path: Path = POSTAL_CODES_FILE) -> list[int]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@dataclass
class ScrapeState:
    """Per-postal-code watermark tracking the newest registration date already
    scraped, so subsequent 'update' runs only need to keep registrations newer
    than this date."""

    last_registration_date_by_zip: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "ScrapeState":
        if not path.exists():
            return cls()
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        return cls(last_registration_date_by_zip=payload.get("last_registration_date_by_zip", {}))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"last_registration_date_by_zip": self.last_registration_date_by_zip}, f, indent=2)

    def watermark_for(self, zip_code: int) -> date | None:
        raw = self.last_registration_date_by_zip.get(str(zip_code))
        return date.fromisoformat(raw) if raw else None

    def update_watermark(self, zip_code: int, seen_date: date) -> None:
        current = self.watermark_for(zip_code)
        if current is None or seen_date > current:
            self.last_registration_date_by_zip[str(zip_code)] = seen_date.isoformat()


def _get_with_retries(url: str, params: dict) -> dict:
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(
                url, params=params, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 - want to retry on anything transient
            last_exc = exc
            wait = 2 * attempt
            logger.warning("Request failed (attempt %d/%d): %s - sleeping %ds", attempt, MAX_RETRIES, exc, wait)
            time.sleep(wait)
    raise RuntimeError(f"Giving up on {url} params={params}") from last_exc


def fetch_cases_for_zip(zip_code: int) -> Iterator[dict]:
    """Yields every 'case' (address) for a given postal code, paginating as needed."""
    page = 1
    total_hits = None
    fetched = 0
    while total_hits is None or fetched < total_hits:
        params = {
            "zipCodes": zip_code,
            "addressTypes": ADDRESS_TYPE_CONDO,
            "per_page": PER_PAGE,
            "page": page,
        }
        payload = _get_with_retries(CASES_ENDPOINT, params)
        cases = payload.get("cases") or []
        total_hits = payload.get("totalHits", len(cases))

        if not cases:
            break

        for case in cases:
            yield case

        fetched += len(cases)
        page += 1
        time.sleep(SLEEP_BETWEEN_REQUESTS)

        if page > 500:  # safety valve against infinite loops
            logger.warning("Aborting pagination for zip %s after 500 pages", zip_code)
            break


def normalize_case(case: dict, min_registration_date: date | None) -> list[dict]:
    """Flattens a single 'case' (address) into one row per qualifying sale
    registration, keeping only the core schema fields.

    NB: most of what one would expect at the top level of a 'case' (coordinates,
    registrations, road, zip, municipality) is actually nested under case['address']
    - the top-level case object mostly carries listing/realtor metadata plus a
    duplicate 'coordinates'. We read from case['address'] since that's where the
    full registrations history lives.
    """
    address = case.get("address") or {}
    zip_info = address.get("zip", {})
    municipality = address.get("municipality", {})
    road = address.get("road", {})

    coords = address.get("coordinates") or case.get("coordinates") or {}
    lat = coords.get("lat")
    lng = coords.get("lon")

    house_number = address.get("houseNumber", "")
    floor = address.get("floor")
    door = address.get("door")
    road_name = road.get("name", "")
    zip_code = address.get("zipCode") or zip_info.get("zipCode")
    zip_name = zip_info.get("name") or address.get("cityName")

    full_address = f"{road_name} {house_number}".strip()
    unit_suffix = ", ".join(x for x in [f"{floor}." if floor else None, door] if x)
    if unit_suffix:
        full_address = f"{full_address}, {unit_suffix}"

    energy_label = case.get("energyLabel")
    if isinstance(energy_label, str):
        energy_label = energy_label.upper()

    rows: list[dict] = []
    for reg in address.get("registrations", []):
        reg_date_raw = reg.get("date")
        if not reg_date_raw:
            continue
        try:
            reg_date = date.fromisoformat(reg_date_raw[:10])
        except ValueError:
            continue

        if min_registration_date and reg_date <= min_registration_date:
            continue  # already scraped in a previous run

        area = reg.get("area") or reg.get("livingArea")
        amount = reg.get("amount")
        per_area_price = reg.get("perAreaPrice")
        if per_area_price is None and amount and area:
            per_area_price = amount / area

        rows.append(
            {
                "address": full_address,
                "address_url": case.get("slugAddress") or case.get("slug"),
                "city": zip_name,
                "kommune": municipality.get("name"),
                "postal": zip_code,
                "lat": lat,
                "lng": lng,
                "square_meters": area,
                "square_meters_price": per_area_price,
                "latest_sale_price": amount,
                "latest_sale_date": reg_date.isoformat(),
                "year": reg_date.year,
                "energy": energy_label,
                "case_id": case.get("caseID"),
                "address_id": address.get("addressID"),
                "registration_id": reg.get("registrationID"),
                "source": "boligsiden",
            }
        )
    return rows


def scrape(postal_codes: Iterable[int], state: ScrapeState) -> list[dict]:
    all_rows: list[dict] = []
    for zip_code in postal_codes:
        watermark = state.watermark_for(zip_code)
        logger.info("Scraping zip %s (watermark=%s)", zip_code, watermark)
        zip_rows = 0
        newest_seen: date | None = None
        try:
            for case in fetch_cases_for_zip(zip_code):
                rows = normalize_case(case, watermark)
                for row in rows:
                    d = date.fromisoformat(row["latest_sale_date"])
                    if newest_seen is None or d > newest_seen:
                        newest_seen = d
                all_rows.extend(rows)
                zip_rows += len(rows)
        except RuntimeError as exc:
            logger.error("Skipping zip %s after repeated failures: %s", zip_code, exc)
            continue

        if newest_seen:
            state.update_watermark(zip_code, newest_seen)
        logger.info("Zip %s -> %d new sale rows", zip_code, zip_rows)

    return all_rows


def rows_to_geojson(rows: list[dict]) -> dict:
    features = []
    for i, row in enumerate(rows):
        lat, lng = row.get("lat"), row.get("lng")
        if lat is None or lng is None:
            continue
        properties = dict(row)  # keep lat/lng in properties too, matching legacy schema
        features.append(
            {
                "id": str(i),
                "type": "Feature",
                "properties": properties,
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def merge_into_existing(new_rows: list[dict], out_path: Path) -> list[dict]:
    """Appends new_rows to whatever rows already exist in out_path (if any),
    de-duplicating on registration_id."""
    existing_rows: list[dict] = []
    if out_path.exists():
        with open(out_path, encoding="utf-8") as f:
            existing = json.load(f)
        existing_rows = [feat["properties"] | {
            "lat": feat["geometry"]["coordinates"][1],
            "lng": feat["geometry"]["coordinates"][0],
        } for feat in existing.get("features", [])]

    seen_ids = {r.get("registration_id") for r in existing_rows if r.get("registration_id")}
    combined = list(existing_rows)
    for row in new_rows:
        rid = row.get("registration_id")
        if rid and rid in seen_ids:
            continue
        combined.append(row)
        if rid:
            seen_ids.add(rid)
    return combined


def run(mode: str, out_path: Path, state_path: Path, postal_codes: list[int] | None) -> None:
    codes = postal_codes or load_postal_codes()
    state = ScrapeState.load(state_path) if mode == "update" else ScrapeState()

    logger.info("Running in '%s' mode for %d postal codes", mode, len(codes))
    new_rows = scrape(codes, state)
    logger.info("Fetched %d new sale rows total", len(new_rows))

    combined_rows = merge_into_existing(new_rows, out_path) if mode == "update" else new_rows
    geojson = rows_to_geojson(combined_rows)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    logger.info("Wrote %d total features to %s", len(geojson["features"]), out_path)

    state.save(state_path)
    logger.info("Saved scrape state to %s", state_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        choices=["backfill", "update"],
        help="'backfill' does a full historical scrape (ignores/overwrites state); "
        "'update' only fetches registrations newer than the saved watermark and "
        "appends them to the existing output file.",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_FILE, help="Output GeoJSON path")
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE, help="Watermark state file path")
    parser.add_argument(
        "--postal-codes",
        type=int,
        nargs="*",
        default=None,
        help="Optional subset of postal codes to scrape (defaults to the full known list)",
    )
    args = parser.parse_args()
    run(args.mode, args.out, args.state_file, args.postal_codes)


if __name__ == "__main__":
    main()
