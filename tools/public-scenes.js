(() => {
  "use strict";

  const { degrees } = AstroNotPublicAstronomy;
  const turn = 2 * Math.PI;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function makeGlow(stops) {
    const glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    const ctx = glow.getContext("2d");
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [position, color] of stops) gradient.addColorStop(position, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    return glow;
  }

  function random(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  // The display draws on demand. Only a visible, playing scene owns an animation frame.
  function mount(canvas, { draw, advance, camera } = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    let width = 0;
    let height = 0;
    let ratio = 1;
    let active = false;
    let visible = true;
    let frame = 0;
    let previous = 0;
    let drag = null;
    let dirty = true;

    function invalidate() {
      dirty = true;
      schedule();
    }

    function schedule() {
      if (!frame && visible && !document.hidden && width && height) frame = requestAnimationFrame(render);
    }

    function render(time) {
      frame = 0;
      if (!visible || document.hidden) return;
      const moving = active && !drag;
      if (moving && previous && time - previous < 1000 / 36 && !dirty) {
        schedule();
        return;
      }
      if (moving && previous) advance(Math.min((time - previous) / 1000, 0.075));
      previous = moving ? time : 0;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      draw(ctx, width, height, moving || Boolean(drag));
      dirty = false;
      if (moving) schedule();
    }

    new ResizeObserver(() => {
      const bounds = canvas.getBoundingClientRect();
      ratio = Math.min(2, devicePixelRatio || 1);
      width = bounds.width;
      height = bounds.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      invalidate();
    }).observe(canvas);

    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      previous = 0;
      if (visible) invalidate();
      else cancel();
    }).observe(canvas);

    function cancel() {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancel();
      else invalidate();
    });

    if (camera) {
      const turnCamera = (dx, dy) => {
        camera.turn(dx, dy);
        invalidate();
      };
      const zoomCamera = (factor) => {
        camera.zoom(factor);
        invalidate();
      };
      const resetCamera = () => {
        camera.reset();
        invalidate();
      };
      canvas.tabIndex = 0;
      canvas.dataset.interactive = "";
      canvas.addEventListener("keydown", (event) => {
        switch (event.key) {
          case "ArrowLeft": turnCamera(-25, 0); break;
          case "ArrowRight": turnCamera(25, 0); break;
          case "ArrowUp": turnCamera(0, -25); break;
          case "ArrowDown": turnCamera(0, 25); break;
          case "+": case "=": zoomCamera(1.15); break;
          case "-": zoomCamera(1 / 1.15); break;
          case "0": resetCamera(); break;
          default: return;
        }
        event.preventDefault();
      });
      canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(drag.id);
        canvas.dataset.grabbing = "";
        previous = 0;
      });
      canvas.addEventListener("pointermove", (event) => {
        if (drag?.id !== event.pointerId) return;
        turnCamera(event.clientX - drag.x, event.clientY - drag.y);
        drag.x = event.clientX;
        drag.y = event.clientY;
      });
      canvas.addEventListener("lostpointercapture", () => {
        drag = null;
        delete canvas.dataset.grabbing;
        invalidate();
      });
      const stage = canvas.parentElement;
      stage.querySelector("[data-reset-view]")?.addEventListener("click", resetCamera);
      stage.querySelector("[data-zoom-in]")?.addEventListener("click", () => zoomCamera(1.25));
      stage.querySelector("[data-zoom-out]")?.addEventListener("click", () => zoomCamera(0.8));
    }

    return {
      invalidate,
      play(playing) {
        active = playing && Boolean(advance);
        previous = 0;
        invalidate();
      },
    };
  }

  const rng = random(127);
  const field = Array.from({ length: 235 }, () => [rng(), rng(), rng(), rng()]);
  function starfield(ctx, w, h) {
    ctx.fillStyle = "#08090d";
    ctx.fillRect(0, 0, w, h);
    for (const [x, y, l, s] of field) {
      ctx.fillStyle = l > 0.985 ? "#b5c7e4" : l > 0.84 ? "#626f87" : "#303849";
      const size = l > 0.985 ? 1.9 : 0.5 + s * 0.75;
      ctx.fillRect(x * w, y * h, size, size);
    }
  }

  function cameraProjection(w, h, azimuth, altitude, zoom) {
    const sy = Math.sin(azimuth);
    const cy = Math.cos(azimuth);
    const sp = Math.sin(altitude);
    const cp = Math.cos(altitude);
    const focal = Math.min(w * 0.78, h * 0.78) * zoom;
    return ([east, north, up]) => {
      const horizontal = sy * east + cy * north;
      const depth = horizontal * cp + up * sp;
      if (depth <= 0.055) return null;
      return [w / 2 + (cy * east - sy * north) * focal / depth,
        h * 0.49 + (horizontal * sp - up * cp) * focal / depth];
    };
  }

  const direction = (az, alt) => [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
  const altitudes = [30, 60].map((alt) => Array.from({ length: 121 }, (_, i) => direction(i * 3 * degrees, alt * degrees)));
  const meridians = Array.from({ length: 12 }, (_, i) =>
    Array.from({ length: 21 }, (_, j) => direction(i * Math.PI / 6, (-10 + 5 * j) * degrees)));

  function sky(ctx, w, h, view, stars, guides, selected) {
    const project = cameraProjection(w, h, view.az, view.alt, view.zoom);
    // The horizon is a straight line in a perspective projection.
    const horizonY = h * 0.49 + Math.tan(view.alt) * Math.min(w * 0.78, h * 0.78) * view.zoom;
    const skyLight = ctx.createLinearGradient(0, 0, 0, h);
    skyLight.addColorStop(0, "#090b13");
    skyLight.addColorStop(1, "#131d2e");
    ctx.fillStyle = skyLight;
    ctx.fillRect(0, 0, w, clamp(horizonY, 0, h));
    ctx.fillStyle = "#17181e";
    ctx.fillRect(0, clamp(horizonY, 0, h), w, h);

    function line(points) {
      let penDown = false;
      for (const point of points) {
        const p = project(point);
        if (!p) {
          penDown = false;
          continue;
        }
        if (penDown) ctx.lineTo(...p);
        else ctx.moveTo(...p);
        penDown = true;
      }
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const arc of altitudes) line(arc);
    for (const meridian of meridians) line(meridian);
    ctx.strokeStyle = "#222c3c";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w, horizonY);
    ctx.strokeStyle = "#63728a";
    ctx.stroke();

    for (const [point, mag, bv] of stars) {
      const p = project(point);
      if (!p || p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > h) continue;
      const light = clamp((6.1 - mag) / 5.9, 0.14, 1);
      ctx.globalAlpha = point[2] >= 0 ? 0.22 + 0.77 * light : 0.26 * light;
      ctx.fillStyle = bv > 1.15 ? "#ffd0a8" : bv < 0.12 ? "#c6dbff" : "#f0f1ee";
      const radius = clamp((5.7 - mag) * 0.36, 0.58, 2.8);
      ctx.beginPath();
      ctx.arc(p[0], p[1], radius, 0, turn);
      ctx.fill();
      if (mag < 0.9 && point[2] > 0) {
        ctx.globalAlpha *= 0.15;
        ctx.beginPath();
        ctx.arc(p[0], p[1], radius + 3.2, 0, turn);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const [group, paths] of guides.entries()) {
      if (group === selected) continue;
      ctx.strokeStyle = "#51647b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const path of paths) line(path.map((node) => node.point));
      ctx.stroke();
    }
    const active = guides[selected];
    ctx.lineWidth = 1.65;
    ctx.strokeStyle = "#96caff";
    ctx.beginPath();
    for (const path of active) line(path.map((node) => node.point));
    ctx.stroke();
    for (const { name, point, anchor } of active.flat()) {
      const p = project(point);
      if (!p || p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > h) continue;
      ctx.fillStyle = "#e0edff";
      ctx.beginPath();
      ctx.arc(p[0], p[1], anchor ? 3.4 : 2.1, 0, turn);
      ctx.fill();
      if (!anchor) continue;
      ctx.strokeStyle = "#96caff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 9, 0, turn);
      ctx.stroke();
      ctx.font = "600 12px Inter, Arial, sans-serif";
      ctx.fillText(name, p[0] + 14, p[1] - 8);
    }

    ctx.font = "600 12px Inter, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#a8b6ca";
    ["North", "East", "South", "West"].forEach((label, i) => {
      const p = project(direction(i * Math.PI / 2, 0));
      if (p) ctx.fillText(window.AstroNotLanguage.translate(label), p[0], p[1] + 17);
    });
    ctx.textAlign = "start";
  }

  // Orthographic projection of lit spherical surfaces, with equirectangular texture sampling.
  // Cached surface normals and a bounded raster size keep rotating scenes light on phones.
  function spheres(invalidate, onTextureError) {
    const textures = new Map();
    const bodies = [document.createElement("canvas"), document.createElement("canvas")].map((canvas) => ({
      canvas, ctx: canvas.getContext("2d"), raster: null, normal: null,
    }));
    const selected = [];

    function fail(name) {
      textures.set(name, false);
      if (selected.includes(name)) onTextureError();
    }

    function load(name) {
      if (textures.has(name)) return;
      textures.set(name, null);
      const image = new Image();
      image.onload = () => {
        const map = document.createElement("canvas");
        map.width = image.width;
        map.height = image.height;
        const ctx = map.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        try {
          const pixels = ctx.getImageData(0, 0, map.width, map.height).data;
          textures.set(name, { pixels, width: map.width, height: map.height });
        } catch {
          // The geometric and lighting model can still run when local image pixels can't be read.
          fail(name);
        }
        invalidate();
      };
      image.onerror = () => fail(name);
      image.src = siteAsset("assets/tools/globes/" + name + ".jpg");
    }

    function allocate(body, size) {
      if (body.raster?.width === size) return;
      body.canvas.width = body.canvas.height = size;
      body.raster = body.ctx.createImageData(size, size);
      body.normal = new Float32Array(size * size * 3);
      body.normal.fill(-2);
      const pixels = body.raster.data;
      const radius = (size - 2) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - size / 2) / radius;
          const ny = (size / 2 - y - 0.5) / radius;
          const length = Math.hypot(nx, ny);
          if (length > 1 + 0.55 / radius) continue;
          const i = y * size + x;
          const z = Math.sqrt(Math.max(0, 1 - length * length));
          body.normal[i * 3] = nx;
          body.normal[i * 3 + 1] = ny;
          body.normal[i * 3 + 2] = z;
          pixels[i * 4 + 3] = 255 * clamp((1 - length) * radius + 0.55, 0, 1);
        }
      }
    }

    function ring(ctx, x, y, radius, front) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.2);
      ctx.scale(1, 0.33);
      ctx.lineWidth = Math.max(radius * 0.018, 0.7);
      for (let i = 0; i < 30; i++) {
        const r = 1.27 + i * 0.035;
        if (r > 1.93 && r < 2.02) continue;
        ctx.strokeStyle = r < 1.53 ? "#676052" : r > 2.02 ? "#ac9574" : (i % 4 ? "#d2bd9c" : "#9c8669");
        ctx.globalAlpha = r < 1.53 ? 0.32 : 0.63 + (i % 3) * 0.12;
        ctx.beginPath();
        ctx.arc(0, 0, radius * r, front ? 0 : Math.PI, front ? Math.PI : turn);
        ctx.stroke();
      }
      ctx.restore();
    }

    const paint = (ctx, slot, config) => {
      const { name, color, x, y, radius, yaw, pitch, light, moving, moon } = config;
      load(name);
      const map = textures.get(name);
      if (selected[slot] !== name) {
        selected[slot] = name;
        onTextureError(selected.some((bodyName) => textures.get(bodyName) === false));
      }
      const body = bodies[slot];
      const cap = moving ? 248 : 480;
      const size = clamp(Math.round(radius * 2 * Math.min(devicePixelRatio || 1, 1.75)), 20, cap);
      allocate(body, size);

      const fill = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const pixels = body.raster.data;
      const normals = body.normal;
      const [lx, ly, lz] = light;
      const hasAtmosphere = name === "earth" || name === "neptune";
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        const nx = normals[j];
        if (nx < -1.5) continue;
        const ny = normals[j + 1];
        const nz = normals[j + 2];
        const ry = clamp(ny * cosPitch + nz * sinPitch, -1, 1);
        const rz = nz * cosPitch - ny * sinPitch;
        const rx = nx * cy - rz * sy;
        const dz = rz * cy + nx * sy;
        const dot = nx * lx + ny * ly + nz * lz;
        const brightness = moon
          ? 0.12 + 1.52 * Math.max(0, dot) ** 0.70
          : 0.15 + 1.04 * Math.max(0, dot) ** 0.67;
        if (map) {
          const u = 0.5 + Math.atan2(rx, dz) / turn;
          const v = 0.5 - Math.asin(ry) / Math.PI;
          const index = (Math.min(map.height - 1, Math.floor(v * map.height)) * map.width
            + Math.floor(u * map.width) % map.width) * 4;
          const atmosphere = hasAtmosphere ? 0.22 * (1 - nz) ** 4 : 0;
          pixels[i] = map.pixels[index] * brightness + 32 * atmosphere;
          pixels[i + 1] = map.pixels[index + 1] * brightness + 102 * atmosphere;
          pixels[i + 2] = map.pixels[index + 2] * brightness + 204 * atmosphere;
        } else {
          const ridges = 0.83 + 0.09 * Math.cos(ry * 59 + rx * 2) + 0.08 * Math.sin(rx * 13 + ry * 7 + dz * 9);
          pixels[i] = fill[0] * brightness * ridges;
          pixels[i + 1] = fill[1] * brightness * ridges;
          pixels[i + 2] = fill[2] * brightness * ridges;
        }
      }
      body.ctx.putImageData(body.raster, 0, 0);
      if (name === "saturn") ring(ctx, x, y, radius, false);
      const offset = radius * size / (size - 2);
      ctx.drawImage(body.canvas, x - offset, y - offset, offset * 2, offset * 2);
      if (name === "saturn") ring(ctx, x, y, radius, true);
    };
    return paint;
  }

  function meteorField(seed) {
    const rand = random(seed);
    return Array.from({ length: 15 }, (_, i) => ({
      angle: rand() * turn, delay: i / 15 + rand() * 0.035, distance: 0.19 + rand() * 0.52,
      length: 0.07 + rand() * 0.11, bright: rand(),
    }));
  }

  function meteorSky(ctx, w, h, time, trails, radiant, preview) {
    starfield(ctx, w, h);
    const x = w * radiant[0];
    const y = h * radiant[1];
    const scale = Math.hypot(w, h);
    const ground = ctx.createLinearGradient(0, h * 0.40, 0, h);
    ground.addColorStop(0, "rgba(11,18,34,0)");
    ground.addColorStop(1, "#1c2b43");
    ctx.fillStyle = ground;
    ctx.fillRect(0, h * 0.39, w, h * 0.61);

    for (const [index, trail] of trails.entries()) {
      const age = (time / 10 + trail.delay) % 1;
      if (preview ? index % 3 !== 0 : age > 0.12) continue;
      const progress = preview ? 0.65 : age / 0.12;
      const length = scale * trail.length * (0.28 + Math.sin(Math.PI * progress) * 0.72);
      const travel = scale * (trail.distance * 0.56 + progress * 0.27);
      const dx = Math.cos(trail.angle);
      const dy = Math.sin(trail.angle);
      const hx = x + dx * travel;
      const hy = y + dy * travel;
      const tx = hx - dx * length;
      const ty = hy - dy * length;
      ctx.globalAlpha = preview ? 0.86 : Math.sin(Math.PI * progress);
      const tail = ctx.createLinearGradient(tx, ty, hx, hy);
      tail.addColorStop(0, "rgba(131,156,210,0)");
      tail.addColorStop(0.82, trail.bright > 0.64 ? "#e8ad91" : "#98b8ea");
      tail.addColorStop(1, "#f6f4f5");
      ctx.strokeStyle = tail;
      ctx.lineWidth = 0.9 + 1.15 * trail.bright;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (let band = 0; band < 2; band++) {
      ctx.fillStyle = band ? "#0a0c10" : "#111621";
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= 35; i++) {
        const u = i / 35;
        const height = 0.89 + band * 0.045 + 0.018 * Math.sin(u * 28 + band)
          + 0.014 * Math.cos(u * 53) - 0.05 * Math.sin(u * 8) ** 2;
        ctx.lineTo(u * w, h * height);
      }
      ctx.lineTo(w, h);
      ctx.fill();
    }
    ctx.strokeStyle = "#b5d2ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, turn);
    ctx.moveTo(x - 21, y); ctx.lineTo(x - 8, y);
    ctx.moveTo(x + 8, y); ctx.lineTo(x + 21, y);
    ctx.moveTo(x, y - 21); ctx.lineTo(x, y - 8);
    ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 21);
    ctx.stroke();
    ctx.fillStyle = "#e6efff";
    ctx.beginPath();
    ctx.arc(x, y, 2.25, 0, turn);
    ctx.fill();
  }

  function galaxyModel(type) {
    const rand = random(32279 + type.length);
    const gaussian = () => (rand() + rand() + rand() + rand() - 2) * 1.65;
    const clumps = [[-0.50, 0.21, 0.10], [0.29, 0.42, -0.07], [0.48, -0.40, 0.04], [-0.29, -0.32, -0.13]];
    const points = Array.from({ length: 6100 }, (_, i) => {
      const r = 0.95 * rand() ** 0.76;
      const a = rand() * turn;
      if (type === "elliptical") {
        return [gaussian() * 0.43, gaussian() * 0.27, gaussian() * 0.28, rand() > 0.35 ? 0 : 1, rand()];
      }
      if (type === "irregular") {
        const [x, y, z] = clumps[i % clumps.length];
        const bloom = i % clumps.length === 0 ? 0.24 : 0.16;
        return [x + gaussian() * bloom, y + gaussian() * 0.19, z + gaussian() * 0.12, i % 4, rand()];
      }
      if (i < 1250) {
        const bar = type === "barred";
        return [gaussian() * (bar ? 0.42 : 0.13), gaussian() * (bar ? 0.075 : 0.12),
          gaussian() * 0.076, rand() > 0.2 ? 0 : 1, rand()];
      }
      const radius = type === "barred" ? 0.28 + r * 0.78 : r;
      const angle = (i % 2) * Math.PI + (type === "barred" ? r * 4.0 : r * 4.8) + gaussian() * (0.39 - r * 0.23);
      if (i > 5540) return [Math.cos(a) * r, Math.sin(a) * r, gaussian() * 0.05, 2, rand() * 0.5];
      return [Math.cos(angle) * radius, Math.sin(angle) * radius, gaussian() * (0.07 - r * 0.043),
        rand() > 0.89 ? 3 : rand() > 0.5 ? 2 : 1, rand()];
    });
    return { type, points };
  }

  const galaxyGlows = new Map();
  function getGalaxyGlows() {
    if (!galaxyGlows.size) {
      galaxyGlows.set("warm", makeGlow([[0, "#fff8df"], [0.2, "#eac3a895"], [0.56, "#a5705132"], [1, "#a5705100"]]));
      galaxyGlows.set("cool", makeGlow([[0, "#a5bcec68"], [0.32, "#698ad96a"], [0.69, "#5365a62c"], [1, "#5365a600"]]));
    }
    return galaxyGlows;
  }

  function galaxy(ctx, w, h, view, model) {
    starfield(ctx, w, h);
    const spin = Math.cos(view.yaw);
    const side = Math.sin(view.yaw);
    const pitch = Math.cos(view.pitch);
    const tilt = Math.sin(view.pitch);
    const size = Math.min(w * 0.53, h * 0.62) * view.zoomLevel;
    const { type, points: stars } = model;
    const palette = type === "elliptical"
      ? ["#f4be95", "#f5e2c9", "#e3c0b2", "#e5c7b7"] : ["#f4c49c", "#e4e8fc", "#a2b9fa", "#efc2ea"];
    const batches = palette.map(() => [[], [], []]);
    const glows = getGalaxyGlows();
    const hazy = type === "elliptical" ? glows.get("warm") : glows.get("cool");
    const central = glows.get("warm");
    const glowSize = size * (type === "elliptical" ? 0.88 : 0.39);
    ctx.globalCompositeOperation = "lighter";
    if (type !== "irregular") {
      ctx.save();
      ctx.translate(w / 2, h * 0.49);
      ctx.rotate(view.yaw * 0.6);
      const x = glowSize * (type === "barred" ? 1.6 : 1);
      const y = glowSize * (type === "barred" ? 0.32 : 0.65);
      ctx.globalAlpha = type === "elliptical" ? 0.23 : 0.54;
      ctx.drawImage(central, -x / 2, -y / 2, x, y);
      ctx.restore();
    }

    for (const [index, [x, y, z, color, light]] of stars.entries()) {
      const px = x * spin - y * side;
      const py = x * side + y * spin;
      const perspective = 1 / (1.35 - (py * tilt + z * pitch) * 0.21);
      const cx = w / 2 + px * size * perspective;
      const cy = h * 0.49 + (py * pitch - z * tilt) * size * perspective;
      if (index % 11 === 0 && light > 0.3) {
        const radius = (0.025 + light * 0.022) * size;
        ctx.globalAlpha = 0.08 + light * 0.095;
        ctx.drawImage(hazy, cx - radius, cy - radius, radius * 2, radius * 2);
      }
      batches[color][Math.min(2, Math.floor(light * 3))].push([
        cx, cy, (0.76 + light * light * 1.71) * perspective,
      ]);
    }
    for (const [i, levels] of batches.entries()) {
      ctx.fillStyle = palette[i];
      for (const [l, points] of levels.entries()) {
        ctx.globalAlpha = 0.19 + l * 0.18;
        ctx.beginPath();
        for (const [x, y, s] of points) ctx.rect(x, y, s, s);
        ctx.fill();
        if (l < 2) continue;
        ctx.globalAlpha = 0.13;
        for (let j = 0; j < points.length; j += 24) {
          const [x, y, s] = points[j];
          ctx.fillRect(x - s * 0.6, y, s * 2.2, s * 0.65);
          ctx.fillRect(x, y - s * 0.6, s * 0.65, s * 2.2);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  window.AstroNotPublicScenes = { clamp, galaxy, galaxyModel, meteorField, meteorSky, mount, sky, spheres, starfield };
})();
