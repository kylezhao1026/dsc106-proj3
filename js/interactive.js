(function () {
  if (d3.select("body").classed("embed")) {
    d3.select("#fetch-note").html(
      "Serve the repo over HTTP (e.g. <code>python3 -m http.server 8080</code>) or GitHub Pages so the JSON loads inside this embedded view."
    );
  }

  const WMS_BASE = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
  const LAYER_TERRA = "MODIS_Terra_L3_NDVI_Monthly";
  /** Terra has no April 2025 tile on GIBS, so we use AQUA as a fallback. */
  const LAYER_AQUA = "MODIS_Aqua_L3_NDVI_Monthly";
  const DATA_URL = "data/modis_ndvi_region_month.json";
  const MAP_WIDTH = 400;

  const _rs = getComputedStyle(document.documentElement);
  const VIZ = {
    stress: _rs.getPropertyValue("--stress").trim() || "#c75a2a",
    moderate: _rs.getPropertyValue("--mid").trim() || "#8e9faf",
    healthy: _rs.getPropertyValue("--healthy").trim() || "#2a9483",
    ndvi: _rs.getPropertyValue("--ndvi-line").trim() || "#2a75ad",
    ndviR: "#7c3aed",
    baseline: "#64748b",
    baselineR: "#94a3b8",
    sep: _rs.getPropertyValue("--viz-sep").trim() || "#cbd5e1",
    muted: _rs.getPropertyValue("--muted").trim() || "#475569",
    text: _rs.getPropertyValue("--text").trim() || "#0f172a",
  };

  const BASELINE_YEAR_WINDOW = 20;
  /** First year present in the project’s MODIS CSV/JSON (matches default GIBS fetch start). */
  const DATA_FIRST_YEAR = 2006;

  /** Shared copy for the NDVI year chart footnote (ties chart to map decode). */
  const NDVI_CHART_NOTE_OPEN =
    "NDVI (Normalized Difference Vegetation Index) compares near-infrared and red light from satellites—higher values mean more vigorous green vegetation (roughly 0 to 1). Regional means here use the same NDVI decoded from the GIBS map palette as the maps above.";

  /** Years used for the dashed baseline label (up to 20 prior years, not before DATA_FIRST_YEAR). */
  function baselineDisplayYearRange(selectedYear) {
    const high = selectedYear - 1;
    let low = Math.max(DATA_FIRST_YEAR, selectedYear - BASELINE_YEAR_WINDOW);
    if (low > high) low = high;
    return { low, high };
  }

  const fmtPct = d3.format(".1f");
  const fmtNdvi = d3.format(".3f");

  /** NDVI chart hover tips: viewport positioning so parent `overflow: hidden` does not clip them. */
  function positionShareYearTooltip(tipSelection, event, html) {
    const node = tipSelection.node();
    if (!node) return;
    tipSelection.html(html);
    const pad = 12;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = node.offsetWidth || 160;
    const th = node.offsetHeight || 90;
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + tw > vw - margin) left = event.clientX - tw - pad;
    if (top + th > vh - margin) top = event.clientY - th - pad;
    left = Math.max(margin, Math.min(left, vw - tw - margin));
    top = Math.max(margin, Math.min(top, vh - th - margin));
    tipSelection.style("left", `${left}px`).style("top", `${top}px`);
  }

  /** Per-side: after first successful tile, skip blocking “Loading map…” overlay on updates. */
  const mapImageReady = { l: false, r: false };

  /**
   * WMS GetMap URLs are already unique (TIME, BBOX, dimensions). Avoid cache-busting query params so
   * the browser can reuse tiles when scrubbing or replaying months — that keeps the map closer to the scrubber.
   */
  const prefetchedTileUrls = new Set();
  const PREFETCH_URL_CAP = 180;
  function prefetchTileUrl(url) {
    if (!url || prefetchedTileUrls.has(url)) return;
    if (prefetchedTileUrls.size >= PREFETCH_URL_CAP) {
      const drop = prefetchedTileUrls.values().next().value;
      prefetchedTileUrls.delete(drop);
    }
    prefetchedTileUrls.add(url);
    const im = new Image();
    im.decoding = "async";
    im.onload = im.onerror = () => {
      /* keep set entry: avoids re-prefetching the same URL in a tight loop */
    };
    im.src = url;
  }

  function wmsLayerForTimeIso(timeIso) {
    return timeIso === "2025-04-01" ? LAYER_AQUA : LAYER_TERRA;
  }

  function buildWmsUrl(bboxStr, timeIso, width, height) {
    const parts = bboxStr.split(",").map(Number);
    const [lonMin, latMin, lonMax, latMax] = parts;
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: wmsLayerForTimeIso(timeIso),
      STYLES: "",
      FORMAT: "image/png",
      TRANSPARENT: "true",
      SRS: "EPSG:4326",
      BBOX: `${lonMin},${latMin},${lonMax},${latMax}`,
      WIDTH: String(width),
      HEIGHT: String(height),
      TIME: timeIso,
    });
    return `${WMS_BASE}?${params.toString()}`;
  }

  function mapHeightForBbox(bboxStr, width) {
    const [lonMin, latMin, lonMax, latMax] = bboxStr.split(",").map(Number);
    const lonSpan = Math.max(1e-6, lonMax - lonMin);
    const latSpan = Math.max(1e-6, latMax - latMin);
    return Math.max(120, Math.round((width * latSpan) / lonSpan));
  }

  function moderateShare(d) {
    const s = (+d.stress_share || 0) + (+d.high_health_share || 0);
    return Math.max(0, Math.min(1, 1 - s));
  }

  function rowHasDecodeMetrics(row) {
    if (!row) return false;
    return (
      row.mean_ndvi != null &&
      Number.isFinite(+row.mean_ndvi) &&
      row.stress_share != null &&
      Number.isFinite(+row.stress_share) &&
      row.high_health_share != null &&
      Number.isFinite(+row.high_health_share)
    );
  }

  function showError(msg) {
    d3.select("#error").text(msg).property("hidden", false);
  }

  function renderStats(selection, statsSelector) {
    const root = d3.select(statsSelector);
    root.selectAll("*").remove();
    const rows = selection
      ? [
          { k: "Mean NDVI", v: fmtNdvi(selection.mean_ndvi), accent: VIZ.ndvi },
          { k: "Median NDVI", v: fmtNdvi(selection.median_ndvi), accent: VIZ.ndvi },
          { k: "Stress share", v: fmtPct(selection.stress_share * 100) + "%", accent: VIZ.stress },
          { k: "High health", v: fmtPct(selection.high_health_share * 100) + "%", accent: VIZ.healthy },
        ]
      : [
          { k: "Mean NDVI", v: "—", accent: VIZ.muted },
          { k: "Median NDVI", v: "—", accent: VIZ.muted },
          { k: "Stress share", v: "—", accent: VIZ.muted },
          { k: "High health", v: "—", accent: VIZ.muted },
        ];

    root
      .selectAll("div.stat")
      .data(rows)
      .join("div")
      .attr("class", "stat")
      .each(function (d) {
        const box = d3.select(this);
        box.append("div").attr("class", "k").text(d.k);
        box
          .append("div")
          .attr("class", "v")
          .style("color", d.accent || null)
          .text(d.v);
      });
  }

  function renderShareBar(selection, barSelector) {
    const svg = d3.select(barSelector);
    svg.selectAll("*").remove();
    if (!selection) {
      svg
        .append("text")
        .attr("x", 200)
        .attr("y", 32)
        .attr("text-anchor", "middle")
        .attr("fill", VIZ.muted)
        .attr("font-size", 11)
        .text("No summary row for this month in the JSON.");
      return;
    }

    const w = 400;
    const h = 40;
    const barPadTop = 8;
    const barRectH = h - 8;
    const stress = selection.stress_share;
    const high = selection.high_health_share;
    const mid = moderateShare(selection);
    const x = d3.scaleLinear().domain([0, 1]).range([0, w]);

    const g = svg.append("g").attr("transform", `translate(0,${barPadTop})`);

    const segs = [
      { key: "stress", len: stress, fill: VIZ.stress },
      { key: "mid", len: mid, fill: VIZ.moderate },
      { key: "high", len: high, fill: VIZ.healthy },
    ];

    let acc = 0;
    g.selectAll("rect")
      .data(segs)
      .join("rect")
      .attr("x", (d) => {
        const start = acc;
        acc += d.len;
        return x(start);
      })
      .attr("y", 0)
      .attr("width", (d) => Math.max(0, x(d.len) - x(0)))
      .attr("height", barRectH)
      .attr("rx", 4)
      .attr("fill", (d) => d.fill);

    const labelY = barRectH + 3;
    const labels = g.append("g").attr("transform", `translate(0,${labelY})`);
    const capLine = labels
      .append("text")
      .attr("x", 0)
      .attr("y", 0)
      .attr("dominant-baseline", "hanging")
      .attr("font-size", 11);
    capLine.append("tspan").attr("fill", VIZ.stress).attr("font-weight", 650).text(`Stress ${fmtPct(stress * 100)}%`);
    capLine.append("tspan").attr("fill", VIZ.sep).attr("font-weight", 400).text(" · ");
    capLine.append("tspan").attr("fill", VIZ.moderate).attr("font-weight", 600).text(`Moderate ${fmtPct(mid * 100)}%`);
    capLine.append("tspan").attr("fill", VIZ.sep).attr("font-weight", 400).text(" · ");
    capLine.append("tspan").attr("fill", VIZ.healthy).attr("font-weight", 650).text(`High health ${fmtPct(high * 100)}%`);
  }

  function dateKey(year, month) {
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

  /** Local calendar date (month 1–12). Avoid `new Date("YYYY-MM-DD")` — that is UTC and shifts labels in US timezones. */
  function calendarDate(year, month) {
    return new Date(year, month - 1, 1);
  }

  /** Mean NDVI for each calendar month 1–12 from prior years (window ending year−1; see BASELINE_YEAR_WINDOW). */
  function baselineNdviByMonth(regionRows, selectedYear) {
    const lowYear = selectedYear - BASELINE_YEAR_WINDOW;
    return d3.range(1, 13).map((month) => {
      const inWin = regionRows.filter(
        (d) => d.month === month && d.year < selectedYear && d.year >= lowYear
      );
      const pool = inWin.length
        ? inWin
        : regionRows.filter((d) => d.month === month && d.year < selectedYear);
      const nums = pool.map((d) => d.mean_ndvi).filter((v) => v != null && Number.isFinite(+v));
      return nums.length ? d3.mean(nums) : NaN;
    });
  }

  function monthPointsForRegion(regionRows, selectedYear) {
    if (!regionRows || regionRows.length === 0) return [];
    const byDate = new Map(regionRows.map((d) => [d.date, d]));
    const baselineArr = baselineNdviByMonth(regionRows, selectedYear);
    return d3.range(1, 13).map((month) => {
      const dk = dateKey(selectedYear, month);
      const src = byDate.get(dk);
      const yv = src && src.mean_ndvi != null && Number.isFinite(+src.mean_ndvi) ? +src.mean_ndvi : NaN;
      return {
        month,
        dateStr: dk,
        yearNdvi: yv,
        baselineNdvi: baselineArr[month - 1],
      };
    });
  }

  function renderNdviYearVsBaseline(regionRows, regionLabel, selectedYear, activeMonth) {
    const svg = d3.select("#share-year-chart");
    svg.selectAll("*").remove();
    const points = monthPointsForRegion(regionRows, selectedYear);
    if (!points.length) return;

    const margin = { top: 14, right: 22, bottom: 72, left: 52 };
    const W = 760;
    const H = 400;
    const iw = W - margin.left - margin.right;
    const ih = H - margin.top - margin.bottom;

    const vals = points.flatMap((p) => [p.yearNdvi, p.baselineNdvi]).filter((v) => Number.isFinite(v));
    const y0 = vals.length ? d3.min(vals) : 0.15;
    const y1 = vals.length ? d3.max(vals) : 0.85;
    const pad = Math.max(0.02, (y1 - y0) * 0.12);
    const y = d3.scaleLinear().domain([y0 - pad, y1 + pad]).nice().range([ih, 0]);
    const x = d3.scalePoint().domain(d3.range(1, 13).map(String)).range([0, iw]).padding(0.45);

    const lineYear = d3
      .line()
      .x((d) => x(String(d.month)))
      .y((d) => y(d.yearNdvi))
      .defined((d) => Number.isFinite(d.yearNdvi))
      .curve(d3.curveMonotoneX);
    const lineBase = d3
      .line()
      .x((d) => x(String(d.month)))
      .y((d) => y(d.baselineNdvi))
      .defined((d) => Number.isFinite(d.baselineNdvi))
      .curve(d3.curveMonotoneX);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.baseline)
      .attr("stroke-width", 2.2)
      .attr("stroke-dasharray", "7 5")
      .attr("d", lineBase(points));
    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.ndvi)
      .attr("stroke-width", 2.4)
      .attr("d", lineYear(points));

    const cur = points.find((d) => d.month === activeMonth);
    if (cur) {
      const cx = x(String(cur.month));
      g.append("line")
        .attr("x1", cx)
        .attr("x2", cx)
        .attr("y1", 0)
        .attr("y2", ih)
        .attr("stroke", VIZ.text)
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4 3")
        .attr("opacity", 0.4);
      if (Number.isFinite(cur.baselineNdvi)) {
        g.append("circle")
          .attr("cx", cx)
          .attr("cy", y(cur.baselineNdvi))
          .attr("r", 5)
          .attr("fill", VIZ.baseline)
          .attr("stroke", "#fff")
          .attr("stroke-width", 1.5);
      }
      if (Number.isFinite(cur.yearNdvi)) {
        g.append("circle")
          .attr("cx", cx)
          .attr("cy", y(cur.yearNdvi))
          .attr("r", 5)
          .attr("fill", VIZ.ndvi)
          .attr("stroke", "#fff")
          .attr("stroke-width", 1.5);
      }
    }

    g.append("g")
      .attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).tickFormat((m) => d3.timeFormat("%b")(new Date(2000, +m - 1, 1))))
      .attr("class", "axis");
    g.append("g").call(d3.axisLeft(y).ticks(6)).attr("class", "axis");

    g.append("text")
      .attr("x", iw / 2)
      .attr("y", ih + 34)
      .attr("fill", VIZ.muted)
      .attr("font-size", 11)
      .attr("font-weight", 650)
      .attr("text-anchor", "middle")
      .text("Month");
    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -ih / 2)
      .attr("y", -40)
      .attr("fill", VIZ.muted)
      .attr("font-size", 11)
      .attr("text-anchor", "middle")
      .text("Mean NDVI (decoded)");

    const blRng = baselineDisplayYearRange(selectedYear);
    const leg = g.append("g").attr("transform", `translate(0,${ih + 48})`);
    leg.append("line").attr("x1", 0).attr("x2", 22).attr("y1", 2).attr("y2", 2).attr("stroke", VIZ.ndvi).attr("stroke-width", 2.5);
    leg.append("text")
      .attr("x", 28)
      .attr("y", 4)
      .attr("dominant-baseline", "middle")
      .attr("fill", VIZ.muted)
      .attr("font-size", 10)
      .text(`${regionLabel} · ${selectedYear}`);
    leg.append("line")
      .attr("x1", 200)
      .attr("x2", 222)
      .attr("y1", 2)
      .attr("y2", 2)
      .attr("stroke", VIZ.baseline)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "6 4");
    leg.append("text")
      .attr("x", 228)
      .attr("y", 4)
      .attr("dominant-baseline", "middle")
      .attr("fill", VIZ.muted)
      .attr("font-size", 10)
      .text(`Same-month avg (${blRng.low}–${blRng.high})`);

    const tip = d3.select("#share-year-tooltip");
    if (tip.empty()) return;
    tip.classed("is-visible", false).attr("aria-hidden", "true").html("");

    const bandHalf = (x.step() * (1 - x.padding())) / 2 + 2;
    const showOneTip = (event, d) => {
      const monthLab = d3.timeFormat("%B")(new Date(2000, d.month - 1, 1));
      const yv = Number.isFinite(d.yearNdvi) ? fmtNdvi(d.yearNdvi) : "—";
      const bv = Number.isFinite(d.baselineNdvi) ? fmtNdvi(d.baselineNdvi) : "—";
      const html =
        `<div class="tip-title">${monthLab} ${selectedYear}</div>` +
        `<div class="tip-row"><span style="color:${VIZ.ndvi}">${selectedYear}</span><span>${yv}</span></div>` +
        `<div class="tip-row"><span style="color:${VIZ.baseline}">Baseline</span><span>${bv}</span></div>`;
      tip.classed("is-visible", true).attr("aria-hidden", "false");
      positionShareYearTooltip(tip, event, html);
    };
    g.selectAll(".hover-band")
      .data(points)
      .join("rect")
      .attr("class", "hover-band")
      .attr("x", (d) => x(String(d.month)) - bandHalf)
      .attr("y", 0)
      .attr("width", bandHalf * 2)
      .attr("height", ih)
      .attr("fill", "transparent")
      .style("cursor", "crosshair")
      .on("mouseenter", showOneTip)
      .on("mousemove", showOneTip)
      .on("mouseleave", () => {
        tip.classed("is-visible", false).attr("aria-hidden", "true").html("");
      });
  }

  function renderNdviTwoRegionCompare(
    regionRowsL,
    regionRowsR,
    labelL,
    labelR,
    selectedYear,
    activeMonth,
    sameRegion,
  ) {
    const svg = d3.select("#share-year-chart");
    svg.selectAll("*").remove();

    const margin = { top: 14, right: 14, bottom: 92, left: 54 };
    const W = 760;
    const H = 400;
    const iw = W - margin.left - margin.right;
    const ih = H - margin.top - margin.bottom;

    if (sameRegion || !regionRowsL?.length || !regionRowsR?.length) {
      svg
        .append("text")
        .attr("x", W / 2)
        .attr("y", H / 2)
        .attr("text-anchor", "middle")
        .attr("fill", VIZ.muted)
        .attr("font-size", 13)
        .text(sameRegion ? "Select two different regions to see a comparison chart." : "Missing regional data.");
      return;
    }

    const pL = monthPointsForRegion(regionRowsL, selectedYear);
    const pR = monthPointsForRegion(regionRowsR, selectedYear);
    const points = d3.range(1, 13).map((i) => {
      const a = pL[i - 1];
      const b = pR[i - 1];
      return {
        month: i,
        yearL: a.yearNdvi,
        yearR: b.yearNdvi,
        baseL: a.baselineNdvi,
        baseR: b.baselineNdvi,
      };
    });

    const valsL = points.flatMap((p) => [p.yearL, p.baseL]).filter((v) => Number.isFinite(v));
    const valsR = points.flatMap((p) => [p.yearR, p.baseR]).filter((v) => Number.isFinite(v));
    const vals = valsL.concat(valsR);
    const y0 = vals.length ? d3.min(vals) : 0.15;
    const y1 = vals.length ? d3.max(vals) : 0.85;
    const pad = Math.max(0.02, (y1 - y0) * 0.1);
    const yL = d3.scaleLinear().domain([y0 - pad, y1 + pad]).nice().range([ih, 0]);

    const x = d3.scalePoint().domain(d3.range(1, 13).map(String)).range([0, iw]).padding(0.45);

    const line = (key, scale, curve) =>
      d3
        .line()
        .x((d) => x(String(d.month)))
        .y((d) => scale(d[key]))
        .defined((d) => Number.isFinite(d[key]))
        .curve(curve);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.baseline)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "7 5")
      .attr("d", line("baseL", yL, d3.curveMonotoneX)(points));
    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.baselineR)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "4 4")
      .attr("d", line("baseR", yL, d3.curveMonotoneX)(points));

    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.ndvi)
      .attr("stroke-width", 2.4)
      .attr("d", line("yearL", yL, d3.curveMonotoneX)(points));
    g.append("path")
      .attr("fill", "none")
      .attr("stroke", VIZ.ndviR)
      .attr("stroke-width", 2.4)
      .attr("d", line("yearR", yL, d3.curveMonotoneX)(points));

    const cur = points.find((d) => d.month === activeMonth);
    if (cur) {
      const cx = x(String(cur.month));
      g.append("line")
        .attr("x1", cx)
        .attr("x2", cx)
        .attr("y1", 0)
        .attr("y2", ih)
        .attr("stroke", VIZ.text)
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4 3")
        .attr("opacity", 0.35);
      [
        ["yearL", yL, VIZ.ndvi],
        ["yearR", yL, VIZ.ndviR],
        ["baseL", yL, VIZ.baseline],
        ["baseR", yL, VIZ.baselineR],
      ].forEach(([key, scale, fill]) => {
        const v = cur[key];
        if (Number.isFinite(v)) {
          g.append("circle")
            .attr("cx", cx)
            .attr("cy", scale(v))
            .attr("r", 4)
            .attr("fill", fill)
            .attr("stroke", "#fff")
            .attr("stroke-width", 1);
        }
      });
    }

    g.append("g")
      .attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).tickFormat((m) => d3.timeFormat("%b")(new Date(2000, +m - 1, 1))))
      .attr("class", "axis");

    g.append("g").call(d3.axisLeft(yL).ticks(6)).attr("class", "axis");

    g.append("text")
      .attr("x", iw / 2)
      .attr("y", ih + 34)
      .attr("fill", VIZ.muted)
      .attr("font-size", 11)
      .attr("font-weight", 650)
      .attr("text-anchor", "middle")
      .text("Month");

    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -ih / 2)
      .attr("y", -42)
      .attr("fill", VIZ.muted)
      .attr("font-size", 11)
      .attr("text-anchor", "middle")
      .text("Mean NDVI (decoded)");

    const legY = ih + 46;
    const leg = g.append("g").attr("transform", `translate(0,${legY})`);
    const ell = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const legItem = (x, y, stroke, dash, w, text, opacity = 1) => {
      leg.append("line")
        .attr("x1", x)
        .attr("x2", x + w)
        .attr("y1", y)
        .attr("y2", y)
        .attr("stroke", stroke)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", dash || null)
        .attr("opacity", opacity);
      leg.append("text")
        .attr("x", x + w + 4)
        .attr("y", y + 1)
        .attr("dominant-baseline", "middle")
        .attr("fill", VIZ.muted)
        .attr("font-size", 9)
        .attr("opacity", opacity)
        .text(text);
    };
    legItem(0, 2, VIZ.ndvi, null, 14, `${ell(labelL, 20)} · ${selectedYear}`);
    legItem(200, 2, VIZ.ndviR, null, 14, `${ell(labelR, 20)} · ${selectedYear}`);
    const br = baselineDisplayYearRange(selectedYear);
    legItem(0, 18, VIZ.baseline, "6 4", 14, `${ell(labelL, 14)} ${br.low}–${br.high}`);
    legItem(200, 18, VIZ.baselineR, "4 4", 14, `${ell(labelR, 14)} ${br.low}–${br.high}`);

    const tip = d3.select("#share-year-tooltip");
    if (tip.empty()) return;

    tip.classed("is-visible", false).attr("aria-hidden", "true").html("");

    const short = (s) => (s.length > 22 ? s.slice(0, 20) + "…" : s);
    const bandHalf = (x.step() * (1 - x.padding())) / 2 + 2;
    const showBandTip = (event, d) => {
      const monthLab = d3.timeFormat("%B")(new Date(2000, d.month - 1, 1));
      const f = (v) => (Number.isFinite(v) ? fmtNdvi(v) : "—");
      const html =
        `<div class="tip-title">${monthLab} ${selectedYear}</div>` +
        `<div class="tip-row"><span style="color:${VIZ.ndvi}">${short(labelL)}</span><span>${f(d.yearL)}</span></div>` +
        `<div class="tip-row"><span style="color:${VIZ.ndviR}">${short(labelR)}</span><span>${f(d.yearR)}</span></div>` +
        `<div class="tip-row"><span style="color:${VIZ.baseline}">${short(labelL)} avg</span><span>${f(d.baseL)}</span></div>` +
        `<div class="tip-row"><span style="color:${VIZ.baselineR}">${short(labelR)} avg</span><span>${f(d.baseR)}</span></div>`;
      tip.classed("is-visible", true).attr("aria-hidden", "false");
      positionShareYearTooltip(tip, event, html);
    };
    g.selectAll(".hover-band")
      .data(points)
      .join("rect")
      .attr("class", "hover-band")
      .attr("x", (d) => x(String(d.month)) - bandHalf)
      .attr("y", 0)
      .attr("width", bandHalf * 2)
      .attr("height", ih)
      .attr("fill", "transparent")
      .style("cursor", "crosshair")
      .on("mouseenter", showBandTip)
      .on("mousemove", showBandTip)
      .on("mouseleave", () => {
        tip.classed("is-visible", false).attr("aria-hidden", "true").html("");
      });
  }

  /** d3.zoom per map side (installed once). */
  const mapZoomBehavior = { l: null, r: null };

  function mapZoomTransformCss(t) {
    return `translate(${t.x}px,${t.y}px) scale(${t.k})`;
  }

  function resizeMapZoomExtent(side) {
    const z = mapZoomBehavior[side];
    const vp = d3.select(`#map-zoom-viewport-${side}`);
    if (!z || vp.empty()) return;
    const el = vp.node();
    if (!el) return;
    const w = el.clientWidth || 0;
    const h = el.clientHeight || 0;
    if (w > 0 && h > 0) z.extent([[0, 0], [w, h]]);
  }

  function resetMapZoomTransform(side) {
    const z = mapZoomBehavior[side];
    const vp = d3.select(`#map-zoom-viewport-${side}`);
    const surface = d3.select(`#map-zoom-surface-${side}`);
    if (!surface.empty()) surface.style("transform", mapZoomTransformCss(d3.zoomIdentity));
    if (!vp.empty() && z) vp.call(z.transform, d3.zoomIdentity);
  }

  function setupMapZoomForSide(side) {
    if (mapZoomBehavior[side]) return;
    const viewport = d3.select(`#map-zoom-viewport-${side}`);
    const surface = d3.select(`#map-zoom-surface-${side}`);
    if (viewport.empty() || surface.empty()) return;

    const zoom = d3
      .zoom()
      .scaleExtent([1, 10])
      .on("start", () => {
        resizeMapZoomExtent(side);
      })
      .on("zoom", (event) => {
        surface.style("transform", mapZoomTransformCss(event.transform));
      });

    viewport.call(zoom);
    resizeMapZoomExtent(side);
    mapZoomBehavior[side] = zoom;

    d3.select(`#map-zoom-reset-${side}`).on("click", (event) => {
      event.stopPropagation();
      viewport.interrupt().transition().duration(160).call(zoom.transform, d3.zoomIdentity);
      surface.style("transform", mapZoomTransformCss(d3.zoomIdentity));
    });
  }

  function installMapZoomAfterLayout() {
    setupMapZoomForSide("l");
    setupMapZoomForSide("r");
    resizeMapZoomExtent("l");
    resizeMapZoomExtent("r");
  }

  function updateMap(side, url, preserveZoom = false) {
    const img = d3.select(`#wms-img-${side}`);
    const loading = d3.select(`#map-loading-${side}`);
    if (img.empty() || loading.empty()) return;
    const imgNode = img.node();

    imgNode.onload = () => {
      img.classed("loaded", true);
      loading.style("display", "none");
      mapImageReady[side] = true;
      if (!preserveZoom) resetMapZoomTransform(side);
      requestAnimationFrame(() => {
        resizeMapZoomExtent(side);
      });
    };
    imgNode.onerror = () => {
      loading.text("Map failed to load (network or CORS).");
      loading.style("display", "block");
      img.classed("loaded", false);
    };

    if (!mapImageReady[side]) {
      img.classed("loaded", false);
      loading.style("display", "block");
      loading.text("Loading map…");
    }
    img.attr("src", url);
  }

  d3.json(DATA_URL)
    .then((raw) => {
      if (!Array.isArray(raw) || raw.length === 0) {
        showError("No rows in JSON.");
        return;
      }

      d3.select("#fetch-note").property("hidden", true);
      d3.select("#controls").property("hidden", false);
      d3.select("#main-grid").property("hidden", false);

      const byRegion = d3.group(raw, (d) => d.region);
      const regions = Array.from(byRegion.keys()).sort();
      const years = Array.from(new Set(raw.map((d) => d.year))).sort((a, b) => a - b);

      const regionLeft = d3.select("#region-select-left");
      const regionRight = d3.select("#region-select-right");
      regionLeft
        .selectAll("option")
        .data(regions)
        .join("option")
        .attr("value", (d) => d)
        .text((d) => d);
      regionRight
        .selectAll("option")
        .data(regions)
        .join("option")
        .attr("value", (d) => d)
        .text((d) => d);

      const viewMode = d3.select("#view-mode");

      function isCompareMode() {
        return viewMode.property("value") === "compare";
      }

      function applyViewModeLayout() {
        const one = !isCompareMode();
        d3.select("#controls").attr("data-view", one ? "one" : "compare");
        d3.select("#main-grid").attr("data-mode", one ? "one" : "compare");
        d3.select("#label-region-left").text(one ? "Region" : "Region (left)");
      }

      function ensureDistinctRegions() {
        const nameL = regionLeft.property("value");
        if (!isCompareMode()) {
          return { nameL, nameR: null, same: false };
        }
        let r = regionRight.property("value");
        if (nameL === r && regions.length > 1) {
          const alt = regions.find((name) => name !== nameL) ?? nameL;
          regionRight.property("value", alt);
          r = alt;
        }
        return { nameL, nameR: r, same: nameL === r };
      }

      const defaultRight = regions.length > 1 ? regions.find((n) => n !== regions[0]) ?? regions[0] : regions[0];
      regionLeft.property("value", regions[0]);
      regionRight.property("value", defaultRight);

      const yearSelect = d3.select("#year-select");
      yearSelect.selectAll("option").data(years).join("option").attr("value", (d) => d).text((d) => String(d));

      const defaultYear = years.includes(2025) ? 2025 : years[years.length - 1];
      let vizYear = defaultYear;
      let vizMonth = 1;
      let playTimer = null;
      /** Last map framing identity per side; when unchanged (same month excluded), tile swaps keep d3 zoom. */
      let prevMapZoomCtx = { l: null, r: null };
      /** True only after the user hits Pause while the month animation is running (enables Resume). */
      let pausedMidPlayback = false;
      let scrubKnob = null;
      let scrubXLin = null;

      function stopPlay() {
        if (playTimer) {
          playTimer.stop();
          playTimer = null;
        }
        syncPlayButtons();
      }

      function syncPlayButtons() {
        const playing = !!playTimer;
        d3.select("#btn-pause").property("disabled", !playing);
        d3.select("#btn-play").property("disabled", playing);
        const canResume = pausedMidPlayback && !playing && vizMonth < 12;
        d3.select("#btn-resume").property("disabled", !canResume);
      }

      function findRow(region, year, month) {
        const key = dateKey(year, month);
        return raw.find((d) => d.region === region && d.date === key) ?? null;
      }

      function bboxForRegion(regionName) {
        const rr = byRegion.get(regionName) || [];
        const a = rr.find((d) => d.bbox);
        return a ? a.bbox : null;
      }

      function rowNote(row) {
        if (!row) return '<span class="muted">no JSON row</span>';
        if (rowHasDecodeMetrics(row)) return "";
        const vp = row.valid_pixels != null ? +row.valid_pixels : NaN;
        if (vp === 0) {
          return '<span class="muted">no MODIS pixels decoded for this month (tile empty or not on GIBS yet)</span>';
        }
        return '<span class="muted">no valid NDVI decode</span>';
      }

      function updateReadoutSingle(name, year, month, row) {
        const phrase = d3.timeFormat("%B %Y")(calendarDate(year, month));
        const n = rowNote(row);
        d3.select("#time-readout").html(
          `<div><strong>${phrase}</strong></div>` +
            `<div style="margin-top:0.35rem">${name}${n ? ` · ${n}` : ""}</div>`
        );
      }

      function updateReadoutCompare(nameL, nameR, year, month, rowL, rowR) {
        const phrase = d3.timeFormat("%B %Y")(calendarDate(year, month));
        const nL = rowNote(rowL);
        const nR = rowNote(rowR);
        d3.select("#time-readout").html(
          `<div><strong>${phrase}</strong></div>` +
            `<div style="margin-top:0.35rem"><span class="muted">Left ·</span> ${nameL}${nL ? ` · ${nL}` : ""}</div>` +
            `<div><span class="muted">Right ·</span> ${nameR}${nR ? ` · ${nR}` : ""}</div>`
        );
      }

      function moveScrubberKnob(m) {
        if (scrubKnob && scrubXLin) scrubKnob.attr("cx", scrubXLin(m));
      }

      function buildMonthScrubber() {
        const host = d3.select("#month-scrubber-host");
        host.selectAll("*").remove();
        const Sw = 620;
        const Sh = 64;
        const padL = 36;
        const padR = 36;
        const iw = Sw - padL - padR;
        scrubXLin = d3.scaleLinear().domain([1, 12]).range([0, iw]);
        const svg = host
          .append("svg")
          .attr("viewBox", `0 0 ${Sw} ${Sh}`)
          .attr("preserveAspectRatio", "xMinYMid meet");
        const g = svg.append("g").attr("transform", `translate(${padL},26)`);
        g.append("line")
          .attr("x1", 0)
          .attr("x2", iw)
          .attr("y1", 0)
          .attr("y2", 0)
          .attr("stroke", VIZ.sep)
          .attr("stroke-width", 5)
          .attr("stroke-linecap", "round");
        g.selectAll(".tlab")
          .data(d3.range(1, 13))
          .join("text")
          .attr("class", "tlab")
          .attr("x", (m) => scrubXLin(m))
          .attr("y", 30)
          .attr("text-anchor", "middle")
          .attr("font-size", 10)
          .attr("fill", VIZ.muted)
          .text((m) => d3.timeFormat("%b")(new Date(2000, m - 1, 1)));

        const snapX = (xf) => {
          const m = Math.max(1, Math.min(12, Math.round(scrubXLin.invert(xf))));
          return { m, px: scrubXLin(m) };
        };

        scrubKnob = g
          .append("circle")
          .attr("class", "scrub-knob")
          .attr("cy", 0)
          .attr("r", 10)
          .attr("fill", VIZ.ndvi)
          .attr("stroke", "#fff")
          .attr("stroke-width", 2)
          .attr("cx", scrubXLin(vizMonth))
          .style("cursor", "grab");

        const drag = d3
          .drag()
          .on("start", () => {
            pausedMidPlayback = false;
            stopPlay();
            scrubKnob.style("cursor", "grabbing");
          })
          .on("drag", function (event) {
            const [xf] = d3.pointer(event, g.node());
            const { m, px } = snapX(xf);
            scrubKnob.attr("cx", px);
            if (m !== vizMonth) {
              vizMonth = m;
              vizYear = +yearSelect.property("value");
              refresh();
            }
          })
          .on("end", function (event) {
            scrubKnob.style("cursor", "grab");
            const [xf] = d3.pointer(event, g.node());
            const { m, px } = snapX(xf);
            vizMonth = m;
            scrubKnob.attr("cx", px);
            pausedMidPlayback = false;
            stopPlay();
            refresh();
          });

        scrubKnob.call(drag);

        g.append("rect")
          .attr("x", -14)
          .attr("y", -16)
          .attr("width", iw + 28)
          .attr("height", 44)
          .attr("fill", "transparent")
          .style("cursor", "pointer")
          .on("click", function (event) {
            const [xf] = d3.pointer(event, g.node());
            const { m, px } = snapX(xf);
            vizMonth = m;
            scrubKnob.attr("cx", px);
            pausedMidPlayback = false;
            stopPlay();
            refresh();
          });
      }

      function startPlayFromJanuary() {
        pausedMidPlayback = false;
        stopPlay();
        vizMonth = 1;
        moveScrubberKnob(1);
        refresh();
        playTimer = d3.interval(() => {
          if (vizMonth >= 12) {
            pausedMidPlayback = false;
            stopPlay();
            return;
          }
          vizMonth += 1;
          moveScrubberKnob(vizMonth);
          refresh();
        }, 880);
        syncPlayButtons();
      }

      function startResume() {
        stopPlay();
        pausedMidPlayback = false;
        if (vizMonth >= 12) {
          syncPlayButtons();
          return;
        }
        playTimer = d3.interval(() => {
          if (vizMonth >= 12) {
            pausedMidPlayback = false;
            stopPlay();
            return;
          }
          vizMonth += 1;
          moveScrubberKnob(vizMonth);
          refresh();
        }, 880);
        syncPlayButtons();
      }

      function mapZoomCtxKey(isCompare, regionName, year, mapW, nativeH, bboxStr) {
        if (!bboxStr || !regionName || !nativeH) return null;
        return `${isCompare ? "c" : "1"}|${regionName}|${year}|${mapW}|${nativeH}|${bboxStr}`;
      }

      function refresh() {
        applyViewModeLayout();
        const compare = isCompareMode();
        const { nameL, nameR, same } = ensureDistinctRegions();
        d3.select("#region-compare-warn").property("hidden", !compare || !same);

        const mainGridSel = d3.select("#main-grid");
        vizYear = +yearSelect.property("value");
        const blYr = baselineDisplayYearRange(vizYear);
        const baselineYearSpan =
          blYr.low === blYr.high ? String(blYr.low) : `${blYr.low}–${blYr.high}`;
        const dateStr = dateKey(vizYear, vizMonth);
        const mapW = compare ? MAP_WIDTH : Math.min(520, Math.round(MAP_WIDTH * 1.28));

        const rowL = findRow(nameL, vizYear, vizMonth);
        const bboxL = rowL?.bbox ?? bboxForRegion(nameL);

        if (compare) {
          const rowR = findRow(nameR, vizYear, vizMonth);
          const bboxR = rowR?.bbox ?? bboxForRegion(nameR);
          updateReadoutCompare(nameL, nameR, vizYear, vizMonth, rowL, rowR);
          const monthLab = d3.timeFormat("%B %Y")(calendarDate(vizYear, vizMonth));
          d3.select("#stress-panel-title-l").text(`${nameL} Stress assessment — ${monthLab}`);
          d3.select("#stress-panel-title-r").text(`${nameR} Stress assessment — ${monthLab}`);
          d3.select("#map-title-left").text(nameL);
          d3.select("#map-title-right").text(nameR);

          const hL = bboxL ? mapHeightForBbox(bboxL, mapW) : 0;
          const hR = bboxR ? mapHeightForBbox(bboxR, mapW) : 0;
          const keyL = mapZoomCtxKey(true, nameL, vizYear, mapW, hL, bboxL);
          const keyR = mapZoomCtxKey(true, nameR, vizYear, mapW, hR, bboxR);
          const keepL = !!keyL && mapImageReady.l && prevMapZoomCtx.l === keyL;
          const keepR = !!keyR && mapImageReady.r && prevMapZoomCtx.r === keyR;
          const mapCompareH =
            hL > 0 && hR > 0 ? Math.min(hL, hR) : Math.max(hL, hR, 200);
          mainGridSel.style("--map-compare-h", `${mapCompareH}px`);

          d3.select("#map-zoom-viewport-l")
            .style("aspect-ratio", null)
            .style("height", `${mapCompareH}px`);
          d3.select("#map-zoom-viewport-r")
            .style("aspect-ratio", null)
            .style("height", `${mapCompareH}px`);

          if (bboxL) {
            d3.select("#wms-img-l").attr("width", mapW).attr("height", hL);
            updateMap("l", buildWmsUrl(bboxL, dateStr, mapW, hL), keepL);
          }
          if (bboxR) {
            d3.select("#wms-img-r").attr("width", mapW).attr("height", hR);
            updateMap("r", buildWmsUrl(bboxR, dateStr, mapW, hR), keepR);
          }
          prevMapZoomCtx.l = bboxL ? keyL : null;
          prevMapZoomCtx.r = bboxR ? keyR : null;

          renderStats(rowHasDecodeMetrics(rowL) ? rowL : null, "#stats-l");
          renderStats(rowHasDecodeMetrics(rowR) ? rowR : null, "#stats-r");
          renderShareBar(rowHasDecodeMetrics(rowL) ? rowL : null, "#share-bar-l");
          renderShareBar(rowHasDecodeMetrics(rowR) ? rowR : null, "#share-bar-r");

          const rowsL = byRegion.get(nameL) || [];
          const rowsR = byRegion.get(nameR) || [];
          renderNdviTwoRegionCompare(rowsL, rowsR, nameL, nameR, vizYear, vizMonth, same);
          d3.select("#share-year-note").text(NDVI_CHART_NOTE_OPEN);

          const pfMonths = [];
          if (vizMonth < 12) pfMonths.push(vizMonth + 1);
          if (vizMonth > 1) pfMonths.push(vizMonth - 1);
          setTimeout(() => {
            for (const m of pfMonths) {
              if (bboxL) prefetchTileUrl(buildWmsUrl(bboxL, dateKey(vizYear, m), mapW, hL));
              if (bboxR) prefetchTileUrl(buildWmsUrl(bboxR, dateKey(vizYear, m), mapW, hR));
            }
          }, 0);
        } else {
          mainGridSel.style("--map-compare-h", null);
          d3.select("#map-zoom-viewport-l").style("aspect-ratio", null).style("height", null);
          d3.select("#map-zoom-viewport-r").style("aspect-ratio", null).style("height", null);
          updateReadoutSingle(nameL, vizYear, vizMonth, rowL);
          const monthLab = d3.timeFormat("%B %Y")(calendarDate(vizYear, vizMonth));
          d3.select("#stress-panel-title-l").text(`${nameL} Stress assessment — ${monthLab}`);
          d3.select("#map-title-left").text(nameL);

          if (bboxL) {
            const hL = mapHeightForBbox(bboxL, mapW);
            const keyL = mapZoomCtxKey(false, nameL, vizYear, mapW, hL, bboxL);
            const keepL = !!keyL && mapImageReady.l && prevMapZoomCtx.l === keyL;
            d3.select("#map-zoom-viewport-l").style("height", null).style("aspect-ratio", `${mapW} / ${hL}`);
            d3.select("#wms-img-l").attr("width", mapW).attr("height", hL);
            updateMap("l", buildWmsUrl(bboxL, dateStr, mapW, hL), keepL);
            prevMapZoomCtx.l = keyL;

            const pfMonths = [];
            if (vizMonth < 12) pfMonths.push(vizMonth + 1);
            if (vizMonth > 1) pfMonths.push(vizMonth - 1);
            setTimeout(() => {
              for (const m of pfMonths) {
                prefetchTileUrl(buildWmsUrl(bboxL, dateKey(vizYear, m), mapW, hL));
              }
            }, 0);
          } else {
            d3.select("#map-zoom-viewport-l").style("aspect-ratio", null).style("height", null);
            prevMapZoomCtx.l = null;
          }
          prevMapZoomCtx.r = null;

          renderStats(rowHasDecodeMetrics(rowL) ? rowL : null, "#stats-l");
          renderShareBar(rowHasDecodeMetrics(rowL) ? rowL : null, "#share-bar-l");
          d3.select("#stats-r").selectAll("*").remove();
          d3.select("#share-bar-r").selectAll("*").remove();

          const rowsL = byRegion.get(nameL) || [];
          renderNdviYearVsBaseline(rowsL, nameL, vizYear, vizMonth);
          d3.select("#share-year-note").text(NDVI_CHART_NOTE_OPEN);
        }

        d3.select("#share-year-title").text(
          `${vizYear} NDVI compared to the same-month average since ${DATA_FIRST_YEAR}`
        );
        d3.select("#btn-play").text(`▶ Play From January (${vizYear})`);
        moveScrubberKnob(vizMonth);
        syncPlayButtons();
        requestAnimationFrame(() => {
          resizeMapZoomExtent("l");
          resizeMapZoomExtent("r");
        });
      }

      function onRegionOrYearChange() {
        pausedMidPlayback = false;
        stopPlay();
        ensureDistinctRegions();
        buildMonthScrubber();
        refresh();
      }

      function onViewModeChange() {
        pausedMidPlayback = false;
        stopPlay();
        ensureDistinctRegions();
        buildMonthScrubber();
        refresh();
      }

      yearSelect.property("value", String(defaultYear));
      vizYear = defaultYear;

      const animHost = d3.select("#anim-controls");
      animHost.selectAll("*").remove();
      animHost
        .append("button")
        .attr("type", "button")
        .attr("id", "btn-play")
        .text("▶ Play From January (…)")
        .on("click", startPlayFromJanuary);
      animHost
        .append("button")
        .attr("type", "button")
        .attr("id", "btn-pause")
        .text("Pause")
        .property("disabled", true)
        .on("click", () => {
          if (playTimer) pausedMidPlayback = true;
          stopPlay();
        });
      animHost
        .append("button")
        .attr("type", "button")
        .attr("id", "btn-resume")
        .text("Resume")
        .property("disabled", true)
        .on("click", startResume);

      regionLeft.on("change", onRegionOrYearChange);
      regionRight.on("change", onRegionOrYearChange);
      viewMode.on("change", onViewModeChange);

      yearSelect.on("change", () => {
        vizMonth = 1;
        onRegionOrYearChange();
      });

      applyViewModeLayout();
      buildMonthScrubber();
      refresh();
      requestAnimationFrame(() => {
        requestAnimationFrame(installMapZoomAfterLayout);
      });
    })
    .catch((e) => {
      showError("Could not load " + DATA_URL + ": " + (e && e.message ? e.message : String(e)));
    });
})();
