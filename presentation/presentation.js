// Slide deck controls (arrow keys, space, Home/End, click on the slide halves, F for full screen, N for speaker notes;
// the URL hash follows the current slide) and the rotating 3D planets, drawn with the site's own sphere renderer
// from tools/public-scenes.js and the Solar System Scope textures the Planet Size Comparison tool uses.
(() => {
  "use strict";
  const deck = document.getElementById("deck");
  const slides = [...deck.querySelectorAll(".slide")];
  const counter = document.querySelector("[data-deck-counter]");
  const progress = document.querySelector("[data-deck-progress]");
  const notesButton = document.querySelector("[data-deck-notes]");
  const notesPanel = document.querySelector("[data-deck-notes-panel]");
  const notesText = document.querySelector("[data-deck-notes-text]");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  // The start slide: the URL hash if it names one; otherwise whichever slide the browser already scrolled to.
  const fromHash = slides.findIndex((slide) => "#" + slide.id === location.hash);
  const fromScroll = slides.findIndex((slide, i) => deck.scrollTop < (slides[i + 1]?.offsetTop ?? Infinity) - 10);
  let current = fromHash >= 0 ? fromHash : Math.max(0, fromScroll);

  function reflect() {
    counter.textContent = (current + 1) + " / " + slides.length;
    progress.style.inlineSize = ((current + 1) / slides.length * 100) + "%";
    if (location.hash !== "#" + slides[current].id) history.replaceState(null, "", "#" + slides[current].id);
    notesText.textContent = slides[current].querySelector(".slide__notes")?.textContent.trim() ?? "";
  }

  function show(index, { focus = true, instant = false } = {}) {
    current = Math.min(slides.length - 1, Math.max(0, index));
    // "instant" bypasses the container's CSS scroll-behavior; "auto" would still animate.
    deck.scrollTo({ top: slides[current].offsetTop, behavior: instant || reduced.matches ? "instant" : "smooth" });
    reflect();
    if (focus) deck.focus({ preventScroll: true });
  }

  function toggleNotes(open = notesPanel.hidden) {
    notesPanel.hidden = !open;
    notesButton.setAttribute("aria-pressed", String(open));
  }

  document.querySelector("[data-deck-prev]").addEventListener("click", () => show(current - 1));
  document.querySelector("[data-deck-next]").addEventListener("click", () => show(current + 1));
  notesButton.addEventListener("click", () => toggleNotes());
  document.querySelector("[data-deck-full]").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea, button") && event.key !== "Escape") return;
    const keys = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, Enter: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 };
    if (event.key in keys) {
      event.preventDefault();
      show(current + keys[event.key]);
    } else if (event.key === "Home") { event.preventDefault(); show(0); }
    else if (event.key === "End") { event.preventDefault(); show(slides.length - 1); }
    else if (event.key.toLowerCase() === "f") document.querySelector("[data-deck-full]").click();
    else if (event.key.toLowerCase() === "n") toggleNotes();
  });

  // Clicking the left third goes back, the rest forward; links, buttons and the planets keep their own behaviour.
  deck.addEventListener("click", (event) => {
    if (event.target.closest("a, button, table, canvas")) return;
    show(event.clientX < innerWidth / 3 ? current - 1 : current + 1);
  });

  // Keep the counter honest when the user scrolls or swipes instead.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
      const index = slides.indexOf(entry.target);
      if (index !== current) { current = index; reflect(); }
    }
  }, { root: deck, threshold: [0.6] });
  slides.forEach((slide) => observer.observe(slide));

  window.addEventListener("hashchange", () => {
    const index = slides.findIndex((slide) => "#" + slide.id === location.hash);
    if (index >= 0 && index !== current) show(index, { focus: false });
  });

  // ---- Rotating 3D planets --------------------------------------------------------------------------------------
  // scenes.spheres() returns a painter for a lit, texture-mapped sphere; scenes.mount() owns the animation frame
  // and only draws while the canvas is visible. Light comes from the upper left; yaw advances slowly.
  const scenes = window.AstroNotPublicScenes;
  const colors = { saturn: "#ded0a5", mars: "#d58b66", earth: "#79adea", jupiter: "#d9a889" };
  for (const canvas of document.querySelectorAll("canvas[data-planet]")) {
    if (!scenes) break;
    const name = canvas.dataset.planet;
    let yaw = 0.6;
    let scene = null;
    const paint = scenes.spheres(() => scene?.invalidate(), () => {});
    scene = scenes.mount(canvas, {
      draw(ctx, w, h) {
        const radius = Math.min(w, h) * (name === "saturn" ? 0.26 : 0.4);
        paint(ctx, 0, { name, color: colors[name] ?? "#9aa4b5", x: w / 2, y: h / 2, radius, yaw, pitch: 0.28, light: [-0.55, 0.45, 0.7], moving: !reduced.matches, moon: false });
      },
      advance(delta) { yaw += delta * 0.22; },
    });
    if (scene && !reduced.matches) scene.play(true);
    else scene?.invalidate();
  }

  show(current, { focus: false, instant: true });
})();
