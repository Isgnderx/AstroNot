// Slide deck controls: arrow keys, space, Home/End, click on the halves of a slide, F for full screen; the URL hash
// follows the current slide so a link opens the deck at that slide.
(() => {
  "use strict";
  const deck = document.getElementById("deck");
  const slides = [...deck.querySelectorAll(".slide")];
  const counter = document.querySelector("[data-deck-counter]");
  const progress = document.querySelector("[data-deck-progress]");
  // The start slide: the URL hash if it names one; otherwise whichever slide the browser already scrolled to.
  const fromHash = slides.findIndex((slide) => "#" + slide.id === location.hash);
  const fromScroll = slides.findIndex((slide, i) => deck.scrollTop < (slides[i + 1]?.offsetTop ?? Infinity) - 10);
  let current = fromHash >= 0 ? fromHash : Math.max(0, fromScroll);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  function show(index, { focus = true, instant = false } = {}) {
    current = Math.min(slides.length - 1, Math.max(0, index));
    // "instant" bypasses the container's CSS scroll-behavior; "auto" would still animate.
    deck.scrollTo({ top: slides[current].offsetTop, behavior: instant || reduced.matches ? "instant" : "smooth" });
    if (location.hash !== "#" + slides[current].id) history.replaceState(null, "", "#" + slides[current].id);
    counter.textContent = (current + 1) + " / " + slides.length;
    progress.style.inlineSize = ((current + 1) / slides.length * 100) + "%";
    if (focus) deck.focus({ preventScroll: true });
  }

  document.querySelector("[data-deck-prev]").addEventListener("click", () => show(current - 1));
  document.querySelector("[data-deck-next]").addEventListener("click", () => show(current + 1));
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
  });

  // Clicking the left third goes back, the rest forward; links and buttons keep their own behaviour.
  deck.addEventListener("click", (event) => {
    if (event.target.closest("a, button, table")) return;
    show(event.clientX < innerWidth / 3 ? current - 1 : current + 1);
  });

  // Keep the counter honest when the user scrolls or swipes instead.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
      const index = slides.indexOf(entry.target);
      if (index !== current) {
        current = index;
        counter.textContent = (current + 1) + " / " + slides.length;
        progress.style.inlineSize = ((current + 1) / slides.length * 100) + "%";
        history.replaceState(null, "", "#" + slides[current].id);
      }
    }
  }, { root: deck, threshold: [0.6] });
  slides.forEach((slide) => observer.observe(slide));

  window.addEventListener("hashchange", () => {
    const index = slides.findIndex((slide) => "#" + slide.id === location.hash);
    if (index >= 0 && index !== current) show(index, { focus: false });
  });

  show(current, { focus: false, instant: true });
})();
