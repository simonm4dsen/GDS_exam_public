#!/usr/bin/env python
# coding: utf-8
"""
Merges the legacy scraped dataset (data/final_geodataframe_v2.geojson, enriched,
up to mid-2022) with the newly scraped Boligsiden dataset
(data/boligsiden_scraped.geojson, core fields only, going forward) into a single
combined GeoJSON that the webapp backend serves.

Legacy rows keep all their original (enriched) columns. New rows simply leave those
enrichment columns absent/null - the backend/frontend must tolerate the mixed schema.

Usage:
    python -m scraper.merge_datasets \
        --legacy data/final_geodataframe_v2.geojson \
        --new data/boligsiden_scraped.geojson \
        --out data/combined_geodataframe.geojson
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_LEGACY = Path("data/final_geodataframe_v2.geojson")
DEFAULT_NEW = Path("data/boligsiden_scraped.geojson")
DEFAULT_OUT = Path("data/combined_geodataframe.geojson")


def load_features(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("features", [])


def merge(legacy_path: Path, new_path: Path, out_path: Path) -> None:
    legacy_features = load_features(legacy_path)
    new_features = load_features(new_path)

    # Tag provenance so the frontend can distinguish enriched legacy rows from
    # core-only new rows. Legacy rows predate Boligsiden's sale-type
    # classification; treat them as ordinary market sales ("normal") since the
    # original dataset was already curated for market-price analysis.
    for feat in legacy_features:
        feat["properties"].setdefault("source", "legacy")
        feat["properties"].setdefault("sale_type", "normal")

    combined_features = []
    for i, feat in enumerate(legacy_features + new_features):
        feat["id"] = str(i)
        feat["properties"]["idx"] = i
        combined_features.append(feat)

    combined = {"type": "FeatureCollection", "features": combined_features}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(combined, f, ensure_ascii=False)

    print(
        f"Merged {len(legacy_features)} legacy + {len(new_features)} new = "
        f"{len(combined_features)} total features -> {out_path}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy", type=Path, default=DEFAULT_LEGACY)
    parser.add_argument("--new", type=Path, default=DEFAULT_NEW)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    merge(args.legacy, args.new, args.out)


if __name__ == "__main__":
    main()
