// Download a paginated report of the current tool view, without uploading any data.
(() => {
  "use strict";

  const pageWidth = 595;
  const pageHeight = 842;
  const rasterScale = 2;
  const margin = 42;
  const lineWidth = pageWidth - 2 * margin;
  const rowsPerTable = 24;
  const encoder = new TextEncoder();
  const translate = (text) => window.AstroNotLanguage?.translate(text) ?? text;
  const clean = (text) => (text ?? "").trim().replace(/\s+/g, " ");
  const textOf = (node) => clean(node.innerText || node.textContent);
  const available = (node) => !node.closest("[hidden]");
  const tableLimit = (total) => translate("Showing " + rowsPerTable + " of " + total + " rows in this report.");

  function tableBlocks(table) {
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? [], textOf);
    const rows = [...table.tBodies].flatMap((body) => [...body.rows]).filter(available);
    if (!rows.length) return [];
    const blocks = [{ text: table.caption && textOf(table.caption), strong: true }];
    rows.slice(0, rowsPerTable).forEach((row) => {
      const values = [...row.cells].flatMap((cell, index) => {
        const select = cell.querySelector("select");
        if (cell.querySelector("input") && !select) return [];
        if (cell.tagName !== "TH" && cell.querySelector("button")) return [];
        const value = select ? clean(select.selectedOptions[0]?.textContent) : textOf(cell);
        return value ? [headers[index] ? headers[index] + " " + value : value] : [];
      });
      blocks.push({ text: values.join(" · "), row: true });
    });
    if (rows.length > rowsPerTable) blocks.push({ text: tableLimit(rows.length) });
    return blocks;
  }

  function svgImage(svg) {
    const copy = svg.cloneNode(true);
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const size = svg.viewBox.baseVal;
    copy.setAttribute("width", size.width);
    copy.setAttribute("height", size.height);
    const nodes = [svg, ...svg.querySelectorAll("*")];
    const copies = [copy, ...copy.querySelectorAll("*")];
    nodes.forEach((node, index) => {
      const style = getComputedStyle(node);
      for (const prop of ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight"]) {
        copies[index].style.setProperty(prop, style.getPropertyValue(prop));
      }
    });
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = url;
    return image.decode().then(() => image, () => null).finally(() => URL.revokeObjectURL(url));
  }

  function capture(main) {
    const selector = [
      "h2", "h3", ".workspace-status:not(.workspace-pdf-status)", ".tm-pair__verdict", ".tm-notes li", "[data-pdf-text]",
      "dl.workspace-facts", "table", "canvas", "[data-lc-svg]", "[data-fs-chart] svg", "[data-results-list]",
    ].join(", ");
    const sections = [];
    for (const section of main.querySelectorAll("[data-pdf-section]")) {
      if (!available(section)) continue;
      const blocks = [];
      const unique = new Set();
      for (const node of section.querySelectorAll(selector)) {
        if (!available(node) || node.closest("[data-pdf-section]") !== section || node.closest(".observation-row")) continue;
        if (node.closest("table") && node.tagName !== "TABLE") continue;
        switch (true) {
          case node.tagName === "DL":
            for (const term of node.querySelectorAll("dt")) {
              if (!term.nextElementSibling || !available(term)) continue;
              const value = textOf(term.nextElementSibling);
              if (value && value !== "—") blocks.push({ text: textOf(term) + "  " + value, row: true });
            }
            break;
          case node.tagName === "TABLE":
            blocks.push(...tableBlocks(node));
            break;
          case node instanceof HTMLCanvasElement && node.width > 0 && node.height > 0: {
            const bitmap = document.createElement("canvas");
            const scale = Math.min(1, 1400 / Math.max(node.width, node.height));
            bitmap.width = Math.max(1, Math.round(node.width * scale));
            bitmap.height = Math.max(1, Math.round(node.height * scale));
            bitmap.getContext("2d").drawImage(node, 0, 0, bitmap.width, bitmap.height);
            blocks.push({ image: bitmap });
            break;
          }
          case node instanceof SVGSVGElement:
            if (node.viewBox.baseVal.width > 0) blocks.push({ image: svgImage(node) });
            break;
          case node.matches("[data-results-list]"): {
            const rows = [...node.querySelectorAll(".observation-row summary")];
            rows.slice(0, rowsPerTable).forEach((row) => {
              blocks.push({ text: [...row.children].map(textOf).join(" · "), row: true });
            });
            if (rows.length > rowsPerTable) blocks.push({ text: tableLimit(rows.length) });
            break;
          }
          default: {
            const text = textOf(node);
            if (text && !unique.has(text)) {
              unique.add(text);
              blocks.push({ text, heading: node.matches("h2, h3") });
            }
          }
        }
      }
      if (blocks.some((block) => block.image || (block.text && !block.heading))) sections.push(...blocks);
    }
    return sections;
  }

  function wrapText(context, text) {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? line + " " + word : word;
      if (context.measureText(next).width <= lineWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const char of word) {
        if (context.measureText(line + char).width > lineWidth && line) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function jpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Page encoding failed")), "image/jpeg", 0.9);
    });
  }

  async function renderReport(title, blocks) {
    const pages = [];
    const content = (await Promise.all(blocks.map(async (block) => ({
      ...block,
      image: block.image ? await block.image : null,
    })))).filter((block) => block.image || block.text);
    let canvas;
    let context;
    let y;
    const bottom = pageHeight - 58;

    function finishPage() {
      context.fillStyle = "#425268";
      context.font = "9px system-ui, sans-serif";
      context.fillText("AstroNot", margin, pageHeight - 31);
      context.textAlign = "right";
      context.fillText(String(pages.length + 1), pageWidth - margin, pageHeight - 31);
      pages.push(jpeg(canvas));
    }

    function startPage() {
      canvas = document.createElement("canvas");
      canvas.width = pageWidth * rasterScale;
      canvas.height = pageHeight * rasterScale;
      context = canvas.getContext("2d", { alpha: false });
      context.scale(rasterScale, rasterScale);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, pageWidth, pageHeight);
      context.fillStyle = "#3359a8";
      context.fillRect(margin, 40, 32, 3);
      y = 62;
    }

    function reserve(height) {
      if (y + height <= bottom) return;
      finishPage();
      startPage();
    }

    function drawText(text, size, weight, color, before, after, keepWithNext = 0) {
      if (!text) return;
      const font = weight + " " + size + "px system-ui, sans-serif";
      context.font = font;
      const lines = wrapText(context, text);
      const lineHeight = size * 1.42;
      reserve(Math.min(lines.length * lineHeight, 2 * lineHeight) + before + after + keepWithNext);
      y += before;
      for (const line of lines) {
        reserve(lineHeight);
        context.font = font;
        context.fillStyle = color;
        context.textBaseline = "top";
        context.fillText(line, margin, y);
        y += lineHeight;
      }
      y += after;
    }

    function imageSize(image) {
      const enlarge = Math.max(1, 240 / Math.max(image.width, image.height));
      const ratio = Math.min(lineWidth / image.width, 305 / image.height, enlarge);
      return { width: image.width * ratio, height: image.height * ratio };
    }

    startPage();
    drawText(title, 25, 700, "#14233b", 0, 12);
    content.forEach((block, index) => {
      if (block.image) {
        const { width, height } = imageSize(block.image);
        reserve(height + 12);
        context.fillStyle = "#0b1018";
        context.fillRect(margin, y, width, height);
        context.drawImage(block.image, margin, y, width, height);
        y += height + 12;
      } else if (block.heading) {
        const next = content[index + 1];
        const keepWithNext = next?.image ? imageSize(next.image).height + 12 : 36;
        drawText(block.text, 15, 650, "#14233b", 10, 5, keepWithNext);
      } else {
        drawText(block.text, 10.5, block.strong ? 650 : 400, "#25364c", 0, block.row ? 3 : 7);
      }
    });
    finishPage();
    return Promise.all(pages);
  }

  // PDF objects contain one JPEG per A4 page. The byte offsets include the binary streams.
  function makePdf(pages) {
    const chunks = [];
    const offsets = [0];
    let bytes = 0;
    function append(value) {
      const part = typeof value === "string" ? encoder.encode(value) : value;
      chunks.push(part);
      bytes += part.byteLength ?? part.size;
    }
    function object(id, fields, stream) {
      offsets[id] = bytes;
      append(id + " 0 obj\n" + fields);
      if (stream) {
        append("\nstream\n");
        append(stream);
        append("\nendstream");
      }
      append("\nendobj\n");
    }
    append("%PDF-1.4\n%âãÏÓ\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = pages.map((_, index) => (3 + 3 * index) + " 0 R");
    object(2, "<< /Type /Pages /Count " + pages.length + " /Kids [" + kids.join(" ") + "] >>");
    pages.forEach((image, index) => {
      const id = 3 + 3 * index;
      const operations = encoder.encode("q\n" + pageWidth + " 0 0 " + pageHeight + " 0 0 cm\n/Im Do\nQ\n");
      object(id, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pageWidth + " " + pageHeight + "] /Resources << /XObject << /Im " +
        (id + 1) + " 0 R >> >> /Contents " + (id + 2) + " 0 R >>");
      object(id + 1, "<< /Type /XObject /Subtype /Image /Width " + pageWidth * rasterScale + " /Height " + pageHeight * rasterScale + " /ColorSpace /DeviceRGB " +
        "/BitsPerComponent 8 /Filter /DCTDecode /Length " + image.size + " >>", image);
      object(id + 2, "<< /Length " + operations.byteLength + " >>", operations);
    });
    const start = bytes;
    append("xref\n0 " + offsets.length + "\n0000000000 65535 f \n");
    for (const offset of offsets.slice(1)) append(String(offset).padStart(10, "0") + " 00000 n \n");
    append("trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF\n");
    return new Blob(chunks, { type: "application/pdf" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = document.querySelector("main[data-pdf-ready]");
    const heading = main?.querySelector("[data-pdf-heading]");
    if (!heading) return;

    const button = document.createElement("button");
    button.className = "workspace-button workspace-pdf-button";
    button.type = "button";
    button.textContent = translate("Download PDF");
    button.hidden = true;
    const status = document.createElement("p");
    status.className = "workspace-status workspace-pdf-status";
    status.setAttribute("role", "status");
    let bar = heading.parentElement;
    if (!bar.matches(".tm-slot__head")) {
      bar = document.createElement("div");
      heading.before(bar);
      bar.append(heading);
    }
    bar.classList.add("workspace-pdf-bar");
    bar.append(button);
    bar.after(status);

    function refresh() {
      const ready = [...main.querySelectorAll(main.dataset.pdfReady)].some(available);
      if (button.hidden === ready) button.hidden = !ready;
      if (!ready && status.textContent) status.textContent = "";
    }
    const observer = new MutationObserver(refresh);
    observer.observe(main, { attributes: true, attributeFilter: ["hidden", "disabled", "data-state", "data-image-ready"], childList: true, subtree: true });
    refresh();
    window.addEventListener("astronot-languagechange", () => {
      button.textContent = translate("Download PDF");
    });

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.removeAttribute("data-error");
      status.textContent = translate("Preparing PDF…");
      try {
        const title = textOf(main.querySelector("[data-workspace-title]"));
        const pages = await renderReport(title, capture(main));
        const url = URL.createObjectURL(makePdf(pages));
        const link = document.createElement("a");
        link.href = url;
        link.download = "astronot-" + location.pathname.split("/").filter(Boolean).filter((part) => !part.endsWith(".html")).at(-1) + ".pdf";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = "";
      } catch {
        status.setAttribute("data-error", "");
        status.textContent = translate("The PDF could not be created. Try again.");
      } finally {
        button.disabled = false;
      }
    });
  });
})();
