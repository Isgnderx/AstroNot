// Forced Spectrophotometry: the spectrum plot, drawn as inline SVG without a charting library. DOM only: the axis ticks are the
// Spectrum Lab axes (AstroNotSpectrum.computeAxis and formatNumber in tools/spectrum-csv.js) and the flag names come from
// tools/forced-phot.js. The page's UI module (tools/forced-spectrophotometry.js) owns the selection: it calls select() when a
// table row is chosen, and this module calls onSelect(index) when a point is clicked or reached with the keyboard.
(function (root) {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  // Spectrum Lab's six plot colours, one per SPHEREx detector (1–6), and its marker shapes, one per target.
  const palette = ["#7fb4ff", "#ffb454", "#6fd3a6", "#f08bc0", "#c3a6ff", "#e8e45f"];
  const shapes = ["circle", "square", "diamond", "triangle", "down"];
  const glyphs = { circle: "●", square: "■", diamond: "◆", triangle: "▲", down: "▼" };
  const margin = { left: 80, right: 16, top: 14, bottom: 50 };
  const colors = { background: "#060709", ink: "#dce0e8", muted: "#a9b1be", grid: "#252a32", frame: "#5b6270", zero: "#8a93a3" };
  const hollowFlags = ["CONTAINS_BAD_PIXEL", "FIT_ERROR"]; // the fit's own quality bits (32 and 33); SOURCE is set on every target
  const pickRadius = 18;
  const maxListed = 30;

  function node(tag, attributes = {}, text) {
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function html(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    element.append(...children);
    return element;
  }

  const number = (value, digits = 5) => (Number.isFinite(value) ? AstroNotSpectrum.formatNumber(value, digits) : "NaN");
  const errorOf = (row) => (Number.isFinite(row.flux_err) && row.flux_err > 0 ? row.flux_err : null);
  const colorOf = (row) => palette[(Number(row.det_id) - 1 + palette.length) % palette.length] ?? colors.ink;
  const isHollow = (row) => AstroNotForcedPhot.flagNames(row.flags).some((name) => hollowFlags.includes(name));

  function markerPath(shape, x, y, r) {
    const f = (value) => Number(value.toFixed(2));
    if (shape === "circle") return "M" + f(x - r) + " " + f(y) + "a" + r + " " + r + " 0 1 0 " + f(2 * r) + " 0a" + r + " " + r + " 0 1 0 " + f(-2 * r) + " 0Z";
    if (shape === "square") { const s = r * 0.9; return "M" + f(x - s) + " " + f(y - s) + "h" + f(2 * s) + "v" + f(2 * s) + "h" + f(-2 * s) + "Z"; }
    if (shape === "diamond") { const s = r * 1.25; return "M" + f(x) + " " + f(y - s) + "L" + f(x + s) + " " + f(y) + "L" + f(x) + " " + f(y + s) + "L" + f(x - s) + " " + f(y) + "Z"; }
    const sign = shape === "down" ? -1 : 1;
    return "M" + f(x) + " " + f(y - sign * r * 1.15) + "L" + f(x + r * 1.1) + " " + f(y + sign * r * 0.85) + "L" + f(x - r * 1.1) + " " + f(y + sign * r * 0.85) + "Z";
  }

  function create({ figure, onSelect }) {
    const q = (name) => figure.querySelector("[data-fs-" + name + "]");
    const el = {
      chart: q("chart"), summary: q("plot-summary"), legend: q("legend"), notDrawn: q("not-drawn"), notDrawnText: q("not-drawn-text"),
      notDrawnDetails: q("not-drawn-details"), notDrawnList: q("not-drawn-list"), live: q("plot-live"),
      scales: [...figure.querySelectorAll("[data-fs-yscale]")],
    };
    const state = { rows: null, yScale: "linear", selected: null, drawn: [], order: [], ring: null, svg: null, width: 0 };

    // ---- Drawing -------------------------------------------------------------------------------------------------------------
    function render(rows, selected = null) {
      state.rows = rows && rows.length ? rows : null;
      state.selected = selected;
      draw();
    }

    function draw() {
      const rows = state.rows;
      state.drawn = [];
      state.order = [];
      state.ring = null;
      state.svg = null;
      if (!rows) {
        el.chart.replaceChildren();
        el.summary.textContent = "";
        el.legend.replaceChildren();
        el.notDrawn.hidden = true;
        return;
      }
      const logY = state.yScale === "log";
      const entries = rows.map((row, index) => ({ row, index }));
      const unusable = entries.filter(({ row }) => !Number.isFinite(row.lambda) || !Number.isFinite(row.flux));
      const usable = entries.filter(({ row }) => Number.isFinite(row.lambda) && Number.isFinite(row.flux));
      const dropped = logY ? usable.filter(({ row }) => !(row.flux > 0)) : [];
      const drawable = logY ? usable.filter(({ row }) => row.flux > 0) : usable;
      const clipped = logY ? drawable.filter(({ row }) => errorOf(row) !== null && row.flux - errorOf(row) <= 0) : [];
      renderLegend(rows);
      renderNotDrawn(rows.length, unusable, dropped, clipped);

      const hollow = drawable.filter(({ row }) => isHollow(row)).length;
      if (!drawable.length) {
        el.chart.replaceChildren(html("p", { class: "fs-chart__empty" }, logY && usable.length
          ? "None of these points has a positive flux, so none can be placed on a logarithmic flux axis. Switch the flux axis to Linear to see them."
          : "No point has a finite wavelength and flux, so nothing can be drawn."));
        el.summary.textContent = "Points drawn: 0 of " + rows.length + ".";
        return;
      }

      const width = Math.max(300, Math.round(el.chart.clientWidth || 720));
      const height = Math.round(Math.min(440, Math.max(260, width * 0.56)));
      state.width = width;
      const waves = drawable.map(({ row }) => row.lambda);
      const xAxis = AstroNotSpectrum.computeAxis(Math.min(...waves), Math.max(...waves), "linear");
      let yLow = Infinity;
      let yHigh = -Infinity;
      for (const { row } of drawable) {
        const error = errorOf(row) ?? 0;
        yLow = Math.min(yLow, logY ? (row.flux - error > 0 ? row.flux - error : row.flux) : row.flux - error);
        yHigh = Math.max(yHigh, row.flux + error);
      }
      const yAxis = AstroNotSpectrum.computeAxis(yLow, yHigh, state.yScale);
      const plot = { x: margin.left, y: margin.top, w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
      const sx = (value) => plot.x + ((value - xAxis.min) / (xAxis.max - xAxis.min)) * plot.w;
      const sy = (value) => plot.y + plot.h - (logY
        ? (Math.log(value) - Math.log(yAxis.min)) / (Math.log(yAxis.max) - Math.log(yAxis.min))
        : (value - yAxis.min) / (yAxis.max - yAxis.min)) * plot.h;
      const clampY = (value) => Math.min(plot.y + plot.h, Math.max(plot.y, value));
      const round = (value) => Number(value.toFixed(2));

      const svg = node("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-labelledby": "fs-plot-summary", class: "fs-chart__svg" });
      svg.append(node("rect", { x: 0, y: 0, width, height, fill: colors.background }));
      const axes = node("g", { "font-size": 12, fill: colors.muted });
      for (const tick of yAxis.ticks) {
        const y = Math.round(sy(tick.value)) + 0.5;
        if (y < plot.y - 1 || y > plot.y + plot.h + 1) continue;
        axes.append(node("line", { x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y, stroke: colors.grid }));
        axes.append(node("text", { x: plot.x - 8, y, "text-anchor": "end", "dominant-baseline": "middle" }, tick.label));
      }
      let lastRight = -Infinity;
      for (const tick of xAxis.ticks) {
        const x = Math.round(sx(tick.value)) + 0.5;
        if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
        axes.append(node("line", { x1: x, x2: x, y1: plot.y, y2: plot.y + plot.h, stroke: colors.grid }));
        const half = tick.label.length * 3.6; // about half the label width at 12 px
        if (x - half > lastRight + 6) {
          axes.append(node("text", { x, y: plot.y + plot.h + 18, "text-anchor": "middle" }, tick.label));
          lastRight = x + half;
        }
      }
      axes.append(node("rect", { x: plot.x + 0.5, y: plot.y + 0.5, width: plot.w, height: plot.h, fill: "none", stroke: colors.frame }));
      if (!logY && yAxis.min < 0 && yAxis.max > 0) {
        const zero = Math.round(sy(0)) + 0.5;
        axes.append(node("line", { x1: plot.x, x2: plot.x + plot.w, y1: zero, y2: zero, stroke: colors.zero, "stroke-dasharray": "5 4" }));
      }
      axes.append(node("text", { x: plot.x + plot.w / 2, y: height - 10, "text-anchor": "middle", fill: colors.ink }, "Wavelength (μm)"));
      axes.append(node("text", { transform: "translate(14 " + (plot.y + plot.h / 2) + ") rotate(-90)", "text-anchor": "middle", "dominant-baseline": "middle", fill: colors.ink },
        logY ? "Flux density (μJy), log scale" : "Flux density (μJy)"));
      svg.append(axes);

      const clipId = "fs-plot-clip";
      const clip = node("clipPath", { id: clipId });
      clip.append(node("rect", { x: plot.x, y: plot.y, width: plot.w, height: plot.h }));
      svg.append(node("defs"));
      svg.lastChild.append(clip);
      const data = node("g", { "clip-path": "url(#" + clipId + ")" });

      // Error bars (flux_err, ±1σ), one path per detector. On the log axis a bar reaching zero or below is cut at the bottom, uncapped.
      const bars = new Map();
      for (const { row } of drawable) {
        const error = errorOf(row);
        if (error === null) continue;
        const x = round(sx(row.lambda));
        const top = round(clampY(sy(row.flux + error)));
        const cut = logY && row.flux - error <= 0;
        const bottom = round(clampY(sy(cut ? yAxis.min : row.flux - error)));
        const color = colorOf(row);
        const path = (bars.get(color) ?? "") + "M" + x + " " + top + "V" + bottom + "M" + (x - 3) + " " + top + "h6" + (cut ? "" : "M" + (x - 3) + " " + bottom + "h6");
        bars.set(color, path);
      }
      for (const [color, d] of bars) data.append(node("path", { d, stroke: color, "stroke-opacity": 0.8, "stroke-width": 1.4, fill: "none" }));

      // Markers: one group per target label (its own shape), colour by detector, hollow when CONTAINS_BAD_PIXEL or FIT_ERROR is set.
      const labels = targetLabels(rows);
      const groups = new Map(labels.map((label) => [label, node("g", { "data-label": label })]));
      for (const { row, index } of drawable) {
        const x = sx(row.lambda);
        const y = sy(row.flux);
        const shape = shapes[labels.indexOf(row.label) % shapes.length];
        const color = colorOf(row);
        const attributes = isHollow(row)
          ? { d: markerPath(shape, x, y, 3.6), fill: colors.background, stroke: color, "stroke-width": 1.6 }
          : { d: markerPath(shape, x, y, 3.6), fill: color };
        groups.get(row.label).append(node("path", attributes));
        state.drawn.push({ index, x, y, lambda: row.lambda });
      }
      for (const group of groups.values()) data.append(group);
      state.ring = node("circle", { r: 9, fill: "none", stroke: "#ffffff", "stroke-width": 2, visibility: "hidden" });
      data.append(state.ring);
      svg.append(data);
      el.chart.replaceChildren(svg);
      state.svg = svg;
      state.order = [...state.drawn].sort((a, b) => a.lambda - b.lambda || a.index - b.index);
      placeRing();

      const flux = drawable.map(({ row }) => row.flux);
      el.summary.textContent = "Points drawn: " + drawable.length + " of " + rows.length + ". Wavelength " + number(Math.min(...waves)) + " to " + number(Math.max(...waves)) +
        " μm, flux " + number(Math.min(...flux)) + " to " + number(Math.max(...flux)) + " μJy" + (logY ? " (log flux axis)" : "") + ". Hollow markers: " + hollow + ".";
    }

    function targetLabels(rows) {
      return [...new Set(rows.map((row) => row.label))];
    }

    function renderLegend(rows) {
      const detectors = new Map();
      const targets = new Map();
      for (const row of rows) {
        detectors.set(row.det_id, (detectors.get(row.det_id) ?? 0) + 1);
        targets.set(row.label, (targets.get(row.label) ?? 0) + 1);
      }
      const count = (n) => (n === 1 ? "1 point" : n + " points");
      const items = [...detectors].sort((a, b) => a[0] - b[0]).map(([detector, n]) =>
        html("li", {}, html("span", { class: "fs-swatch", "aria-hidden": "true", style: "color:" + colorOf({ det_id: detector }) }, "■"), html("span", {}, "Detector " + detector + " — " + count(n))));
      const labels = targetLabels(rows);
      for (const [label, n] of targets) {
        const glyph = glyphs[shapes[labels.indexOf(label) % shapes.length]];
        items.push(html("li", {}, html("span", { class: "fs-swatch", "aria-hidden": "true" }, glyph), html("span", { translate: "no" }, label), html("span", {}, "— " + count(n))));
      }
      items.push(html("li", {}, html("span", { class: "fs-swatch", "aria-hidden": "true" }, "○"), html("span", {}, "Hollow marker: CONTAINS_BAD_PIXEL or FIT_ERROR is set")));
      if (labels.length > shapes.length) items.push(html("li", {}, html("span", {}, "Marker shapes repeat after five targets.")));
      el.legend.replaceChildren(...items);
    }

    function renderNotDrawn(total, unusable, dropped, clipped) {
      const parts = [];
      if (dropped.length) {
        parts.push(dropped.length === 1
          ? "1 of the " + total + " points has a flux of zero or below, which a logarithmic axis cannot show. It is not drawn, but stays in the table. Switch the flux axis to Linear to see it."
          : dropped.length + " of the " + total + " points have a flux of zero or below, which a logarithmic axis cannot show. They are not drawn, but stay in the table. Switch the flux axis to Linear to see them.");
      }
      if (unusable.length) {
        parts.push(unusable.length === 1
          ? "1 point has no finite flux or wavelength (a failed fit) and is not drawn on either axis; it stays in the table."
          : unusable.length + " points have no finite flux or wavelength (a failed fit) and are not drawn on either axis; they stay in the table.");
      }
      if (clipped.length) {
        // Spectrum Lab's sentence, word for word.
        const one = clipped.length === 1;
        parts.push(clipped.length + (one ? " error bar reaches" : " error bars reach") + " zero or below; the lower end is cut at the bottom of the plot and has no cap.");
      }
      el.notDrawn.hidden = parts.length === 0;
      el.notDrawnText.textContent = parts.join(" ");
      const missing = [...dropped, ...unusable].sort((a, b) => a.index - b.index);
      el.notDrawnDetails.hidden = missing.length === 0;
      const shown = missing.slice(0, maxListed);
      el.notDrawnList.replaceChildren(...shown.map(({ row }) => html("li", {}, html("span", { translate: "no" }, row.label),
        html("span", {}, ", detector " + row.det_id + ": " + number(row.lambda) + " μm, flux " + number(row.flux) + " μJy"))));
      if (missing.length > shown.length) el.notDrawnList.append(html("li", {}, "… and " + (missing.length - shown.length) + " more (see the table)."));
    }

    // ---- Selection ---------------------------------------------------------------------------------------------------------
    function placeRing() {
      if (!state.ring) return;
      const point = state.drawn.find((entry) => entry.index === state.selected);
      if (!point) {
        state.ring.setAttribute("visibility", "hidden");
        return;
      }
      state.ring.setAttribute("cx", point.x.toFixed(2));
      state.ring.setAttribute("cy", point.y.toFixed(2));
      state.ring.setAttribute("visibility", "visible");
      state.ring.parentNode.append(state.ring); // drawn last, above every marker
    }

    // Show index as selected (null clears). announce: say what it is in the live region (used when the plot made the choice).
    function select(index, { announce = false } = {}) {
      state.selected = index;
      placeRing();
      if (!announce || !state.rows || index === null) return;
      const row = state.rows[index];
      const error = errorOf(row);
      const flags = AstroNotForcedPhot.flagNames(row.flags);
      const text = ", detector " + row.det_id + ": " + number(row.lambda) + " μm, flux " + number(row.flux) + (error === null ? "" : " ± " + number(error, 3)) + " μJy" +
        (flags.length ? ", flags " + flags.join(", ") : "") + ".";
      const parts = [html("span", { translate: "no" }, row.label), html("span", {}, text)];
      if (!state.drawn.some((entry) => entry.index === index)) parts.push(html("span", {}, " This point is not drawn on the current flux axis."));
      el.live.replaceChildren(...parts);
    }

    function pick(index) {
      select(index, { announce: true });
      onSelect(index);
    }

    function nearest(x, y) {
      let best = null;
      let bestDistance = pickRadius * pickRadius;
      for (const entry of state.drawn) {
        const distance = (entry.x - x) ** 2 + (entry.y - y) ** 2;
        if (distance <= bestDistance) {
          best = entry;
          bestDistance = distance;
        }
      }
      return best;
    }

    el.chart.addEventListener("click", (event) => {
      if (!state.svg) return;
      const matrix = state.svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const hit = nearest(point.x, point.y);
      if (hit) pick(hit.index);
    });

    el.chart.addEventListener("keydown", (event) => {
      if (!state.order.length || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const at = state.order.findIndex((entry) => entry.index === state.selected);
      let next;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = state.order.length - 1;
      else if (at < 0) next = event.key === "ArrowRight" ? 0 : state.order.length - 1;
      else next = Math.min(state.order.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)));
      pick(state.order[next].index);
    });

    for (const button of el.scales) {
      button.addEventListener("click", () => {
        state.yScale = button.dataset.fsYscale;
        for (const other of el.scales) other.setAttribute("aria-pressed", String(other === button));
        draw();
      });
    }

    // Redraw at the new width so the 12 px labels stay 12 px on a phone; the SVG also scales with its viewBox in between.
    if (typeof ResizeObserver === "function") {
      let frame = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (state.rows && el.chart.clientWidth && Math.abs(el.chart.clientWidth - state.width) > 2) draw();
        });
      }).observe(el.chart);
    }

    return { render, select };
  }

  root.AstroNotForcedSpectrumPlot = { create, palette, hollowFlags };
})(typeof globalThis === "object" ? globalThis : this);
