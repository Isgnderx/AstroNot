const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupMenu() {
  const header = document.querySelector("[data-header]");
  if (!header) return;
  const toggle = header.querySelector("[data-menu-toggle]");
  const nav = document.getElementById(toggle.getAttribute("aria-controls"));
  const mobile = window.matchMedia("(max-width: 880px)");

  function closeMenu(restoreFocus = false) {
    if (toggle.getAttribute("aria-expanded") === "false") return;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  header.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) closeMenu(true);
  });

  header.addEventListener("focusout", (event) => {
    if (!header.contains(event.relatedTarget)) closeMenu();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!header.contains(event.target)) closeMenu();
  });

  mobile.addEventListener("change", () => closeMenu());

  header.dataset.menuReady = "";
  toggle.hidden = false;
}

function setupAtlas() {
  const tablist = document.querySelector("[data-atlas-tabs]");
  if (!tablist) return;
  const tabs = [...tablist.querySelectorAll("a")];
  const panels = tabs.map((tab) => document.getElementById(tab.hash.slice(1)));

  function selectTab(selected) {
    tabs.forEach((tab, index) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    });
  }

  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-orientation", "vertical");

  tabs.forEach((tab, index) => {
    const panel = panels[index];
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;

    tab.addEventListener("click", (event) => {
      event.preventDefault();
      selectTab(tab);
    });

    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      switch (event.key) {
        case "ArrowDown": nextIndex = (index + 1) % tabs.length; break;
        case "ArrowUp": nextIndex = (index - 1 + tabs.length) % tabs.length; break;
        case "Home": nextIndex = 0; break;
        case "End": nextIndex = tabs.length - 1; break;
        case " ": event.preventDefault(); selectTab(tab); return;
        default: return;
      }
      event.preventDefault();
      selectTab(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  });

  selectTab(tabs.find((tab) => tab.hash === window.location.hash) ?? tabs[0]);
}

function setupArrivals() {
  if (motionPreference.matches || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-arriving");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.15 });

  document.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
}

function forwardLandingBookmarks() {
  if (!document.querySelector("[data-hero]")) return;
  const sections = new Map([
    ["#explore", "/explore"],
    ["#whirlpool", "/explore#whirlpool"],
    ["#orion", "/explore#orion"],
    ["#saturn", "/explore#saturn"],
    ["#scientific-tools", "/tools"],
    ["#research", "/learn#research"],
    ["#learn", "/learn"],
    ["#about", "/about"],
  ]);

  function followBookmark() {
    const route = sections.get(location.hash);
    if (route) location.replace(sitePage(route));
  }

  followBookmark();
  window.addEventListener("hashchange", followBookmark);
}

forwardLandingBookmarks();
setupMenu();
setupAtlas();
setupArrivals();
