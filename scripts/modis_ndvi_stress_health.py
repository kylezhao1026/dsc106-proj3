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
import textwrap
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Iterable

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.ticker import NullLocator
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

REGION_NDVI_SERIES_COLORS: dict[str, str] = {
    "California Central Valley": "#2563eb",
    "Pacific Northwest": "#0d9488",
    "Great Plains": "#d97706",
    "Southeast US": "#7c3aed",
    "Amazon Basin": "#2a9483",
}

# Short labels for trend callouts on the combined regional NDVI figure.
REGION_TREND_CALLOUT: dict[str, str] = {
    "California Central Valley": (
        "Central Valley: builds in cool/wet months, eases when summer stress hits"
    ),
    "Pacific Northwest": "Pacific NW: peaks late spring–summer, softer through fall–winter",
    "Great Plains": "Great Plains: steep winter lows vs. mid-year green peak",
    "Southeast US": "Southeast: broad spring–summer high, milder winter dip",
    "Amazon Basin": "Amazon: stays high year-round; small month-to-month ripples only",
}


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


def load_csv_rows(path: Path) -> list[dict[str, object]]:
    with path.open(newline="", encoding="utf-8") as file:
        raw = list(csv.DictReader(file))
    rows: list[dict[str, object]] = []
    for row in raw:
        rows.append(
            {
                "region": row["region"],
                "date": row["date"],
                "year": int(row["year"]),
                "month": int(row["month"]),
                "mean_ndvi": float(row["mean_ndvi"]) if row.get("mean_ndvi") not in ("", None) else math.nan,
                "median_ndvi": float(row["median_ndvi"]) if row.get("median_ndvi") not in ("", None) else math.nan,
                "stress_share": float(row["stress_share"]) if row.get("stress_share") not in ("", None) else math.nan,
                "high_health_share": float(row["high_health_share"])
                if row.get("high_health_share") not in ("", None)
                else math.nan,
                "valid_pixels": int(row["valid_pixels"]) if row.get("valid_pixels") not in ("", None) else 0,
                "bbox": row.get("bbox", ""),
            }
        )
    return rows


