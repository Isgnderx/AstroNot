(() => {
  "use strict";

  const astronomy = AstroNotPublicAstronomy;
  const scenes = AstroNotPublicScenes;
  const { day, degrees, isoDay } = astronomy;
  const firstDate = "2000-01-01";
  const lastDate = "2050-12-31";
  const icons = {
    back: "m14 6-6 6 6 6",
    forward: "m10 6 6 6-6 6",
    minus: "M5 12h14",
    plus: "M5 12h14m-7-7v14",
    reset: "M4 11a8 8 0 1 1 2 6M4 5v6h6",
  };
  const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + icons[name] + '"/></svg>';
  const azMonths = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avqust", "sentyabr", "oktyabr", "noyabr", "dekabr"];
  const azShortMonths = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avq", "sen", "okt", "noy", "dek"];
  const azWeek = ["Baz", "B.e.", "Ç.a.", "Çər", "C.a.", "Cüm", "Şən"];
  function formatted(date, options) {
    const language = document.documentElement.lang;
    if (language !== "az") return new Intl.DateTimeFormat(language, { timeZone: "UTC", ...options }).format(date);
    // Some browsers ship a reduced locale set and render Azerbaijani month names as M01, M02, etc.
    const stamp = new Date(date);
    if (options.weekday) return azWeek[stamp.getUTCDay()];
    const month = (options.month === "short" ? azShortMonths : azMonths)[stamp.getUTCMonth()];
    return [options.day && stamp.getUTCDate(), month, options.year && stamp.getUTCFullYear()].filter(Boolean).join(" ");
  }

  function number(value, digits = 0) {
    const language = document.documentElement.lang;
    const display = new Intl.NumberFormat(language === "az" ? "en" : language, { maximumFractionDigits: digits });
    if (language !== "az") return display.format(value);
    return display.formatToParts(value).map(({ type, value: part }) => {
      if (type === "decimal") return ",";
      if (type === "group") return ".";
      return part;
    }).join("");
  }

  const dateName = (date) => formatted(date, { day: "numeric", month: "long", year: "numeric" });

  const root = document.querySelector("[data-public-tool]");
  const $ = (selector) => root.querySelector(selector);

  function buildView({ title, label, controls, camera = true, motion, facts = "", hint }) {
    root.innerHTML = '<div class="outreach__room">' +
      '<section class="outreach__view" aria-label="' + title + '">' +
        '<div class="outreach__stage">' +
          '<canvas aria-label="' + title + '"' + (camera ? ' aria-describedby="scene-help"' : ' role="img"') + '></canvas>' +
          '<span class="outreach__scene-label">' + label + '</span>' +
          (camera ? '<div class="outreach__camera" role="group" aria-label="View controls">' +
            '<button type="button" data-zoom-out aria-label="Zoom out" title="Zoom out">' + icon("minus") + '</button>' +
            '<button type="button" data-zoom-in aria-label="Zoom in" title="Zoom in">' + icon("plus") + '</button>' +
            '<button type="button" data-reset-view aria-label="Reset view" title="Reset view">' + icon("reset") + '</button></div>' : '') +
          '<div class="outreach__stage-footer"><span id="scene-help">' + hint + '</span>' +
          (motion ? '<button class="outreach__motion" type="button" aria-pressed="false"><span aria-hidden="true"></span>' + motion + '</button>' : '') +
          '</div>' +
          '<p class="outreach__fallback" role="status" hidden>Interactive graphics are unavailable in this browser.</p>' +
        '</div>' + (facts ? '<dl class="outreach__facts">' + facts + '</dl>' : '') +
      '</section>' +
      '<aside class="outreach__controls">' + controls + '</aside>' +
    '</div>';
    root.hidden = false;
  }

  function animation(scene, autoplay = false, onChange = () => {}) {
    const button = $(".outreach__motion");
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let playing = false;
    function play(active) {
      if (playing === active) return;
      playing = active;
      button.setAttribute("aria-pressed", String(playing));
      onChange(playing);
      scene?.play(playing);
    }
    button.addEventListener("click", () => play(!playing));
    media.addEventListener("change", ({ matches }) => { if (matches) play(false); });
    play(autoplay && !media.matches && Boolean(scene));
    return play;
  }

  function mount(options) {
    const scene = scenes.mount($("canvas"), options);
    if (!scene) {
      $(".outreach__fallback").hidden = false;
      $(".outreach__camera")?.remove();
      const motion = $(".outreach__motion");
      if (motion) motion.disabled = true;
    }
    return scene;
  }

  function showSimplifiedSurface(simplified = true) {
    const notice = $(".outreach__fallback");
    if (simplified) notice.textContent = "A simplified surface is shown because a texture is unavailable.";
    notice.hidden = !simplified;
  }

  function refreshOnLanguage(update) {
    window.addEventListener("astronot-languagechange", update);
  }

  const fillOptions = (select, entries, current) => {
    select.replaceChildren(...entries.map((label, i) => new Option(label, i, false, i === current)));
  };
  const fact = (label, key) => '<div><dt' + (label ? '>' + label : ' data-key="' + key + '-label">') +
    '</dt><dd data-key="' + key + '"></dd></div>';
  const write = (key, value) => { $('[data-key="' + key + '"]').textContent = value; };
  const dragHint = "Drag to turn · Arrow keys when focused";
  const bearings = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];
  const bearingOf = (azimuth) => bearings[Math.round(azimuth / 45) % bearings.length];

  function constellations() {
    buildView({
      title: "Interactive night sky",
      label: "Night sky map",
      hint: dragHint,
      motion: "Animate time",
      facts: fact("Guide star", "anchor") + fact("Height above horizon", "altitude") + fact("Look toward", "direction"),
      controls: `
        <section aria-labelledby="sky-settings">
          <h2 id="sky-settings">Set your sky</h2>
          <div class="outreach__pair">
            <label>City<select data-city></select></label>
            <label>Date<input type="date" data-date min="${firstDate}" max="${lastDate}"></label>
          </div>
          <label class="outreach__range-label">
            <span>Local time <output data-local-time translate="no"></output></span>
            <input type="range" data-time min="0" max="1435" step="5" aria-label="Local time">
          </label>
          <div class="outreach__ends" translate="no"><span>00:00</span><span>12:00</span><span>23:55</span></div>
          <button type="button" class="outreach__text-button" data-tonight>Set to tonight</button>
        </section>
        <section aria-labelledby="sky-choose">
          <h2 id="sky-choose">Find a constellation</h2>
          <label><span class="outreach__sr">Constellation</span><select data-guide></select></label>
          <p data-tip></p>
          <p class="outreach__readout" data-visibility></p>
          <button type="button" class="outreach__button outreach__button--light" data-center>Center constellation</button>
        </section>`,
    });
    const city = $("[data-city]");
    const date = $("[data-date]");
    const time = $("[data-time]");
    const guide = $("[data-guide]");
    const timeOut = $("[data-local-time]");
    const items = astronomy.constellations;
    const skyView = { az: 0, alt: 0, zoom: 1 };
    let stars = [];
    let guides = [];
    let target;
    let playElapsed = 0;
    let selected = 0;
    let validDate;
    fillOptions(city, astronomy.cities.map(([name]) => name), 0);
    fillOptions(guide, items.map(({ name }) => name), selected);

    function center() {
      const point = astronomy.skyAngles(target);
      skyView.az = point.azimuth * degrees;
      skyView.alt = scenes.clamp(point.altitude, -85, 88) * degrees;
      skyView.zoom = 1.38;
    }

    function update(track = false) {
      const [, latitude, longitude, zone] = astronomy.cities[city.value];
      const instant = astronomy.cityTime(validDate, Number(time.value) / 60, zone);
      const transform = astronomy.skyTransform(instant, latitude, longitude);
      stars = window.AstroNotBrightStars.map(([ra, dec, mag, bv]) => [transform(ra, dec), mag, bv]);
      guides = items.map(({ paths, anchor }) => paths.map((path) => path.map((name) => ({
        name, anchor: name === anchor, point: transform(...astronomy.guideStars[name]),
      }))));
      const item = items[selected];
      target = transform(...astronomy.guideStars[item.anchor]);
      const point = astronomy.skyAngles(target);
      timeOut.textContent = astronomy.cityClock(instant, zone);
      time.setAttribute("aria-valuetext", timeOut.textContent);
      write("anchor", item.anchor);
      write("altitude", number(point.altitude, 1) + "°");
      write("direction", bearingOf(point.azimuth));
      $("[data-tip]").textContent = item.tip;
      $("[data-visibility]").textContent = point.altitude < 0 ? "Guide star is below the horizon." : "Guide star is above the horizon.";
      if (track) center();
      scene?.invalidate();
    }

    const scene = mount({
      camera: {
        turn(dx, dy) {
          skyView.az -= dx * 0.007 / skyView.zoom;
          skyView.alt = scenes.clamp(skyView.alt + dy * 0.007 / skyView.zoom, -85 * degrees, 88 * degrees);
        },
        zoom(factor) { skyView.zoom = scenes.clamp(skyView.zoom * factor, 0.65, 2.9); },
        reset: center,
      },
      draw(ctx, w, h) { if (target) scenes.sky(ctx, w, h, skyView, stars, guides, selected); },
      advance(delta) {
        playElapsed += delta;
        if (playElapsed < 0.13) return;
        playElapsed -= 0.13;
        if (Number(time.value) >= 1435) {
          validDate = date.value = validDate === lastDate ? firstDate : isoDay(Date.parse(validDate) + day);
          time.value = 0;
        } else time.value = Number(time.value) + 5;
        update();
      },
    });
    const play = animation(scene, false, () => { playElapsed = 0; });

    function tonight() {
      play(false);
      const today = astronomy.todayIn(astronomy.cities[city.value][3]);
      validDate = date.value = today > lastDate ? lastDate : today < firstDate ? firstDate : today;
      time.value = 22 * 60;
      update(true);
    }
    tonight();
    // Lead with a shape above the horizon when one of the six is visible.
    if (astronomy.skyAngles(target).altitude < 5) {
      const best = guides.map((paths) => paths.flat().find(({ anchor }) => anchor).point[2]);
      guide.value = selected = best.indexOf(Math.max(...best));
      update(true);
    }
    city.addEventListener("change", () => { play(false); update(true); });
    date.addEventListener("change", () => {
      play(false);
      if (!date.value || !date.validity.valid) date.value = validDate;
      validDate = date.value;
      update(true);
    });
    time.addEventListener("input", () => { play(false); update(true); });
    guide.addEventListener("change", () => { selected = Number(guide.value); update(true); });
    $("[data-center]").addEventListener("click", () => { center(); scene?.invalidate(); });
    $("[data-tonight]").addEventListener("click", tonight);
    refreshOnLanguage(() => update());
  }

  function orbit(startPitch, startYaw = 0, minZoom = 0.72, maxZoom = 1.6) {
    return {
      yaw: startYaw, pitch: startPitch, zoomLevel: 1,
      turn(dx, dy) {
        this.yaw += dx * 0.011;
        this.pitch = scenes.clamp(this.pitch + dy * 0.010, -1.42, 1.42);
      },
      zoom(factor) { this.zoomLevel = scenes.clamp(this.zoomLevel * factor, minZoom, maxZoom); },
      reset() { this.yaw = startYaw; this.pitch = startPitch; this.zoomLevel = 1; },
    };
  }

  // Small calendar symbols use the same illumination angle as the large model.
  function phaseIcon(angle) {
    const wax = angle < 180;
    const edge = Math.abs(Math.cos(angle * degrees) * 6).toFixed(2);
    return '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6"/>' +
      '<path d="M7 1 A6 6 0 0 ' + Number(wax) + ' 7 13 A' + edge + ' 6 0 0 ' +
      Number(wax === (angle > 90 && angle < 270)) + ' 7 1Z"/></svg>';
  }

  function moon() {
    buildView({
      title: "Interactive three-dimensional Moon",
      label: "Lunar surface model",
      hint: dragHint,
      motion: "Play phases",
      facts: fact("Phase", "phase") + fact("Illuminated", "lit") + fact("Next full Moon", "full"),
      controls: `
        <section aria-labelledby="moon-calendar">
          <h2 id="moon-calendar">Pick a night</h2>
          <div class="outreach__calendar-top">
            <button type="button" data-month-prev aria-label="Previous month" title="Previous month">${icon("back")}</button>
            <strong data-month translate="no"></strong>
            <button type="button" data-month-next aria-label="Next month" title="Next month">${icon("forward")}</button>
          </div>
          <div class="outreach__week" aria-hidden="true" translate="no"></div>
          <div class="outreach__days" role="group" aria-label="Days in the selected month"></div>
          <div class="outreach__calendar-foot">
            <button type="button" class="outreach__text-button" data-today>Today</button>
            <span>Dates in UTC</span>
          </div>
        </section>
        <section aria-labelledby="moon-date">
          <h2 id="moon-date">Selected date</h2>
          <label><span class="outreach__sr">Selected date</span><input type="date" data-chosen min="${firstDate}" max="${lastDate}"></label>
          <p>As the Moon orbits Earth, we see different amounts of its lit side. Play the phases to watch a lunar month pass.</p>
        </section>`,
    });
    const min = Date.parse(firstDate);
    const max = Date.parse(lastDate);
    const today = scenes.clamp(Date.parse(isoDay(Date.now())), min, max);
    const firstOfMonth = (date) => Date.UTC(new Date(date).getUTCFullYear(), new Date(date).getUTCMonth(), 1);
    let selected = today;
    let month = firstOfMonth(today);
    let preview = selected + day / 2;
    let phase = astronomy.moonAngle(preview);
    let renderedMonth = null;
    const camera = orbit(0.035, 0, 0.72, 1.34);

    const scene = mount({
      camera,
      draw(ctx, w, h, moving) {
        scenes.starfield(ctx, w, h);
        const radius = Math.min(w * 0.31, h * 0.35) * camera.zoomLevel;
        const x = w / 2;
        const y = h * 0.48;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#242b36";
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.13, 0, 2 * Math.PI);
        ctx.stroke();
        paint(ctx, 0, { name: "moon", color: "#a3a3aa", x, y, radius,
          yaw: camera.yaw, pitch: camera.pitch, light: [Math.sin(phase * degrees), 0, -Math.cos(phase * degrees)], moving, moon: true });
      },
      advance(delta) {
        preview += delta * day * 2.4;
        if (preview >= max + day) preview = min;
        phase = astronomy.moonAngle(preview);
        const date = Math.floor(preview / day) * day;
        if (date !== selected) {
          selected = date;
          month = firstOfMonth(date);
          renderCalendar();
          renderFacts();
        }
      },
    });
    const paint = scenes.spheres(() => scene?.invalidate(), showSimplifiedSurface);
    const play = animation(scene, false, (playing) => {
      if (!playing) {
        preview = selected + day / 2;
        phase = astronomy.moonAngle(preview);
      }
    });

    function choose(date) {
      play(false);
      selected = date;
      month = firstOfMonth(selected);
      preview = selected + day / 2;
      phase = astronomy.moonAngle(preview);
      renderCalendar();
      renderFacts();
      scene?.invalidate();
    }

    function renderFacts() {
      const moonPhase = astronomy.moonPhaseAt(selected + day / 2);
      const lit = (1 - Math.cos(astronomy.moonAngle(selected + day / 2) * degrees)) / 2;
      write("phase", moonPhase);
      write("lit", new Intl.NumberFormat(document.documentElement.lang, { style: "percent" }).format(lit));
      write("full", formatted(astronomy.nextPhase(selected, 180), { day: "numeric", month: "short", year: "numeric" }));
      $("[data-chosen]").value = isoDay(selected);
    }

    function renderCalendar(force = false) {
      const grid = $(".outreach__days");
      if (renderedMonth !== month || force === true) {
        renderedMonth = month;
        const date = new Date(month);
        const year = date.getUTCFullYear();
        const index = date.getUTCMonth();
        const days = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
        const start = (date.getUTCDay() + 6) % 7;
        $("[data-month]").textContent = formatted(month, { month: "long", year: "numeric" });
        $("[data-month-prev]").disabled = month === min;
        $("[data-month-next]").disabled = month === firstOfMonth(max);
        const weekday = $(".outreach__week");
        weekday.replaceChildren(...Array.from({ length: 7 }, (_, i) => {
          const name = document.createElement("span");
          name.textContent = formatted(Date.UTC(2024, 0, 1 + i), { weekday: "short" });
          return name;
        }));
        const controls = Array.from({ length: start }, () => document.createElement("span"));
        for (let i = 0; i < days; i++) {
          const timestamp = month + i * day;
          const button = document.createElement("button");
          button.type = "button";
          button.value = timestamp;
          button.innerHTML = '<span>' + number(i + 1) + '</span>' + phaseIcon(astronomy.moonAngle(timestamp + day / 2));
          button.setAttribute("aria-label", dateName(timestamp));
          if (timestamp === today) button.setAttribute("aria-current", "date");
          button.addEventListener("click", () => choose(timestamp));
          controls.push(button);
        }
        grid.replaceChildren(...controls);
      }
      for (const button of grid.querySelectorAll("button")) {
        const current = Number(button.value) === selected;
        button.tabIndex = current ? 0 : -1;
        button.setAttribute("aria-pressed", String(current));
      }
    }

    function changeMonth(diff) {
      const date = new Date(month);
      choose(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + diff, 1));
    }
    $("[data-month-prev]").addEventListener("click", () => changeMonth(-1));
    $("[data-month-next]").addEventListener("click", () => changeMonth(1));
    $("[data-today]").addEventListener("click", () => choose(today));
    $("[data-chosen]").addEventListener("change", (event) => {
      const input = event.target;
      const date = Date.parse(input.value);
      choose(input.validity.valid && Number.isFinite(date) ? date : selected);
    });
    $(".outreach__days").addEventListener("keydown", (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (!step || event.target.tagName !== "BUTTON") return;
      event.preventDefault();
      choose(scenes.clamp(Number(event.target.value) + step * day, min, max));
      $('.outreach__days [aria-pressed="true"]').focus();
    });
    refreshOnLanguage(() => { renderCalendar(true); renderFacts(); });
    choose(today);
  }

  function planets() {
    buildView({
      title: "Interactive three-dimensional planet comparison",
      label: "True diameter scale",
      hint: dragHint,
      motion: "Auto-rotate",
      facts: fact("", "left") + fact("", "right") + fact("Diameter ratio", "ratio"),
      controls: `
        <section aria-labelledby="planet-pair">
          <h2 id="planet-pair">Choose two planets</h2>
          <label>Left planet<select data-left></select></label>
          <label>Right planet<select data-right></select></label>
          <button class="outreach__button" type="button" data-swap>Swap planets</button>
        </section>
        <section aria-labelledby="planet-scale">
          <h2 id="planet-scale">Display scale</h2>
          <div class="outreach__segments" role="group" aria-labelledby="planet-scale">
            <button type="button" data-scale="true" aria-pressed="true">True scale</button>
            <button type="button" data-scale="false" aria-pressed="false">Fit both</button>
          </div>
          <p data-scale-help>Both planets use the same scale. Look at the difference in diameter.</p>
        </section>`,
    });
    const catalog = astronomy.planets;
    const left = $("[data-left]");
    const right = $("[data-right]");
    const camera = orbit(-0.12, -0.28, 0.65, 1.27);
    let trueScale = true;
    fillOptions(left, catalog.map(([name]) => name), 2);
    fillOptions(right, catalog.map(([name]) => name), 4);

    const scene = mount({
      camera,
      draw(ctx, w, h, moving) {
        scenes.starfield(ctx, w, h);
        const planets = [catalog[left.value], catalog[right.value]];
        const outerRadius = (name) => name === "Saturn" ? 2.31 : 1;
        const diameterRatio = Math.max(...planets.map(([name, diameter]) => (trueScale ? diameter : 1) * outerRadius(name)));
        const maxRadius = Math.min(w * 0.19, h * 0.28) * camera.zoomLevel;
        ctx.beginPath();
        ctx.moveTo(w / 2, h * 0.15);
        ctx.lineTo(w / 2, h * 0.83);
        ctx.strokeStyle = "#252c38";
        ctx.lineWidth = 1;
        ctx.stroke();
        for (const [slot, [name, diameter, color]] of planets.entries()) {
          const basis = trueScale ? diameter / diameterRatio : 1 / outerRadius(name);
          const radius = maxRadius * basis;
          const x = w * (slot ? 0.75 : 0.25);
          const y = h * 0.47;
          paint(ctx, slot, { name: name.toLowerCase(), color, x, y, radius, yaw: camera.yaw + slot * 0.75,
            pitch: camera.pitch, light: [-0.46, 0.24, 0.854], moving });
          const ruler = h * 0.82;
          ctx.strokeStyle = "#a0adc2";
          ctx.beginPath();
          ctx.moveTo(x - radius, ruler);
          ctx.lineTo(x + radius, ruler);
          ctx.moveTo(x - radius, ruler - 5);
          ctx.lineTo(x - radius, ruler + 5);
          ctx.moveTo(x + radius, ruler - 5);
          ctx.lineTo(x + radius, ruler + 5);
          ctx.stroke();
        }
      },
      advance(delta) { camera.yaw += (0.17 + camera.zoomLevel * 0.02) * delta; },
    });
    const paint = scenes.spheres(() => scene?.invalidate(), showSimplifiedSurface);
    animation(scene, true);

    function update() {
      const [leftName, leftDiameter] = catalog[left.value];
      const [rightName, rightDiameter] = catalog[right.value];
      write("left-label", leftName);
      write("right-label", rightName);
      write("left", number(leftDiameter) + " km");
      write("right", number(rightDiameter) + " km");
      write("ratio", number(Math.max(leftDiameter, rightDiameter) / Math.min(leftDiameter, rightDiameter), 2) + " : 1");
      $(".outreach__scene-label").textContent = trueScale ? "True diameter scale" : "Portrait view";
      $("[data-scale-help]").textContent = trueScale
        ? "Both planets use the same scale. Look at the difference in diameter."
        : "Each planet fills its side so you can inspect its surface.";
      scene?.invalidate();
    }
    left.addEventListener("change", update);
    right.addEventListener("change", update);
    $("[data-swap]").addEventListener("click", () => {
      [left.value, right.value] = [right.value, left.value];
      update();
    });
    for (const button of root.querySelectorAll("[data-scale]")) button.addEventListener("click", () => {
      trueScale = button.dataset.scale === "true";
      for (const segment of button.parentElement.children) segment.setAttribute("aria-pressed", String(segment === button));
      update();
    });
    refreshOnLanguage(update);
    update();
  }

  function nebula() {
    const layers = [
      { name: "Visible red light", path: "assets/tools/nebula-visible.jpg", channel: 0 },
      { name: "Near-infrared light", path: "assets/tools/nebula-infrared.jpg", channel: 1 },
    ];
    buildView({
      title: "Interactive Orion Nebula image",
      label: "Orion Nebula · M42",
      hint: "Drag to pan · Arrow keys when focused",
      controls: `
        <section aria-labelledby="nebula-colors">
          <h2 id="nebula-colors">Blend two telescope images</h2>
          <div class="outreach__channels">
            ${layers.map(({ name, channel }) => `<label class="outreach__range-label" data-channel="${channel}">
              <span>${name} <output translate="no">100%</output></span>
              <input type="range" min="0" max="100" value="100" aria-label="${name}">
            </label>`).join("")}
          </div>
          <div class="outreach__segments outreach__presets" role="group" aria-label="Color presets">
            <button type="button" data-preset="0" aria-pressed="true">Both bands</button>
            <button type="button" data-preset="1" aria-pressed="false">Red only</button>
            <button type="button" data-preset="2" aria-pressed="false">Infrared only</button>
          </div>
        </section>
        <section aria-labelledby="nebula-compare">
          <h2 id="nebula-compare">See what each band reveals</h2>
          <label class="outreach__check"><input type="checkbox" data-before> <span>Compare side by side</span></label>
          <label class="outreach__range-label" data-divider-label hidden>
            <span>Divider position <output translate="no">50%</output></span>
            <input type="range" min="0" max="100" value="50" aria-label="Divider position" data-divider>
          </label>
          <p>Red light traces much of the glowing gas. Infrared can make some stars easier to see through dust.</p>
        </section>`,
    });
    const sliders = [...root.querySelectorAll("[data-channel] input")];
    const compare = $("[data-before]");
    const divider = $("[data-divider]");
    const presets = [[100, 100], [100, 0], [0, 100]];
    const camera = { x: 0, y: 0, scale: 1 };
    const images = layers.map(() => new Image());
    let loaded = 0;
    const scene = mount({
      camera: {
        turn(dx, dy) { camera.x += dx; camera.y += dy; },
        zoom(factor) { camera.scale = scenes.clamp(camera.scale * factor, 1, 3); },
        reset() { camera.x = camera.y = 0; camera.scale = 1; },
      },
      draw(ctx, w, h) {
        if (loaded < images.length) {
          scenes.starfield(ctx, w, h);
          return;
        }
        const [red, infrared] = images;
        const scale = Math.max(w / red.naturalWidth, h / red.naturalHeight) * camera.scale;
        const imageWidth = red.naturalWidth * scale;
        const imageHeight = red.naturalHeight * scale;
        const dx = Math.max(0, (imageWidth - w) / 2);
        const dy = Math.max(0, (imageHeight - h) / 2);
        camera.x = scenes.clamp(camera.x, -dx, dx);
        camera.y = scenes.clamp(camera.y, -dy, dy);
        const x = camera.x - dx;
        const y = camera.y - dy;
        const split = w * Number(divider.value) / 100;

        ctx.fillStyle = "#030305";
        ctx.fillRect(0, 0, w, h);
        ctx.save();
        if (compare.checked) {
          ctx.beginPath();
          ctx.rect(split, 0, w - split, h);
          ctx.clip();
        }
        ctx.globalCompositeOperation = "lighter";
        for (const [i, image] of images.entries()) {
          ctx.globalAlpha = Number(sliders[i].value) / 100;
          ctx.drawImage(image, x, y, imageWidth, imageHeight);
        }
        ctx.restore();

        if (!compare.checked) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, split, h);
        ctx.clip();
        ctx.drawImage(red, x, y, imageWidth, imageHeight);
        ctx.restore();
        ctx.fillStyle = "#f6f8fc";
        ctx.fillRect(split - 1, 0, 2, h);
      },
    });

    function showPercent(slider) {
      const percent = slider.value + "%";
      slider.previousElementSibling.querySelector("output").textContent = percent;
      slider.setAttribute("aria-valuetext", percent);
    }

    function update() {
      for (const slider of sliders) showPercent(slider);
      for (const button of root.querySelectorAll("[data-preset]")) {
        button.setAttribute("aria-pressed", String(presets[button.dataset.preset].every((value, i) => value === Number(sliders[i].value))));
      }
      scene?.invalidate();
    }

    for (const [i, image] of images.entries()) {
      image.onload = () => {
        loaded++;
        scene?.invalidate();
      };
      image.onerror = () => {
        $(".outreach__fallback").textContent = "The Orion Nebula images could not be loaded.";
        $(".outreach__fallback").hidden = false;
        for (const control of root.querySelectorAll("button, input")) control.disabled = true;
      };
      image.src = siteAsset(layers[i].path);
    }
    for (const slider of sliders) slider.addEventListener("input", update);
    for (const button of root.querySelectorAll("[data-preset]")) button.addEventListener("click", () => {
      sliders.forEach((slider, i) => { slider.value = presets[button.dataset.preset][i]; });
      update();
    });
    compare.addEventListener("change", () => {
      $("[data-divider-label]").hidden = !compare.checked;
      $(".outreach__scene-label").textContent = compare.checked ? "Red on left · Your mix on right" : "Orion Nebula · M42";
      scene?.invalidate();
    });
    divider.addEventListener("input", () => {
      showPercent(divider);
      scene?.invalidate();
    });
    update();
  }


  function meteors() {
    const showers = astronomy.upcomingShowers();
    buildView({
      title: "Animated meteor shower and radiant",
      label: "Radiant simulation",
      hint: "Streaks appear to spread from the marked point.",
      camera: false,
      motion: "Play meteors",
      facts: fact("Typical peak", "peak") + fact("Radiant constellation", "radiant") + fact("Look toward", "bearing"),
      controls: `
        <section aria-labelledby="shower-heading">
          <h2 id="shower-heading">Pick a meteor shower</h2>
          <label><span class="outreach__sr">Meteor shower</span><select data-shower></select></label>
          <p class="outreach__readout" data-shower-date translate="no"></p>
          <ol class="outreach__upcoming" aria-label="Upcoming showers"></ol>
        </section>
        <section aria-labelledby="meteor-guide">
          <h2 id="meteor-guide">Where to look</h2>
          <div class="outreach__pair">
            <label>City<select data-city></select></label>
            <label>Local time<select data-watch-time translate="no"></select></label>
          </div>
          <p class="outreach__readout" data-radiant-status></p>
          <p>Find a dark spot with a wide view of the sky. Look a little away from the radiant to see longer trails.</p>
        </section>`,
    });
    const select = $("[data-shower]");
    const city = $("[data-city]");
    const watch = $("[data-watch-time]");
    const watchHours = [0, 2, 4, 6, 20, 22];
    fillOptions(select, showers.map(({ name }) => name), 0);
    fillOptions(city, astronomy.cities.map(([name]) => name), 0);
    fillOptions(watch, watchHours.map((hour) => String(hour).padStart(2, "0") + ":00"), 2);
    let elapsed = 1.8;
    let trails = [];
    let radiant = [0.54, 0.42];
    const scene = mount({
      draw(ctx, w, h, moving) { scenes.meteorSky(ctx, w, h, elapsed, trails, radiant, !moving); },
      advance(delta) { elapsed += delta; },
    });
    animation(scene, true);

    function position() {
      const shower = showers[select.value];
      const [, latitude, longitude, zone] = astronomy.cities[city.value];
      const instant = astronomy.cityTime(isoDay(shower.peak), watchHours[watch.value], zone);
      const toSky = astronomy.skyTransform(instant, latitude, longitude);
      const { altitude, azimuth } = astronomy.skyAngles(toSky(shower.ra, shower.dec));
      write("bearing", bearingOf(azimuth));
      const status = $("[data-radiant-status]");
      status.replaceChildren(document.createTextNode(altitude < 0 ? "Radiant below the horizon" : "Radiant above the horizon"),
        document.createTextNode(" · " + number(altitude, 1) + "°"));
      radiant = [0.50, scenes.clamp(0.68 - altitude * 0.006, 0.23, 0.68)];
      scene?.invalidate();
    }

    function render() {
      const index = Number(select.value);
      const shower = showers[index];
      const date = formatted(shower.peak, { day: "numeric", month: "long", year: "numeric" });
      write("peak", formatted(shower.peak, { day: "numeric", month: "short", year: "numeric" }));
      write("radiant", shower.radiant);
      $("[data-shower-date]").textContent = date;
      const list = $(".outreach__upcoming");
      list.replaceChildren(...showers.slice(0, 3).map(({ name, peak }, i) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-pressed", String(index === i));
        const label = document.createElement("span");
        const date = document.createElement("time");
        label.textContent = name;
        date.dateTime = isoDay(peak);
        date.setAttribute("translate", "no");
        date.textContent = formatted(peak, { day: "numeric", month: "short" });
        button.append(label, date);
        button.addEventListener("click", () => {
          select.value = i;
          render();
          list.children[i].firstElementChild.focus();
        });
        item.append(button);
        return item;
      }));
      trails = scenes.meteorField(shower.name.length * 329);
      position();
    }
    select.addEventListener("change", render);
    city.addEventListener("change", position);
    watch.addEventListener("change", position);
    refreshOnLanguage(render);
    render();
  }

  function quiz() {
    const questions = astronomy.galaxies;
    buildView({
      title: "Interactive three-dimensional galaxy model",
      label: "Galaxy model",
      hint: dragHint,
      motion: "Auto-rotate",
      facts: fact("Question", "question") + fact("Score", "score"),
      controls: `
        <section aria-labelledby="quiz-choose">
          <h2 id="quiz-choose">What shape is this galaxy?</h2>
          <p class="outreach__sr" id="galaxy-description"></p>
          <div class="outreach__answers" role="group" aria-labelledby="quiz-choose" aria-describedby="galaxy-description"></div>
          <p class="outreach__readout" data-quiz-feedback role="status"></p>
          <p data-explanation hidden></p>
          <button type="button" class="outreach__text-button" data-hint aria-expanded="false" aria-controls="quiz-hint">Show hint</button>
          <p id="quiz-hint" hidden></p>
          <button class="outreach__button outreach__button--light" type="button" data-next hidden>Next galaxy</button>
        </section>`,
    });
    const answerList = $(".outreach__answers");
    const feedback = $("[data-quiz-feedback]");
    const explanation = $("[data-explanation]");
    const hint = $("#quiz-hint");
    const hintButton = $("[data-hint]");
    const next = $("[data-next]");
    $("canvas").setAttribute("aria-describedby", "scene-help galaxy-description");
    let index = 0;
    let score = 0;
    let answer = null;
    let model;
    let order;
    const camera = orbit(0.48, -0.18, 0.70, 1.38);
    const scene = mount({
      camera,
      draw(ctx, w, h) { if (model) scenes.galaxy(ctx, w, h, camera, model); },
      advance(delta) { camera.yaw += delta * 0.16; },
    });
    animation(scene, true);

    function stats() {
      write("question", number(index + 1) + " / " + number(questions.length));
      write("score", number(score) + " / " + number(questions.length));
    }

    function question() {
      answer = null;
      const [type, , clue, , description] = questions[order[index]];
      model = scenes.galaxyModel(type);
      camera.reset();
      hint.textContent = clue;
      $("#galaxy-description").textContent = description;
      hint.hidden = true;
      hintButton.hidden = false;
      hintButton.textContent = "Show hint";
      hintButton.setAttribute("aria-expanded", "false");
      next.hidden = explanation.hidden = true;
      feedback.textContent = "";
      for (const button of answerList.children) {
        button.removeAttribute("aria-disabled");
        delete button.dataset.result;
      }
      stats();
      scene?.invalidate();
    }

    function respond(guess) {
      if (answer !== null) return;
      answer = guess;
      const solution = order[index];
      const match = answer === solution;
      if (match) score++;
      for (const [i, button] of [...answerList.children].entries()) {
        button.setAttribute("aria-disabled", "true");
        if (i === solution) button.dataset.result = "correct";
        else if (i === answer) button.dataset.result = "incorrect";
      }
      feedback.textContent = "Correct";
      if (!match) {
        const correct = document.createElement("strong");
        correct.textContent = questions[solution][1];
        feedback.replaceChildren(document.createTextNode("Correct answer"), correct);
      }
      explanation.textContent = questions[solution][3];
      explanation.hidden = false;
      hint.hidden = hintButton.hidden = true;
      next.textContent = index === questions.length - 1 ? "Play again" : "Next galaxy";
      next.hidden = false;
      stats();
    }

    for (const [choice, [, name]] of questions.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "outreach__button outreach__answer";
      option.textContent = name;
      option.addEventListener("click", () => respond(choice));
      answerList.append(option);
    }
    hintButton.addEventListener("click", () => {
      hint.hidden = !hint.hidden;
      hintButton.textContent = hint.hidden ? "Show hint" : "Hide hint";
      hintButton.setAttribute("aria-expanded", String(!hint.hidden));
    });
    next.addEventListener("click", () => {
      index = (index + 1) % questions.length;
      if (index === 0) {
        score = 0;
        shuffle();
      }
      question();
      answerList.firstElementChild.focus();
    });
    function shuffle(leadWithSpiral = false) {
      order = questions.map((_, i) => i);
      const start = leadWithSpiral ? 1 : 0;
      for (let i = order.length - 1; i > start; i--) {
        const other = start + Math.floor(Math.random() * (i - start + 1));
        [order[i], order[other]] = [order[other], order[i]];
      }
    }
    refreshOnLanguage(stats);
    shuffle(true);
    question();
  }

  const tools = {
    "constellation-finder": constellations,
    "moon-phase-calendar": moon,
    "planet-size-comparison": planets,
    "nebula-color-mixer": nebula,
    "meteor-shower-planner": meteors,
    "galaxy-shape-quiz": quiz,
  };
  tools[root.dataset.publicTool]();
})();
