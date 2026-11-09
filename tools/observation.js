function buildObservationQuery(fields) {
  const ra = Number(fields.ra) % 360;
  const dec = Number(fields.dec);
  const radius = Number(fields.radius);
  const url = new URL("https://irsa.ipac.caltech.edu/SIA");
  url.searchParams.set("COLLECTION", "spherex_qr2");
  url.searchParams.set("POS", "CIRCLE " + ra + " " + dec + " " + radius);
  url.searchParams.set("MAXREC", "100");
  url.searchParams.set("RESPONSEFORMAT", "CSV");

  if (fields.dateStart || fields.dateEnd) {
    const mjd = (date, time) => Date.parse(date + "T" + time + "Z") / 86400000 + 40587;
    const start = fields.dateStart ? mjd(fields.dateStart, "00:00:00.000") : -Infinity;
    const end = fields.dateEnd ? mjd(fields.dateEnd, "23:59:59.999") : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("Enter valid UTC dates.");
    if (start > end) throw new Error("The end date must be on or after the start date.");
    url.searchParams.set("TIME", (fields.dateStart ? start.toFixed(8) : "-Inf") + " " + (fields.dateEnd ? end.toFixed(8) : "+Inf"));
  }

  if (fields.bandStart || fields.bandEnd) {
    const start = fields.bandStart ? Number(fields.bandStart) : -Infinity;
    const end = fields.bandEnd ? Number(fields.bandEnd) : Infinity;
    if (start > end) throw new Error("The maximum wavelength must be at least the minimum wavelength.");
    const metres = (microns) => (microns / 1000000).toExponential();
    url.searchParams.set("BAND", (fields.bandStart ? metres(start) : "-Inf") + " " + (fields.bandEnd ? metres(end) : "+Inf"));
  }

  return { url, ra, dec, radius };
}

function setupObservationSearch() {
  const form = document.querySelector("[data-observation-form]");
  const submit = form.querySelector("[data-observation-submit]");
  const example = form.querySelector("[data-observation-example]");
  const status = form.querySelector("[data-observation-status]");
  const empty = document.querySelector("[data-query-empty]");
  const result = document.querySelector("[data-query-result]");
  const summary = result.querySelector("[data-query-summary]");
  const link = result.querySelector("[data-query-link]");

  function resetQuery() {
    result.hidden = true;
    empty.hidden = false;
    link.removeAttribute("href");
    status.textContent = "";
    status.removeAttribute("data-error");
  }

  form.addEventListener("input", resetQuery);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    resetQuery();
    try {
      const fields = Object.fromEntries(new FormData(form));
      const { url, ra, dec, radius } = buildObservationQuery(fields);
      summary.textContent = "ICRS " + ra + "°, " + dec + "° · " + radius + "° search radius";
      link.href = url.href;
      empty.hidden = true;
      result.hidden = false;
      status.textContent = "Search prepared. Open the archive link to view the matching records.";
    } catch (error) {
      status.setAttribute("data-error", "");
      status.textContent = error.message;
    }
  });

  example.addEventListener("click", () => {
    form.reset();
    form.elements.ra.value = "156.09328159";
    form.elements.dec.value = "-41.64466331";
    form.elements.dateStart.value = "2025-05-24";
    form.elements.dateEnd.value = "2025-05-24";
    form.elements.bandStart.value = "1.2";
    form.elements.bandEnd.value = "1.4";
    resetQuery();
    status.textContent = "Example coordinates and filters loaded.";
  });

  submit.disabled = false;
  example.disabled = false;
}

setupObservationSearch();