def plot_ndvi_regional_timeseries(rows: list[dict[str, object]], output_path: Path) -> None:
    """Single axes with all regions; arrows annotate seasonal / month-to-month trends."""
    seen_order = list(dict.fromkeys(row["region"] for row in rows))
    preferred = [r.name for r in DEFAULT_REGIONS]
    regions = [name for name in preferred if name in seen_order]
    regions.extend(n for n in seen_order if n not in regions)

    all_series_dates: list[date] = []
    all_ndvi: list[float] = []
    series: list[tuple[str, list[date], list[float], str]] = []

    for region in regions:
        region_rows = sorted((row for row in rows if row["region"] == region), key=lambda r: str(r["date"]))
        dates = [datetime.strptime(str(row["date"])[:10], "%Y-%m-%d").date() for row in region_rows]
        values = [float(row["mean_ndvi"]) for row in region_rows]
        all_series_dates.extend(dates)
        for v in values:
            if not math.isnan(v):
                all_ndvi.append(v)
        callout = REGION_TREND_CALLOUT.get(region, f"{region}: NDVI by month")
        series.append((region, dates, values, callout))

    if len(all_ndvi) > 1:
        g_y_min, g_y_max = min(all_ndvi), max(all_ndvi)
    elif len(all_ndvi) == 1:
        g_y_min, g_y_max = all_ndvi[0] - 0.05, all_ndvi[0] + 0.05
    else:
        g_y_min, g_y_max = 0.0, 1.0
    y_pad = 0.04 * (g_y_max - g_y_min) if g_y_max > g_y_min else 0.05
    global_ylim = (g_y_min - y_pad, g_y_max + y_pad)

    fig, ax = plt.subplots(figsize=(14, 7))

    series_meta: list[tuple[str, list[date], list[float], str, int, str]] = []
    for index, (region, dates, values, callout) in enumerate(series):
        color = REGION_NDVI_SERIES_COLORS.get(region, f"C{index}")
        ax.plot(
            dates,
            values,
            color=color,
            marker="o",
            markersize=5,
            linewidth=2.0,
            label=region,
            clip_on=False,
        )

        arr = np.array(values, dtype=float)
        if not np.any(np.isfinite(arr)):
            continue
        end_idx = len(values) - 1
        while end_idx >= 0 and math.isnan(float(values[end_idx])):
            end_idx -= 1
        if end_idx < 0:
            continue
        series_meta.append((region, dates, values, callout, end_idx, color))

    ax.set_ylim(global_ylim)
    _y_lo, _y_hi = global_ylim
    ax.set_ylim(_y_lo, _y_hi + (_y_hi - _y_lo) * 0.055)
    ax.set_ylabel("NDVI")
    ax.set_title("Regional mean NDVI varies by month")
    ax.grid(True, alpha=0.35, linestyle="-", linewidth=0.6)
    ax.set_axisbelow(True)
    ax.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.18),
        ncol=3,
        framealpha=0.95,
        fontsize=9,
    )

    if all_series_dates:
        d0, d1 = min(all_series_dates), max(all_series_dates)
        span_days = (d1 - d0).days + 1.0
        pad = max(12.0, min(45.0, span_days * 0.08))
        # Extra room on the right so line-end callouts sit in whitespace, not over the grid.
        pad_right_extra = max(52.0, min(110.0, span_days * 0.17))
        ax.set_xlim(
            d0 - timedelta(days=pad),
            d1 + timedelta(days=pad + pad_right_extra),
        )

        span_months = (d1.year - d0.year) * 12 + (d1.month - d0.month) + 1
        if span_months <= 15:
            month_interval = 1
        elif span_months <= 30:
            month_interval = 2
        else:
            month_interval = max(1, (span_months + 11) // 12)

        ax.xaxis.set_major_locator(mdates.MonthLocator(interval=month_interval))
        single_calendar_year = d0.year == d1.year
        if single_calendar_year:
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%b"))
        else:
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
        ax.xaxis.set_minor_locator(
            mdates.MonthLocator(interval=1) if month_interval > 1 else NullLocator()
        )

        if single_calendar_year:
            x_axis_caption = (
                f"Month in {d0.year} — each point = regional mean NDVI for that month’s MODIS composite"
            )
        else:
            x_axis_caption = (
                "Month (year on ticks when the series spans more than one calendar year) — "
                "each point = regional mean NDVI for that month’s MODIS composite"
            )
    else:
        x_axis_caption = "Month — each point = regional mean NDVI for that month’s MODIS composite"

    plt.setp(ax.xaxis.get_majorticklabels(), rotation=0, ha="center")
    ax.set_xlabel(x_axis_caption, fontsize=9.5, labelpad=11)

    # Callouts anchor on each line’s last month; vertical stagger follows endpoint NDVI so mid lines
    # (e.g. Central Valley) are not buried under neighbors that share the same calendar month.
    # Amazon: label in upper-right axes fraction (open area) so it does not overlap other callouts.
    n_meta = len(series_meta)
    if n_meta:
        end_ys = np.array(
            [float(v[e]) for _, _, v, _, e, _ in series_meta],
            dtype=float,
        )
        sort_order = np.argsort(end_ys)
        rank = np.empty(n_meta, dtype=int)
        rank[sort_order] = np.arange(n_meta)

        stagger_by_region: dict[str, float] = {}
        for i, (region, _dates, _values, _callout, _end_idx, _color) in enumerate(series_meta):
            r = int(rank[i])
            sy = (r - 0.5 * (n_meta - 1)) * 22.0
            if region == "California Central Valley":
                sy += 6.0
            elif region == "Southeast US":
                sy += 10.0
            stagger_by_region[region] = sy

        for i, (region, dates, values, callout, end_idx, color) in enumerate(series_meta):
            wrapped = textwrap.fill(
                callout,
                width=26,
                break_long_words=False,
                break_on_hyphens=True,
            )
            r = int(rank[i])
            stagger_y_pt = stagger_by_region[region]
            x_off_pt = 54.0
            if region == "California Central Valley":
                x_off_pt = 68.0

            z_ann = 10 + r
            if region == "Southeast US":
                z_ann = 24
            elif region == "Amazon Basin":
                z_ann = 25

            if region == "Amazon Basin":
                ax.annotate(
                    wrapped,
                    xy=(dates[end_idx], float(values[end_idx])),
                    xycoords="data",
                    xytext=(0.97, 0.94),
                    textcoords="axes fraction",
                    fontsize=8.5,
                    color=color,
                    ha="right",
                    va="top",
                    linespacing=1.2,
                    zorder=z_ann,
                    arrowprops=dict(
                        arrowstyle="-",
                        color=color,
                        lw=0.9,
                        shrinkA=3,
                        shrinkB=5,
                        connectionstyle="arc3,rad=0.2",
                    ),
                    bbox=dict(
                        boxstyle="round,pad=0.32",
                        facecolor="white",
                        edgecolor=color,
                        alpha=0.95,
                        linewidth=0.8,
                    ),
                    clip_on=False,
                )
            else:
                ax.annotate(
                    wrapped,
                    xy=(dates[end_idx], float(values[end_idx])),
                    xycoords="data",
                    xytext=(x_off_pt, stagger_y_pt),
                    textcoords="offset points",
                    fontsize=8.5,
                    color=color,
                    ha="left",
                    va="center",
                    linespacing=1.2,
                    zorder=z_ann,
                    arrowprops=dict(
                        arrowstyle="-",
                        color=color,
                        lw=0.9,
                        shrinkA=2,
                        shrinkB=4,
                        connectionstyle="arc3,rad=0.06",
                    ),
                    bbox=dict(
                        boxstyle="round,pad=0.32",
                        facecolor="white",
                        edgecolor=color,
                        alpha=0.95,
                        linewidth=0.8,
                    ),
                    clip_on=False,
                )

    fig.tight_layout(rect=[0.04, 0.13, 0.96, 0.94])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=180, bbox_inches="tight")
    plt.close(fig)


