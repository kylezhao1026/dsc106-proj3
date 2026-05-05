#!/usr/bin/env python3
"""
Build a compact MODIS NDVI dataset and exploratory visualization from NASA GIBS.

Question:
    Where and when does vegetation show signs of stress or high health based on
    NDVI patterns?

The script downloads MODIS Terra monthly NDVI imagery from NASA GIBS WMS,
decodes the GIBS colorized pixels back to approximate NDVI values using the
official GIBS colormap XML, and aggregates the results by region and month.

Outputs:
    data/modis_ndvi_region_month.csv
    data/modis_ndvi_region_month.json
    figures/modis_ndvi_stress_health_heatmap.png
    figures/modis_ndvi_stress_health_lines.png
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt
import numpy as np
import requests
from PIL import Image


WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
COLORMAP_URL = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_L3_NDVI.xml"
LAYER = "MODIS_Terra_L3_NDVI_Monthly"


@dataclass(frozen=True)
class Region:
    name: str
    bbox: tuple[float, float, float, float]  # lon_min, lat_min, lon_max, lat_max


DEFAULT_REGIONS = [
    Region("California Central Valley", (-122.8, 35.0, -118.2, 40.4)),
    Region("Pacific Northwest", (-125.0, 42.0, -116.0, 49.0)),
    Region("Great Plains", (-104.0, 33.0, -94.0, 49.0)),
    Region("Southeast US", (-92.0, 25.0, -75.0, 36.5)),
    Region("Amazon Basin", (-75.0, -15.0, -50.0, 5.0)),
]


def month_starts(start: str, end: str) -> list[date]:
    start_year, start_month = [int(part) for part in start.split("-")[:2]]
    end_year, end_month = [int(part) for part in end.split("-")[:2]]

    months: list[date] = []
    year, month = start_year, start_month
    while (year, month) <= (end_year, end_month):
        months.append(date(year, month, 1))
        month += 1
        if month == 13:
            month = 1
            year += 1
    return months


def parse_range_midpoint(value: str) -> float | None:
    match = re.match(r"\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)", value)
    if not match:
        return None
    low, high = float(match.group(1)), float(match.group(2))
    return (low + high) / 2


def load_colormap(session: requests.Session) -> tuple[np.ndarray, np.ndarray]:
    response = session.get(COLORMAP_URL, timeout=30)
    response.raise_for_status()

    root = ET.fromstring(response.content)
    colors: list[tuple[int, int, int]] = []
    values: list[float] = []

    for entry in root.findall(".//ColorMapEntry"):
        if entry.attrib.get("transparent") == "true" or entry.attrib.get("nodata") == "true":
            continue
        rgb = tuple(int(channel) for channel in entry.attrib["rgb"].split(","))
        midpoint = parse_range_midpoint(entry.attrib["value"])
        if midpoint is None:
            continue
        colors.append(rgb)
        values.append(midpoint)

    if not colors:
        raise RuntimeError("No usable NDVI colors found in the GIBS colormap.")

    return np.array(colors, dtype=np.int32), np.array(values, dtype=np.float32)


def download_ndvi_image(
    session: requests.Session,
    region: Region,
    month: date,
    width: int,
    height: int,
) -> Image.Image:
    lon_min, lat_min, lon_max, lat_max = region.bbox
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.1.1",
        "REQUEST": "GetMap",
        "LAYERS": LAYER,
        "STYLES": "",
        "FORMAT": "image/png",
        "TRANSPARENT": "true",
        "SRS": "EPSG:4326",
        "BBOX": f"{lon_min},{lat_min},{lon_max},{lat_max}",
        "WIDTH": str(width),
        "HEIGHT": str(height),
        "TIME": month.isoformat(),
    }
    response = session.get(WMS_URL, params=params, timeout=60)
    response.raise_for_status()

    content_type = response.headers.get("content-type", "")
    if "image" not in content_type:
        raise RuntimeError(
            f"GIBS returned {content_type or 'non-image response'} for "
            f"{region.name} {month.isoformat()}: {response.text[:200]}"
        )

    return Image.open(BytesIO(response.content)).convert("RGBA")


def decode_ndvi(
    image: Image.Image,
    color_table: np.ndarray,
    value_table: np.ndarray,
    sample_stride: int,
) -> np.ndarray:
    pixels = np.asarray(image, dtype=np.int32)[::sample_stride, ::sample_stride, :]
    valid = pixels[:, :, 3] > 0
    rgb = pixels[:, :, :3]

    # Find nearest GIBS colormap color for each visible pixel. The palette is
    # discrete, so this gives approximate NDVI bins rather than raw science data.
    flat_rgb = rgb[valid]
    if flat_rgb.size == 0:
        return np.array([], dtype=np.float32)

    distances = ((flat_rgb[:, None, :] - color_table[None, :, :]) ** 2).sum(axis=2)
    nearest = distances.argmin(axis=1)
    return value_table[nearest]


def summarize_ndvi(ndvi: np.ndarray, stress_threshold: float, high_threshold: float) -> dict[str, float]:
    if ndvi.size == 0:
        return {
            "mean_ndvi": math.nan,
            "median_ndvi": math.nan,
            "stress_share": math.nan,
            "high_health_share": math.nan,
            "valid_pixels": 0,
        }

    return {
        "mean_ndvi": float(np.mean(ndvi)),
        "median_ndvi": float(np.median(ndvi)),
        "stress_share": float(np.mean(ndvi < stress_threshold)),
        "high_health_share": float(np.mean(ndvi >= high_threshold)),
        "valid_pixels": int(ndvi.size),
    }


def write_csv(rows: list[dict[str, object]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "region",
        "date",
        "year",
        "month",
        "mean_ndvi",
        "median_ndvi",
        "stress_share",
        "high_health_share",
        "valid_pixels",
        "bbox",
    ]
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_json(rows: list[dict[str, object]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def plot_heatmap(rows: list[dict[str, object]], output_path: Path) -> None:
    regions = list(dict.fromkeys(row["region"] for row in rows))
    dates = list(dict.fromkeys(row["date"] for row in rows))
    matrix = np.full((len(regions), len(dates)), np.nan)

    index_region = {region: index for index, region in enumerate(regions)}
    index_date = {day: index for index, day in enumerate(dates)}
    for row in rows:
        matrix[index_region[row["region"]], index_date[row["date"]]] = row["mean_ndvi"]

    fig, ax = plt.subplots(figsize=(max(10, len(dates) * 0.42), 5.5))
    image = ax.imshow(matrix, aspect="auto", cmap="RdYlGn", vmin=0.15, vmax=0.85)
    ax.set_title("MODIS Terra Monthly NDVI: Vegetation Stress vs. High Health")
    ax.set_xlabel("Month")
    ax.set_ylabel("Region")
    ax.set_yticks(range(len(regions)), regions)
    ax.set_xticks(range(len(dates)), [day[:7] for day in dates], rotation=45, ha="right")
    colorbar = fig.colorbar(image, ax=ax, fraction=0.025, pad=0.02)
    colorbar.set_label("Approx. mean NDVI decoded from GIBS colormap")

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def plot_lines(rows: list[dict[str, object]], output_path: Path) -> None:
    regions = list(dict.fromkeys(row["region"] for row in rows))
    dates = list(dict.fromkeys(row["date"] for row in rows))

    fig, (ax_stress, ax_health) = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
    for region in regions:
        region_rows = [row for row in rows if row["region"] == region]
        ax_stress.plot(dates, [row["stress_share"] * 100 for row in region_rows], marker="o", label=region)
        ax_health.plot(dates, [row["high_health_share"] * 100 for row in region_rows], marker="o", label=region)

    ax_stress.set_title("Share of Vegetated Pixels Showing Stress or High Health")
    ax_stress.set_ylabel(f"Stress share (%)")
    ax_health.set_ylabel(f"High-health share (%)")
    ax_health.set_xlabel("Month")
    ax_health.set_xticks(range(len(dates)), [day[:7] for day in dates], rotation=45, ha="right")
    ax_stress.grid(alpha=0.25)
    ax_health.grid(alpha=0.25)
    ax_stress.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def build_rows(
    regions: Iterable[Region],
    months: Iterable[date],
    width: int,
    height: int,
    sample_stride: int,
    stress_threshold: float,
    high_threshold: float,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with requests.Session() as session:
        color_table, value_table = load_colormap(session)
        for region in regions:
            for month in months:
                print(f"Fetching {region.name} {month.isoformat()}...")
                image = download_ndvi_image(session, region, month, width, height)
                ndvi = decode_ndvi(image, color_table, value_table, sample_stride)
                summary = summarize_ndvi(ndvi, stress_threshold, high_threshold)
                rows.append(
                    {
                        "region": region.name,
                        "date": month.isoformat(),
                        "year": month.year,
                        "month": month.month,
                        "bbox": ",".join(str(value) for value in region.bbox),
                        **summary,
                    }
                )
    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download MODIS Terra monthly NDVI from NASA GIBS and summarize vegetation health."
    )
    parser.add_argument("--start", default="2023-01", help="Start month in YYYY-MM format.")
    parser.add_argument("--end", default="2023-12", help="End month in YYYY-MM format.")
    parser.add_argument("--width", type=int, default=640, help="Downloaded WMS image width per region.")
    parser.add_argument("--height", type=int, default=420, help="Downloaded WMS image height per region.")
    parser.add_argument("--sample-stride", type=int, default=3, help="Use every nth pixel to keep runtime small.")
    parser.add_argument("--stress-threshold", type=float, default=0.30, help="NDVI below this is counted as stress.")
    parser.add_argument("--high-threshold", type=float, default=0.60, help="NDVI at or above this is high health.")
    parser.add_argument("--csv", default="data/modis_ndvi_region_month.csv", help="Output CSV path.")
    parser.add_argument("--json", default="data/modis_ndvi_region_month.json", help="Output JSON path.")
    parser.add_argument(
        "--heatmap",
        default="figures/modis_ndvi_stress_health_heatmap.png",
        help="Output heatmap PNG path.",
    )
    parser.add_argument(
        "--lines",
        default="figures/modis_ndvi_stress_health_lines.png",
        help="Output line chart PNG path.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    months = month_starts(args.start, args.end)
    rows = build_rows(
        DEFAULT_REGIONS,
        months,
        args.width,
        args.height,
        args.sample_stride,
        args.stress_threshold,
        args.high_threshold,
    )
    write_csv(rows, Path(args.csv))
    write_json(rows, Path(args.json))
    plot_heatmap(rows, Path(args.heatmap))
    plot_lines(rows, Path(args.lines))
    print(f"Wrote {len(rows)} rows to {args.csv} and {args.json}")
    print(f"Wrote figures to {args.heatmap} and {args.lines}")


if __name__ == "__main__":
    main()
