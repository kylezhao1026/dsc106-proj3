# MODIS NDVI Vegetation Stress/Health Preprocessing

This repository includes a Python preprocessing script for the DSC 106 Project 3 question:

> Where and when does vegetation show signs of stress or high health based on NDVI patterns?

The script uses NASA GIBS WMS to download `MODIS_Terra_L3_NDVI_Monthly` imagery for several regions, decodes the colorized pixels back to approximate NDVI values with the official GIBS MODIS NDVI colormap, and writes compact static data files for a D3 visualization.

## Run

```bash
python3 -m pip install -r requirements.txt
python3 scripts/modis_ndvi_stress_health.py
```

## Outputs

- `data/modis_ndvi_region_month.csv`: region-month summaries for D3 or exploratory analysis.
- `data/modis_ndvi_region_month.json`: same data in JSON form for browser loading.
- `figures/modis_ndvi_stress_health_heatmap.png`: static exploratory heatmap of mean NDVI.
- `figures/modis_ndvi_stress_health_lines.png`: static exploratory line chart of stress and high-health share.
- `figures/`: other Matplotlib PNGs from the script (`index.html` loads images from here).
- **`index.html`**: documentation page for all visualizations (GitHub Pages: branch **main**, folder **`/`**—not `/docs`).

## Interpretation

- `mean_ndvi` and `median_ndvi`: approximate NDVI decoded from the GIBS visualization color map.
- `stress_share`: share of visible pixels with NDVI below `0.30`.
- `high_health_share`: share of visible pixels with NDVI at or above `0.60`.

These are useful for project exploration and for generating a static file that D3 can load. For the final DSC 106 interactive submission, keep the visualization implementation in D3 rather than Matplotlib.