def _region_name_for_boxplot_xaxis(region: str) -> str:
    """Short multi-line x labels (no rotation) to reduce overlap."""
    return {
        "California Central Valley": "California\nCentral Valley",
        "Pacific Northwest": "Pacific\nNorthwest",
        "Great Plains": "Great\nPlains",
        "Southeast US": "Southeast\nUS",
        "Amazon Basin": "Amazon\nBasin",
    }.get(region, region.replace(" ", "\n", 1))


def plot_ndvi_distribution_by_region(rows: list[dict[str, object]], output_path: Path) -> None:
    """Box plot of regional mean NDVI (one value per region-month in the dataset)."""
    seen_order = list(dict.fromkeys(row["region"] for row in rows))
    preferred = [r.name for r in DEFAULT_REGIONS]
    regions = [name for name in preferred if name in seen_order]
    regions.extend(n for n in seen_order if n not in regions)

    data: list[list[float]] = []
    for region in regions:
        vals = [
            float(row["mean_ndvi"])
            for row in rows
            if row["region"] == region and not math.isnan(float(row["mean_ndvi"]))
        ]
        data.append(vals)

    if not any(len(d) > 0 for d in data):
        return

    fig, ax = plt.subplots(figsize=(10, 5.8))
    n = len(regions)
    positions = np.arange(1, n + 1)
    y_all = [v for d in data for v in d]
    y0, y1 = min(y_all), max(y_all)
    pad = 0.04 * (y1 - y0) if y1 > y0 else 0.02
    ylim = (y0 - pad, y1 + pad)

    tick_labels = [_region_name_for_boxplot_xaxis(r) for r in regions]
    bp = ax.boxplot(
        data,
        positions=positions,
        tick_labels=tick_labels,
        patch_artist=True,
        widths=0.55,
    )
    for patch, reg in zip(bp["boxes"], regions, strict=True):
        c = REGION_NDVI_SERIES_COLORS.get(reg, "#888888")
        patch.set_facecolor(c)
        patch.set_alpha(0.75)
        patch.set_edgecolor(c)
    for whisker in bp["whiskers"]:
        whisker.set(color="#333333", linewidth=1.0)
    for cap in bp["caps"]:
        cap.set(color="#333333", linewidth=1.0)
    for median in bp["medians"]:
        median.set(color="#111111", linewidth=1.4)

    plt.setp(ax.xaxis.get_majorticklabels(), rotation=0, ha="center")
    ax.set_xlabel("Region", labelpad=10)
    ax.set_ylabel("Monthly MODIS regional means")
    ax.set_title("NDVI Distribution varies extensively across regions")
    ax.set_ylim(ylim)
    ax.grid(True, axis="y", alpha=0.35, linestyle="-", linewidth=0.6)
    ax.set_axisbelow(True)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_stress_vs_ndvi(rows: list[dict[str, object]], output_path: Path) -> None:
    """Scatter of regional mean NDVI vs. stress share (one point per region-month)."""
    seen = set(row["region"] for row in rows)
    preferred = [r.name for r in DEFAULT_REGIONS]
    regions_order = [name for name in preferred if name in seen]
    regions_order.extend(n for n in seen if n not in regions_order)

    fig, ax = plt.subplots(figsize=(9.5, 6.2))

    all_ndvi: list[float] = []
    all_stress_pct: list[float] = []
    for idx, region in enumerate(regions_order):
        color = REGION_NDVI_SERIES_COLORS.get(region, f"C{idx}")
        xs: list[float] = []
        ys: list[float] = []
        for row in rows:
            if row["region"] != region:
                continue
            ndvi = float(row["mean_ndvi"])
            stress_pct = float(row["stress_share"]) * 100.0
            if math.isnan(ndvi) or math.isnan(stress_pct):
                continue
            xs.append(ndvi)
            ys.append(stress_pct)
            all_ndvi.append(ndvi)
            all_stress_pct.append(stress_pct)
        if xs:
            ax.scatter(
                xs,
                ys,
                c=color,
                label=region,
                s=56,
                alpha=0.88,
                edgecolors="white",
                linewidths=0.65,
                zorder=2,
            )

    if len(all_ndvi) >= 3:
        ndvi_arr = np.asarray(all_ndvi, dtype=float)
        stress_arr = np.asarray(all_stress_pct, dtype=float)
        if np.nanstd(ndvi_arr) > 1e-9:
            coef = np.polyfit(ndvi_arr, stress_arr, 1)
            x_line = np.linspace(float(np.min(ndvi_arr)), float(np.max(ndvi_arr)), 80)
            ax.plot(
                x_line,
                np.polyval(coef, x_line),
                color="#333333",
                linestyle="--",
                linewidth=1.6,
                alpha=0.9,
                label="Linear trend (all region-months)",
                zorder=1,
            )

    ax.set_xlabel("Regional mean NDVI")
    ax.set_ylabel("Stress share (% vegetated pixels below threshold)")
    ax.set_title("Higher vegetation stress is correlated with lower regional NDVI")
    ax.grid(True, alpha=0.35, linestyle="-", linewidth=0.6)
    ax.set_axisbelow(True)
    ax.legend(loc="best", fontsize=8.5, framealpha=0.95)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_heatmap(rows: list[dict[str, object]], output_path: Path) -> None:
    regions = list(dict.fromkeys(row["region"] for row in rows))
    dates = list(dict.fromkeys(row["date"] for row in rows))
    matrix = np.full((len(regions), len(dates)), np.nan)

    index_region = {region: index for index, region in enumerate(regions)}
    index_date = {day: index for index, day in enumerate(dates)}
    for row in rows:
        matrix[index_region[row["region"]], index_date[row["date"]]] = row["mean_ndvi"]

    fig, ax = plt.subplots(figsize=(max(10, len(dates) * 0.42), 5.5))
    # viridis: color-blind–safe sequential scale (avoid RdYlGn red–green)
    image = ax.imshow(matrix, aspect="auto", cmap="viridis", vmin=0.15, vmax=0.85)
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
    parser.add_argument(
        "--ndvi-series",
        default="figures/modis_ndvi_regional_series.png",
        help="Output stacked regional mean NDVI time series PNG path.",
    )
    parser.add_argument(
        "--ndvi-distribution",
        default="figures/modis_ndvi_distribution_by_region.png",
        help="Output boxplot NDVI-by-region EDA PNG path.",
    )
    parser.add_argument(
        "--stress-vs-ndvi",
        default="figures/modis_ndvi_stress_vs_ndvi.png",
        help="Output scatter stress vs NDVI PNG path.",
    )
    parser.add_argument(
        "--from-csv",
        action="store_true",
        help="Load rows from --csv instead of downloading from GIBS (writes figures only).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv)
    if args.from_csv:
        rows = load_csv_rows(csv_path)
    else:
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
        write_csv(rows, csv_path)
        write_json(rows, Path(args.json))
    plot_heatmap(rows, Path(args.heatmap))
    plot_lines(rows, Path(args.lines))
    plot_ndvi_regional_timeseries(rows, Path(args.ndvi_series))
    plot_ndvi_distribution_by_region(rows, Path(args.ndvi_distribution))
    plot_stress_vs_ndvi(rows, Path(args.stress_vs_ndvi))
    if not args.from_csv:
        print(f"Wrote {len(rows)} rows to {args.csv} and {args.json}")
    print(
        f"Wrote figures to {args.heatmap}, {args.lines}, {args.ndvi_series}, "
        f"{args.ndvi_distribution}, and {args.stress_vs_ndvi}"
    )


if __name__ == "__main__":
    main()
