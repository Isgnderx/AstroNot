// Catalog Cross-Match: matches the positions in one local CSV (your sources) against a catalog extract CSV. All matching,
// coordinate, epoch and export logic is in tools/xmatch.js (DOM-free, tested by tests/cross-match.test.mjs); CSV cells are split by
// parseCsv() from tools/observation-csv.js. This file is the user interface only.
//
// State rule: any change to a file, a column choice, a unit, an epoch or the radius clears the result, so a table on screen
// always belongs to the inputs shown. Text from files (IDs, names) is only ever put on the page with textContent.
(function () {
  "use strict";

  const X = AstroNotXmatch;
  X.setCsvParser(parseCsv);

  const query = (name, scope = document) => scope.querySelector("[data-xm-" + name + "]");
  const maxFileBytes = 120 * 1024 * 1024;
  const pageSize = 100;
  const arrow = "→";

  const el = {
    example: query("example"), exampleStatus: query("example-status"),
    srcFile: query("src-file"), srcLabel: query("src-file-label"), srcStatus: query("src-status"), srcFields: query("src-fields"),
    srcId: query("src-id"), srcRa: query("src-ra"), srcDec: query("src-dec"), srcUnit: query("src-unit"),
    srcEpoch: query("src-epoch"), srcEpochUnit: query("src-epoch-unit"), srcHint: query("src-hint"), srcFacts: query("src-facts"),
    catFile: query("cat-file"), catLabel: query("cat-file-label"), catStatus: query("cat-status"), catNote: query("cat-note"), catFields: query("cat-fields"),
    catName: query("cat-name"), catRelease: query("cat-release"), catId: query("cat-id"), catRa: query("cat-ra"), catDec: query("cat-dec"), catUnit: query("cat-unit"),
    catPmra: query("cat-pmra"), catPmdec: query("cat-pmdec"), catPmconv: query("cat-pmconv"), catEpoch: query("cat-epoch"),
    catEpochUnit: query("cat-epoch-unit"), catFixedEpoch: query("cat-fixed-epoch"),
    coverage: query("cat-coverage"), covRa: query("cov-ra"), covDec: query("cov-dec"), covRadius: query("cov-radius"), covLimit: query("cov-limit"),
    catFacts: query("cat-facts"),
    irsaTable: query("irsa-table"), irsaRa: query("irsa-ra"), irsaDec: query("irsa-dec"), irsaRadius: query("irsa-radius"), irsaLimit: query("irsa-limit"),
    irsaLink: query("irsa-link"), irsaFill: query("irsa-fill"), irsaStatus: query("irsa-status"), irsaAdql: query("irsa-adql"),
    radius: query("radius"), epochMode: query("epoch-mode"), targetWrap: query("target-wrap"), target: query("target-epoch"),
    targetUnitWrap: query("target-unit-wrap"), targetUnit: query("target-unit"), settingsNote: query("settings-note"),
    run: query("run"), useSourceEpoch: query("use-source-epoch"), runStatus: query("run-status"),
    verdict: query("verdict"), notes: query("notes"), summary: query("summary"),
    tablebar: query("tablebar"), filter: query("filter"), prev: query("prev"), next: query("next"), pageLabel: query("page-label"),
    tableWrap: query("table-wrap"), rows: query("rows"), tableNote: query("table-note"),
    detail: query("detail"), detailTitle: query("detail-title"), detailNote: query("detail-note"), detailCaption: query("detail-caption"), detailRows: query("detail-rows"),
    download: query("download"), sheet: query("sheet"), exportStatus: query("export-status"),
  };
  const setFact = (prefix, name, text) => { document.querySelector("[data-xm-" + prefix + "-fact='" + name + "']").textContent = text; };
  const summaryFact = (name) => document.querySelector("[data-xm-fact='" + name + "']");

  const state = { version: 0, irsaQuery: null, src: null, cat: null, result: null, filter: "all", page: 0, selected: -1, lastRequest: null, exampleScript: null };

  // ---- Small helpers --------------------------------------------------------------------------------------------------
  const plural = (n, one, many = one + "s") => n.toLocaleString("en-US") + " " + (n === 1 ? one : many);
  const disabled = (button, off) => button.setAttribute("aria-disabled", String(off));
  const isDisabled = (button) => button.getAttribute("aria-disabled") === "true";
  const degreeText = (value) => value.toFixed(8);
  const epochText = (value) => (Number.isFinite(value) ? String(Number(value.toFixed(4))) : "Unavailable");
  const clear = (node) => { node.replaceChildren(); };

  function setStatus(node, text, isError = false) {
    node.textContent = text;
    if (isError) node.setAttribute("data-error", "");
    else node.removeAttribute("data-error");
  }

  function fillSelect(select, header, selected, extra) {
    clear(select);
    for (const [value, label] of extra) select.append(new Option(label, String(value)));
    header.forEach((name, index) => select.append(new Option(name === "" ? "(column " + (index + 1) + ")" : name, String(index))));
    select.value = String(selected);
    if (select.value !== String(selected)) select.value = String(extra[0]?.[0] ?? 0);
  }

  async function readText(file) {
    if (file.size > maxFileBytes) throw new Error(file.name + " is larger than " + Math.round(maxFileBytes / 1048576) + " MB, which this page does not read.");
    return file.text();
  }

  // ---- Result handling: any input change clears it -----------------------------------------------------------------------
  function invalidate(message) {
    state.version++;
    if (state.result) {
      state.result = null;
      state.selected = -1;
      el.verdict.textContent = message ?? "An input changed. Choose Match positions to compute the result again.";
    }
    el.notes.hidden = true;
    el.summary.hidden = true;
    el.tablebar.hidden = true;
    el.tableWrap.hidden = true;
    el.tableNote.hidden = true;
    el.detail.hidden = true;
    disabled(el.download, true);
    el.exportStatus.textContent = "";
    updateRunState();
  }

  function updateRunState() {
    const ready = Boolean(state.src?.data && state.cat?.data);
    disabled(el.run, !ready);
    el.useSourceEpoch.hidden = el.epochMode.value !== "move";
    disabled(el.useSourceEpoch, !sourceEpoch().ok);
    if (!ready) {
      setStatus(el.runStatus, !state.src ? "Load your sources to begin." : !state.src.data ? "Choose the RA and Dec columns of your sources." : !state.cat ? "Load a catalog extract." : "Choose the RA and Dec columns of the catalog.");
    } else if (!state.result) {
      setStatus(el.runStatus, "");
    }
  }

  // ---- Reading epochs and numbers ---------------------------------------------------------------------------------------
  function sourceEpoch() {
    const text = el.srcEpoch.value.trim();
    if (text === "") return { ok: false, empty: true };
    const year = X.parseEpoch(text, el.srcEpochUnit.value);
    return Number.isFinite(year) ? { ok: true, year, text: text + (el.srcEpochUnit.value === "mjd" ? " (MJD)" : " (Julian year)") } : { ok: false, bad: true };
  }

  function fixedCatalogEpoch() {
    const text = el.catFixedEpoch.value.trim();
    if (text === "") return NaN;
    return X.parseEpoch(text, "jyear");
  }

  // ---- Your sources ---------------------------------------------------------------------------------------------------
  function looksSexagesimal(table, column) {
    if (column < 0) return false;
    for (const cells of table.rows.slice(0, 50)) {
      const text = (cells[column] ?? "").trim();
      if (text !== "") return /[:\s]|[hms]/i.test(text) && !/^[+-]?[\d.]+(?:e[+-]?\d+)?$/i.test(text);
    }
    return false;
  }

  async function loadSources(name, text, options = {}) {
    state.src = null;
    const table = X.readCsvTable(text);
    if (!table.ok) {
      el.srcFields.hidden = true;
      el.srcFacts.hidden = true;
      el.srcHint.hidden = true;
      setStatus(el.srcStatus, name + " could not be used. " + table.message, true);
      invalidate();
      return;
    }
    if (table.rows.length === 0) {
      setStatus(el.srcStatus, name + " has a header but no rows.", true);
      invalidate();
      return;
    }
    if (table.rows.length > X.limits.sourceRows) {
      setStatus(el.srcStatus, name + " has " + table.rows.length.toLocaleString("en-US") + " rows. This page matches at most " + X.limits.sourceRows.toLocaleString("en-US") + " sources at a time.", true);
      invalidate();
      return;
    }
    const detected = X.detectSourceColumns(table.header);
    state.src = { name, table, data: null, isExample: Boolean(options.example) };
    fillSelect(el.srcId, table.header, detected.id, [[-1, "(row number)"]]);
    fillSelect(el.srcRa, table.header, detected.ra, [[-1, "Choose…"]]);
    fillSelect(el.srcDec, table.header, detected.dec, [[-1, "Choose…"]]);
    el.srcUnit.value = looksSexagesimal(table, detected.ra) ? "sexagesimal" : "deg";
    el.srcFields.hidden = false;
    el.srcEpoch.value = options.epoch ?? "";
    el.srcEpochUnit.value = "jyear";
    rebuildSources(true);
  }

  function sourceMapping() {
    return { id: Number(el.srcId.value), ra: Number(el.srcRa.value), dec: Number(el.srcDec.value), unit: el.srcUnit.value };
  }

  function rebuildSources(announce = false) {
    const src = state.src;
    if (!src) return;
    const mapping = sourceMapping();
    el.srcHint.hidden = true;
    if (mapping.ra < 0 || mapping.dec < 0) {
      src.data = null;
      el.srcFacts.hidden = true;
      setStatus(el.srcStatus, src.name + ": " + plural(src.table.rows.length, "row") + ". No RA and Dec columns were found by name; choose them below.", true);
      invalidate();
      return;
    }
    if (mapping.ra === mapping.dec) {
      src.data = null;
      el.srcFacts.hidden = true;
      setStatus(el.srcStatus, "RA and Dec must be different columns.", true);
      invalidate();
      return;
    }
    src.data = X.extractSources(src.table, mapping);
    const data = src.data;
    const problems = data.count - data.valid;
    setFactsSource(src);
    if (data.valid === 0) {
      setStatus(el.srcStatus, src.name + ": none of the " + plural(data.count, "row") + " has a valid position. Check the columns and the units.", true);
      el.srcHint.hidden = false;
      el.srcHint.textContent = "First problem (row 1): " + (data.reason[0] ?? "none") + ".";
    } else {
      setStatus(el.srcStatus, (announce ? "Loaded " : "") + src.name + ": " + plural(data.count, "source") + ", " + data.valid.toLocaleString("en-US") + " with a valid position" + (problems ? ", " + problems.toLocaleString("en-US") + " listed as invalid" : "") + ".");
    }
    const hints = [];
    const firstBad = data.reason.findIndex((reason) => reason);
    if (firstBad >= 0) hints.push("First invalid row " + (firstBad + 1) + " (" + data.ids[firstBad] + "): " + data.reason[firstBad] + ".");
    if (data.emptyIds) hints.push(plural(data.emptyIds, "row") + " without an ID are called “row N”.");
    if (data.duplicateIds) hints.push(plural(data.duplicateIds, "row") + " share an ID with another row; rows stay distinct by row number.");
    if (src.table.malformed.length) hints.push(plural(src.table.malformed.length, "row") + " have a different number of fields than the header.");
    if (hints.length && data.valid > 0) {
      el.srcHint.hidden = false;
      el.srcHint.textContent = hints.join(" ");
    } else if (data.valid > 0) {
      el.srcHint.hidden = true;
    }
    invalidate();
    prefillIrsa();
  }

  function setFactsSource(src) {
    const data = src.data;
    el.srcFacts.hidden = false;
    setFact("src", "file", src.name + (src.isExample ? " (example: real AllWISE rows)" : ""));
    setFact("src", "rows", data.count.toLocaleString("en-US"));
    setFact("src", "valid", data.valid.toLocaleString("en-US"));
    const problems = data.count - data.valid;
    setFact("src", "problems", problems ? problems.toLocaleString("en-US") + " (invalid coordinates)" : "None");
    updateSourceEpochFact();
  }

  function updateSourceEpochFact() {
    const epoch = sourceEpoch();
    if (!state.src?.data) return;
    setFact("src", "epoch", epoch.ok ? epoch.text : epoch.bad ? "Not understood: " + el.srcEpoch.value.trim() : "Unavailable (not given; separations then refer to your positions as they are)");
  }

  // ---- Catalog extract ------------------------------------------------------------------------------------------------
  async function loadCatalog(name, text, options = {}) {
    state.cat = null;
    const table = X.readCsvTable(text);
    if (!table.ok) {
      hideCatalog();
      setStatus(el.catStatus, name + " could not be used. " + table.message, true);
      invalidate();
      return;
    }
    if (table.rows.length === 0) {
      hideCatalog();
      setStatus(el.catStatus, name + " has a header but no rows. An empty extract has nothing to match.", true);
      invalidate();
      return;
    }
    if (table.rows.length > X.limits.catalogRows) {
      hideCatalog();
      setStatus(el.catStatus, name + " has " + table.rows.length.toLocaleString("en-US") + " rows. This page reads at most " + X.limits.catalogRows.toLocaleString("en-US") + " catalog rows.", true);
      invalidate();
      return;
    }
    const { columns, info } = X.detectCatalogColumns(table.header, table.rows);
    state.cat = { name, table, data: null, info, isExample: Boolean(options.example), requestNote: "" };
    fillSelect(el.catId, table.header, columns.id, [[-1, "(row number)"]]);
    fillSelect(el.catRa, table.header, columns.ra, [[-1, "Choose…"]]);
    fillSelect(el.catDec, table.header, columns.dec, [[-1, "Choose…"]]);
    fillSelect(el.catPmra, table.header, columns.pmra, [[-1, "(none)"]]);
    fillSelect(el.catPmdec, table.header, columns.pmdec, [[-1, "(none)"]]);
    fillSelect(el.catEpoch, table.header, columns.epoch, [[-1, "(none)"]]);
    el.catUnit.value = looksSexagesimal(table, columns.ra) ? "sexagesimal" : "deg";
    el.catEpochUnit.value = info.epochUnit ?? "jyear";
    el.catPmconv.value = info.pmraIncludesCosDec === true ? "cosdec" : info.pmraIncludesCosDec === false ? "plain" : "";
    el.catFixedEpoch.value = "";

    const meta = table.meta;
    let catalogName = meta.catalog ?? meta.name ?? info.name ?? "";
    let release = meta.release ?? info.release ?? "";
    const coverage = { ra: meta.center_ra ?? "", dec: meta.center_dec ?? "", radius: meta.radius_arcsec ?? meta.radius ?? "", limit: meta.row_limit ?? meta.max_rows ?? "" };
    let requestNote = "";
    const request = state.lastRequest;
    if (request && !coverage.radius && ((request.name === "Gaia" && info.kind === "gaia") || (request.name === "AllWISE Source Catalog" && info.kind === "allwise"))) {
      Object.assign(coverage, { ra: String(request.ra), dec: String(request.dec), radius: String(request.radiusArcsec), limit: String(request.rowLimit) });
      catalogName = catalogName || request.name;
      release = release || request.release;
      requestNote = " Coverage and release were filled in from the IRSA query you opened here; correct them if this file came from somewhere else.";
    }
    el.catName.value = catalogName;
    el.catRelease.value = release;
    el.covRa.value = coverage.ra;
    el.covDec.value = coverage.dec;
    el.covRadius.value = coverage.radius;
    el.covLimit.value = coverage.limit;
    el.catFields.hidden = false;
    el.coverage.hidden = false;
    const notes = [];
    if (info.note) notes.push(info.note);
    if (!release) notes.push("The release is not stored in the file: enter it, for example DR3.");
    if (Object.keys(meta).length) notes.push("File information read from # lines: " + Object.entries(meta).map(([key, value]) => key + " = " + value).join("; ") + ".");
    if (requestNote) notes.push(requestNote.trim());
    el.catNote.hidden = notes.length === 0;
    el.catNote.replaceChildren(...notes.map((note, index) => index ? " " + note : note));
    rebuildCatalog(true);
  }

  function hideCatalog() {
    el.catFields.hidden = true;
    el.coverage.hidden = true;
    el.catFacts.hidden = true;
    el.catNote.hidden = true;
  }

  function catalogMapping() {
    return {
      id: Number(el.catId.value), ra: Number(el.catRa.value), dec: Number(el.catDec.value), unit: el.catUnit.value,
      pmra: Number(el.catPmra.value), pmdec: Number(el.catPmdec.value), epoch: Number(el.catEpoch.value),
      epochUnit: el.catEpochUnit.value, fixedEpoch: fixedCatalogEpoch(),
    };
  }

  function rebuildCatalog(announce = false) {
    const cat = state.cat;
    if (!cat) return;
    const mapping = catalogMapping();
    if (mapping.ra < 0 || mapping.dec < 0 || mapping.ra === mapping.dec) {
      cat.data = null;
      el.catFacts.hidden = true;
      setStatus(el.catStatus, cat.name + ": " + plural(cat.table.rows.length, "row") + ". Choose two different RA and Dec columns.", true);
      invalidate();
      return;
    }
    cat.data = X.extractCatalog(cat.table, mapping);
    const data = cat.data;
    const problems = data.count - data.valid;
    el.catFacts.hidden = false;
    setFact("cat", "file", cat.name + (cat.isExample ? " (example: real Gaia DR3 rows)" : ""));
    setFact("cat", "rows", data.count.toLocaleString("en-US"));
    setFact("cat", "valid", data.valid.toLocaleString("en-US"));
    setFact("cat", "problems", problems ? problems.toLocaleString("en-US") + " (invalid coordinates, never matched)" : "None");
    setFact("cat", "epoch", catalogEpochText(data, mapping));
    setFact("cat", "motion", mapping.pmra >= 0 && mapping.pmdec >= 0
      ? data.pmUsable.toLocaleString("en-US") + " of " + data.valid.toLocaleString("en-US") + " valid rows have both components; convention: " + (el.catPmconv.value === "cosdec" ? "pmra includes cos(Dec)" : el.catPmconv.value === "plain" ? "plain dα/dt" : "not chosen")
      : "Unavailable (no proper motion columns chosen)");
    updateCoverageFact();
    if (data.valid === 0) setStatus(el.catStatus, cat.name + ": none of the " + plural(data.count, "row") + " has a valid position. Check the columns and the units.", true);
    else setStatus(el.catStatus, (announce ? "Loaded " : "") + cat.name + ": " + plural(data.count, "catalog row") + ", " + data.valid.toLocaleString("en-US") + " with a valid position" + (problems ? ", " + problems.toLocaleString("en-US") + " invalid" : "") + ".");
    if (state.result) invalidate();
    else updateRunState();
  }

  function catalogEpochText(data, mapping) {
    if (!data.epochKnown) {
      if (mapping.epoch >= 0) return "Unavailable: the epoch column holds no valid values for the unit chosen";
      return "Unavailable (no epoch column or fixed epoch); proper motion cannot be applied";
    }
    const span = data.epochMin === data.epochMax ? epochText(data.epochMin) : epochText(data.epochMin) + " to " + epochText(data.epochMax) + " (per row)";
    return span + " Julian year" + (data.epochKnown < data.valid ? "; known for " + data.epochKnown.toLocaleString("en-US") + " of " + data.valid.toLocaleString("en-US") + " valid rows" : "");
  }

  function coverageInput() {
    const parts = [el.covRa.value, el.covDec.value, el.covRadius.value].map((text) => text.trim());
    const limit = el.covLimit.value.trim();
    const rowLimit = limit === "" ? NaN : Number(limit);
    if (limit !== "" && (!Number.isInteger(rowLimit) || rowLimit < 1)) return { error: "The row limit must be a whole number." };
    if (parts.every((text) => text === "")) return { cone: null, rowLimit };
    const ra = X.parseAngle(parts[0], "ra");
    const dec = X.parseAngle(parts[1], "dec");
    const radius = X.parseDecimal(parts[2]);
    if (ra.error || dec.error || !(radius > 0)) return { error: "Coverage needs a centre RA and Dec in degrees and a radius above 0 arcsec; it is ignored until all three are valid." };
    return { cone: { ra: ra.value, dec: dec.value, radiusArcsec: radius }, rowLimit };
  }

  function updateCoverageFact() {
    if (!state.cat?.data) return;
    const input = coverageInput();
    let text = "Not stated";
    if (input.error) text = input.error;
    else if (input.cone) {
      text = "Cone of " + input.cone.radiusArcsec + " arcsec around RA " + input.cone.ra + "°, Dec " + input.cone.dec + "°";
      if (Number.isFinite(input.rowLimit)) text += "; row limit " + input.rowLimit.toLocaleString("en-US") + (state.cat.data.count >= input.rowLimit ? " (reached: the extract may be cut off)" : "");
    } else if (Number.isFinite(input.rowLimit)) text = "Row limit " + input.rowLimit.toLocaleString("en-US") + (state.cat.data.count >= input.rowLimit ? " (reached: the extract may be cut off)" : "") + "; no cone given";
    setFact("cat", "coverage", text);
  }

  // ---- IRSA query link --------------------------------------------------------------------------------------------------
  function prefillIrsa() {
    if (el.irsaRa.value === "" && state.src?.data) fillIrsaFromSources(false);
    else updateIrsaLink();
  }

  function fillIrsaFromSources(announce = true) {
    const data = state.src?.data;
    if (!data || data.valid === 0) {
      setStatus(el.irsaStatus, "Load your sources first.", true);
      return;
    }
    const margin = Number(X.parseDecimal(el.radius.value)) || X.limits.defaultRadiusArcsec;
    const circle = X.enclosingCircle(data, margin);
    el.irsaRa.value = String(Number(circle.ra.toFixed(6)));
    el.irsaDec.value = String(Number(circle.dec.toFixed(6)));
    el.irsaRadius.value = String(Math.ceil(circle.radiusArcsec * 10) / 10);
    updateIrsaLink();
    if (announce && !el.irsaStatus.hasAttribute("data-error")) setStatus(el.irsaStatus, "Filled with a circle around your sources (the farthest source plus the match radius).");
  }

  function updateIrsaLink() {
    const ra = X.parseDecimal(el.irsaRa.value);
    const dec = X.parseDecimal(el.irsaDec.value);
    const radius = X.parseDecimal(el.irsaRadius.value);
    const limitText = el.irsaLimit.value.trim();
    const limit = /^\d+$/.test(limitText) ? Number(limitText) : NaN;
    const built = X.irsaExtractQuery({ table: el.irsaTable.value, ra, dec, radiusArcsec: radius, rowLimit: limit });
    el.irsaAdql.hidden = true;
    if (built.error) {
      el.irsaLink.removeAttribute("href");
      disabled(el.irsaLink, true);
      state.irsaQuery = null;
      setStatus(el.irsaStatus, el.irsaRa.value === "" ? "" : built.error, el.irsaRa.value !== "");
      return;
    }
    state.irsaQuery = built;
    el.irsaLink.href = built.url;
    disabled(el.irsaLink, false);
    el.irsaAdql.hidden = false;
    el.irsaAdql.textContent = built.adql;
    if (el.irsaStatus.hasAttribute("data-error")) setStatus(el.irsaStatus, "");
  }

  // ---- Settings and running -------------------------------------------------------------------------------------------------
  function readSettings() {
    const radius = X.parseDecimal(el.radius.value);
    if (!Number.isFinite(radius) || radius < X.limits.radiusMinArcsec || radius > X.limits.radiusMaxArcsec) {
      return { error: "Enter a radius from " + X.limits.radiusMinArcsec + " to " + X.limits.radiusMaxArcsec + " arcsec." };
    }
    const settings = { radius, move: el.epochMode.value === "move", targetEpoch: null, pmraIncludesCosDec: true };
    if (settings.move) {
      const target = X.parseEpoch(el.target.value, el.targetUnit.value);
      if (!Number.isFinite(target)) return { error: "Enter the epoch to move the catalog to, as a Julian year such as 2016.0 or as an MJD." };
      settings.targetEpoch = target;
      const mapping = catalogMapping();
      if (mapping.pmra >= 0 && mapping.pmdec >= 0) {
        if (el.catPmconv.value === "") return { error: "Choose whether the catalog's RA proper motion already includes cos(Dec) (catalog section) before moving positions." };
        settings.pmraIncludesCosDec = el.catPmconv.value === "cosdec";
      }
    }
    const coverage = coverageInput();
    if (coverage.error) settings.coverageWarning = coverage.error;
    else Object.assign(settings, { cone: coverage.cone, rowLimit: coverage.rowLimit });
    return settings;
  }

  function run() {
    if (isDisabled(el.run)) {
      updateRunState();
      return;
    }
    const settings = readSettings();
    if (settings.error) {
      setStatus(el.runStatus, settings.error, true);
      return;
    }
    const version = ++state.version;
    const { src, cat } = state;
    const srcEpoch = sourceEpoch();
    state.result = null;
    setStatus(el.runStatus, "Matching " + plural(src.data.valid, "source") + " against " + plural(cat.data.valid, "catalog row") + "…");
    el.verdict.textContent = "Matching…";
    setTimeout(() => {
      if (version !== state.version) return;
      const started = performance.now();
      let match;
      try {
        match = X.crossMatch(src.data, cat.data, {
          radiusArcsec: settings.radius, targetEpoch: settings.targetEpoch, pmraIncludesCosDec: settings.pmraIncludesCosDec,
          coverage: settings.cone ?? null, rowLimit: settings.rowLimit,
        });
      } catch (error) {
        match = { ok: false, message: "The match could not be completed. " + error.message };
      }
      if (!match.ok) {
        setStatus(el.runStatus, match.message, true);
        el.verdict.textContent = "No result. " + match.message;
        return;
      }
      state.result = {
        match, settings, seconds: (performance.now() - started) / 1000,
        src: src.data, cat: cat.data, srcName: src.name, catFile: cat.name,
        catalogName: el.catName.value.trim(), catalogRelease: el.catRelease.value.trim(),
        sourceEpoch: srcEpoch.ok ? srcEpoch : null, pmConvention: el.catPmconv.value,
      };
      state.filter = "all";
      state.page = 0;
      state.selected = -1;
      el.filter.value = "all";
      setStatus(el.runStatus, "Matched in " + state.result.seconds.toFixed(2) + " s.");
      render();
    }, 20);
  }

  // ---- Result display ---------------------------------------------------------------------------------------------------
  function catalogLabel(result) {
    const name = result.catalogName || "Catalog (name not given)";
    return result.catalogRelease ? name + " " + result.catalogRelease : name + " (release Unavailable)";
  }

  function epochSentences(result) {
    const { match, cat, settings } = result;
    const catEpoch = catalogEpochText(cat, catalogMapping()).replace(/ Julian year/, "");
    const mine = result.sourceEpoch ? result.sourceEpoch.text : "Unavailable (not given)";
    const lines = [];
    if (settings.move) {
      const motion = match.motion;
      lines.push("Catalog positions were moved to Julian year " + epochText(settings.targetEpoch) + " with their proper motion: " + motion.moved.toLocaleString("en-US") + " rows moved (largest shift " + motion.maxShiftArcsec.toFixed(3) + " arcsec), " +
        motion.noMotion.toLocaleString("en-US") + " had no usable proper motion and " + motion.noEpoch.toLocaleString("en-US") + " had no epoch, so those stay at their published position. Your positions were not moved; their epoch is " + mine + ".");
      if (result.sourceEpoch && Math.abs(result.sourceEpoch.year - settings.targetEpoch) > 0.05) {
        lines.push("The epoch of your positions (" + epochText(result.sourceEpoch.year) + ") differs from the epoch the catalog was moved to (" + epochText(settings.targetEpoch) + "); separations mix the two.");
      }
    } else {
      lines.push("No proper motion was applied. Separations compare your positions (epoch: " + mine + ") with catalog positions at their published epoch (" + catEpoch + ").");
      const gap = result.sourceEpoch && Number.isFinite(cat.epochMax) ? Math.max(Math.abs(result.sourceEpoch.year - cat.epochMin), Math.abs(result.sourceEpoch.year - cat.epochMax)) : NaN;
      if (gap > 1) lines.push("The two epochs differ by about " + gap.toFixed(1) + " years, so a source moving 100 mas/yr can be offset by about " + (gap * 0.1).toFixed(1) + " arcsec.");
      if (!result.sourceEpoch || !Number.isFinite(cat.epochMax)) lines.push("At least one epoch is Unavailable, so the size of any proper-motion offset cannot be judged.");
    }
    return lines;
  }

  function render() {
    const result = state.result;
    if (!result) return;
    const { match, src } = result;
    const counts = match.counts;
    const found = counts[X.status.single] + counts[X.status.multiple];
    el.verdict.textContent = "Sources with a candidate: " + found.toLocaleString("en-US") + " of " + src.valid.toLocaleString("en-US") + ". Matches are based on position alone.";

    const notes = [];
    for (const line of epochSentences(result)) notes.push(["info", line]);
    if (result.settings.move && match.motion.moved === 0) notes.push(["warning", "No catalog row could be moved: choose proper motion columns and an epoch (a column or a fixed value) in the catalog section."]);
    if (!match.coverageSummary.given && !match.coverageSummary.truncated) notes.push(["info", "No coverage was given for the extract, so a source with no match may lie outside it."]);
    if (result.settings.coverageWarning) notes.push(["warning", result.settings.coverageWarning]);
    if (match.coverageSummary.truncated) notes.push(["warning", "The extract has " + match.catalogCount.toLocaleString("en-US") + " rows, the row limit you entered. It may be cut off, so absence of a match is not reliable anywhere."]);
    else if (match.coverageSummary.given && match.coverageSummary.outside) notes.push(["warning", plural(match.coverageSummary.outside, "source") + " have a search circle that is not fully inside the extract's cone; a missing match there may only mean the extract stops. See the Coverage column of the export."]);
    if (counts[X.status.multiple]) {
      const ties = match.ties.reduce((sum, value) => sum + value, 0);
      if (ties) notes.push(["info", "Ties are ordered by catalog ID."]);
    }
    if (result.src.duplicateIds) notes.push(["warning", plural(result.src.duplicateIds, "row") + " of your sources share an ID with another row. Rows are told apart by row number."]);
    clear(el.notes);
    for (const [level, text] of notes) {
      const item = document.createElement("li");
      item.className = "tm-notes__" + level;
      item.textContent = text;
      el.notes.append(item);
    }
    el.notes.hidden = notes.length === 0;

    const set = (name, text) => { summaryFact(name).textContent = text; };
    set("catalog", catalogLabel(result) + (result.catFile ? " · file " + result.catFile : ""));
    set("radius", match.radiusArcsec + " arcsec (inclusive: a separation equal to the radius is a candidate)");
    set("epochs", result.settings.move ? "Catalog moved to Julian year " + epochText(result.settings.targetEpoch) : "Catalog at published epoch; no proper motion applied");
    set("sources", plural(match.sourceCount, "row") + " (" + src.valid.toLocaleString("en-US") + " valid) from " + result.srcName);
    set("single", counts[X.status.single].toLocaleString("en-US"));
    set("multiple", counts[X.status.multiple].toLocaleString("en-US"));
    set("none", counts[X.status.none].toLocaleString("en-US"));
    set("invalid", counts[X.status.invalid].toLocaleString("en-US"));
    set("index", match.index.rows.toLocaleString("en-US") + " catalog rows in " + match.index.zones.toLocaleString("en-US") + " declination zones of " + match.index.zoneHeightDeg + "°");
    el.summary.hidden = false;
    el.tablebar.hidden = false;
    el.tableWrap.hidden = false;
    el.tableNote.hidden = false;
    el.detail.hidden = true;
    disabled(el.download, false);
    renderTable();
  }

  function visibleRows() {
    const { match } = state.result;
    if (state.filter === "all") return null;
    const list = [];
    for (let i = 0; i < match.status.length; i++) if (match.status[i] === state.filter) list.push(i);
    return list;
  }

  function renderTable() {
    const result = state.result;
    const { match, src, cat, settings } = result;
    const filtered = visibleRows();
    const total = filtered ? filtered.length : match.sourceCount;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    state.page = Math.min(Math.max(state.page, 0), pages - 1);
    const from = state.page * pageSize;
    const to = Math.min(total, from + pageSize);
    clear(el.rows);
    const label = catalogLabel(result);
    for (let k = from; k < to; k++) {
      const i = filtered ? filtered[k] : k;
      const list = match.candidates[i];
      const best = list ? list[0] : null;
      const row = document.createElement("tr");
      if (i === state.selected) row.setAttribute("data-selected", "");
      const cell = (text, className) => {
        const td = document.createElement("td");
        if (className) td.className = className;
        td.textContent = text;
        row.append(td);
        return td;
      };
      const idCell = document.createElement("td");
      idCell.className = "xm-id";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "xm-row-button";
      button.textContent = src.ids[i];
      button.dataset.index = String(i);
      button.setAttribute("aria-label", "Show the candidates for " + src.ids[i] + ", row " + (i + 1));
      idCell.append(button);
      const small = document.createElement("small");
      small.textContent = "row " + (i + 1);
      idCell.append(small);
      row.append(idCell);

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "xm-status";
      badge.dataset.status = match.status[i];
      badge.textContent = X.statusLabel[match.status[i]];
      statusCell.append(badge);
      const extra = [];
      if (match.status[i] === X.status.invalid) extra.push(src.reason[i]);
      if (match.ties[i]) extra.push("tie");
      if (match.coverage[i] === "not-covered") extra.push("search circle reaches outside the extract");
      for (const text of extra) {
        const note = document.createElement("small");
        note.textContent = text;
        statusCell.append(note);
      }
      row.append(statusCell);
      cell(label);
      const bestCell = document.createElement("td");
      bestCell.className = "xm-id";
      if (best) {
        bestCell.textContent = cat.ids[best.index];
        const note = document.createElement("small");
        note.textContent = "catalog row " + (best.index + 1);
        bestCell.append(note);
      } else {
        bestCell.textContent = "—";
      }
      row.append(bestCell);
      cell(Number.isNaN(src.ra[i]) ? "—" : degreeText(src.ra[i]) + ", " + degreeText(src.dec[i]), "xm-num");
      cell(best ? degreeText(best.ra) + ", " + degreeText(best.dec) : "—", "xm-num");
      cell(best ? best.separationArcsec.toFixed(4) : "—", "xm-num");
      cell(match.status[i] === X.status.invalid ? "—" : String(list ? list.length : 0), "xm-num");
      const published = best ? cat.epoch[best.index] : NaN;
      let epoch = "—";
      if (best) {
        const moved = settings.move && (best.ra !== cat.ra[best.index] || best.dec !== cat.dec[best.index]);
        epoch = !Number.isFinite(published) ? "Unavailable" : moved ? epochText(published) + " " + arrow + " " + epochText(settings.targetEpoch) : epochText(published);
      }
      cell(epoch, "xm-num");
      el.rows.append(row);
    }
    el.pageLabel.textContent = total === 0 ? "No rows" : "Rows " + (from + 1).toLocaleString("en-US") + " to " + to.toLocaleString("en-US") + " of " + total.toLocaleString("en-US");
    disabled(el.prev, state.page === 0);
    disabled(el.next, state.page >= pages - 1);
  }

  function showDetail(index) {
    const result = state.result;
    if (!result) return;
    const { match, src, cat, settings } = result;
    state.selected = index;
    for (const row of el.rows.children) {
      const button = row.querySelector(".xm-row-button");
      if (button && Number(button.dataset.index) === index) row.setAttribute("data-selected", "");
      else row.removeAttribute("data-selected");
    }
    const list = match.candidates[index];
    el.detail.hidden = false;
    el.detailTitle.textContent = "Candidates for " + src.ids[index] + " (row " + (index + 1) + " of your sources)";
    const status = X.statusLabel[match.status[index]];
    el.detailNote.textContent = status + ". " + (match.status[index] === X.status.invalid
      ? "This row was not matched: " + src.reason[index] + "."
      : "Your position: RA " + degreeText(src.ra[index]) + "°, Dec " + degreeText(src.dec[index]) + "°. Radius " + match.radiusArcsec + " arcsec. " +
        (list ? "Rank 1 is the nearest candidate: a position match only." : "No catalog row lies within the radius.") +
        (match.coverage[index] === "not-covered" ? " The search circle reaches outside the extract's cone, so a missing candidate may lie in the part you do not have." : ""));
    el.detailCaption.textContent = "All catalog rows within " + match.radiusArcsec + " arcsec of " + src.ids[index] + ", nearest first; ties are ordered by catalog ID. Separations in arcsec.";
    clear(el.detailRows);
    (list ?? []).forEach((candidate, rank) => {
      const c = candidate.index;
      const row = document.createElement("tr");
      const cells = [
        String(rank + 1) + (rank === 0 ? " (nearest)" : ""), cat.ids[c], String(c + 1),
        degreeText(candidate.ra) + ", " + degreeText(candidate.dec),
        degreeText(cat.ra[c]) + ", " + degreeText(cat.dec[c]),
        candidate.separationArcsec.toFixed(4) + (rank === 0 && match.ties[index] ? " (tie)" : ""),
        Number.isFinite(cat.epoch[c]) ? epochText(cat.epoch[c]) : "Unavailable",
      ];
      cells.forEach((text, k) => {
        const td = document.createElement("td");
        if (k === 1) td.className = "xm-id";
        if (k >= 3) td.className = "xm-num";
        td.textContent = text;
        row.append(td);
      });
      el.detailRows.append(row);
    });
    el.detailTitle.focus({ preventScroll: true });
    el.detail.scrollIntoView({ block: "nearest" });
  }

  // ---- Export -------------------------------------------------------------------------------------------------------------
  function downloadCsv() {
    const result = state.result;
    if (!result || isDisabled(el.download)) return;
    const csv = X.buildExportCsv(result.src, result.cat, result.match, {
      catalogName: result.catalogName, catalogRelease: result.catalogRelease, spreadsheetIds: el.sheet.checked,
      sourceEpoch: result.sourceEpoch ? result.sourceEpoch.text : "",
    });
    const safe = (text) => String(text || "catalog").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "catalog";
    const name = "AstroNot-cross-match_" + safe(result.catalogName + (result.catalogRelease ? "-" + result.catalogRelease : "")) + "_" + String(result.match.radiusArcsec).replace(".", "p") + "arcsec.csv";
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const rows = csv.split("\r\n").length - 2;
    setStatus(el.exportStatus, "Saved " + name + ": " + plural(rows, "row") + " for " + plural(result.match.sourceCount, "source") + ", with unmatched and invalid rows included. Radius " + result.match.radiusArcsec + " arcsec" +
      (result.settings.move ? ", catalog moved to Julian year " + epochText(result.settings.targetEpoch) : ", published epochs") + ".");
  }

  // ---- Example ------------------------------------------------------------------------------------------------------------
  function loadExampleScript() {
    if (state.exampleScript) return state.exampleScript;
    state.exampleScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = siteAsset("assets/tools/xmatch-example.js");
      script.addEventListener("load", () => resolve(catalogCrossMatchExample), { once: true });
      script.addEventListener("error", () => reject(new Error("The example files could not be loaded.")), { once: true });
      document.head.append(script);
    }).catch((error) => {
      state.exampleScript = null;
      throw error;
    });
    return state.exampleScript;
  }

  async function loadExample() {
    disabled(el.example, true);
    setStatus(el.exampleStatus, "Loading the example…");
    try {
      const example = await loadExampleScript();
      await loadSources(example.allwise.fileName, example.allwise.csv, { example: true, epoch: String(example.settings.targetEpoch) });
      await loadCatalog(example.gaia.fileName, example.gaia.csv, { example: true });
      el.radius.value = String(example.settings.radiusArcsec);
      el.epochMode.value = "move";
      el.targetUnit.value = "jyear";
      el.target.value = String(example.settings.targetEpoch);
      syncEpochMode();
      invalidate("Example loaded. Choose Match positions.");
      setStatus(el.exampleStatus, "Example loaded: " + example.allwise.rows + " AllWISE rows as your sources and " + example.gaia.rows + " Gaia DR3 rows as the catalog, real IRSA TAP answers from " + example.retrieved + ". Radius " + example.settings.radiusArcsec + " arcsec; Gaia moved to Julian year " + example.settings.targetEpoch + ", " + example.settings.targetEpochNote + ".");
    } catch (error) {
      setStatus(el.exampleStatus, error.message, true);
    } finally {
      disabled(el.example, false);
    }
  }

  // ---- Wiring -------------------------------------------------------------------------------------------------------------
  function syncEpochMode() {
    const move = el.epochMode.value === "move";
    el.targetWrap.hidden = !move;
    el.targetUnitWrap.hidden = !move;
    if (move && el.target.value.trim() === "") {
      const mine = sourceEpoch();
      if (mine.ok) el.target.value = String(Number(mine.year.toFixed(4)));
      else if (state.cat?.data && state.cat.data.epochKnown) el.target.value = String(Number(state.cat.data.epochMin.toFixed(4)));
    }
    updateRunState();
  }

  function onFile(input, loader) {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await readText(file);
        await loader(file.name, text);
      } catch (error) {
        const status = loader === loadSources ? el.srcStatus : el.catStatus;
        setStatus(status, error.message, true);
      }
      input.value = "";
    });
  }

  function init() {
    for (const control of [el.example, el.srcFile, el.catFile]) control.disabled = false;
    onFile(el.srcFile, (name, text) => loadSources(name, text));
    onFile(el.catFile, (name, text) => loadCatalog(name, text));
    el.example.addEventListener("click", loadExample);

    for (const control of [el.srcId, el.srcRa, el.srcDec, el.srcUnit]) control.addEventListener("change", () => rebuildSources());
    for (const control of [el.srcEpoch, el.srcEpochUnit]) {
      control.addEventListener("input", () => {
        updateSourceEpochFact();
        invalidate();
      });
    }
    for (const control of [el.catId, el.catRa, el.catDec, el.catUnit, el.catPmra, el.catPmdec, el.catPmconv, el.catEpoch, el.catEpochUnit]) control.addEventListener("change", () => rebuildCatalog());
    el.catFixedEpoch.addEventListener("input", () => rebuildCatalog());
    for (const control of [el.catName, el.catRelease]) control.addEventListener("input", () => invalidate());
    for (const control of [el.covRa, el.covDec, el.covRadius, el.covLimit]) {
      control.addEventListener("input", () => {
        updateCoverageFact();
        invalidate();
      });
    }
    for (const control of [el.radius, el.target, el.targetUnit]) control.addEventListener("input", () => invalidate());
    el.epochMode.addEventListener("change", () => {
      syncEpochMode();
      invalidate();
    });
    el.useSourceEpoch.addEventListener("click", () => {
      const mine = sourceEpoch();
      if (!mine.ok) return;
      el.targetUnit.value = "jyear";
      el.target.value = String(Number(mine.year.toFixed(4)));
      invalidate();
    });
    el.run.addEventListener("click", run);
    el.filter.addEventListener("change", () => {
      state.filter = el.filter.value;
      state.page = 0;
      renderTable();
    });
    el.prev.addEventListener("click", () => {
      if (isDisabled(el.prev)) return;
      state.page--;
      renderTable();
    });
    el.next.addEventListener("click", () => {
      if (isDisabled(el.next)) return;
      state.page++;
      renderTable();
    });
    el.rows.addEventListener("click", (event) => {
      const button = event.target.closest(".xm-row-button");
      if (button) showDetail(Number(button.dataset.index));
    });
    el.download.addEventListener("click", downloadCsv);

    for (const control of [el.irsaTable, el.irsaRa, el.irsaDec, el.irsaRadius, el.irsaLimit]) control.addEventListener("input", updateIrsaLink);
    el.irsaFill.addEventListener("click", () => fillIrsaFromSources());
    el.irsaLink.addEventListener("click", (event) => {
      if (isDisabled(el.irsaLink) || !state.irsaQuery) {
        event.preventDefault();
        return;
      }
      state.lastRequest = { ...state.irsaQuery };
    });

    syncEpochMode();
    updateRunState();
    setStatus(el.exampleStatus, "");
  }

  init();
})();
