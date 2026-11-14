const toolCardTemplate = document.createElement("template");
toolCardTemplate.innerHTML = `
  <li class="tools__item">
    <article class="tool-card">
      <div class="tool-card__visual">
        <img alt="" width="384" height="196" loading="lazy" decoding="async">
        <span class="tool-card__caption"></span>
      </div>
      <div class="tool-card__body">
        <p class="tool-card__category"></p>
        <p class="tool-card__description"></p>
        <div class="tool-card__footer">
          <div class="tool-card__state">
            <span class="tool-card__status"></span>
          </div>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>
        </div>
      </div>
    </article>
  </li>`;

function createToolCard(tool, headingTag) {
  const item = toolCardTemplate.content.firstElementChild.cloneNode(true);
  const article = item.querySelector("article");
  const image = item.querySelector("img");
  const category = item.querySelector(".tool-card__category");
  const heading = document.createElement(headingTag);
  const footer = item.querySelector(".tool-card__footer");
  const ready = tool.available === true;
  const action = document.createElement(ready ? "a" : "button");

  item.dataset.tool = tool.id;
  article.toggleAttribute("data-ready", ready);
  image.src = toolImage(tool);
  image.alt = tool.imageAlt ?? "";
  if (tool.image) image.classList.add("tool-card__photo");
  item.querySelector(".tool-card__caption").textContent = tool.caption ?? "Method diagram";
  category.textContent = toolCategories[tool.category];
  heading.className = "tool-card__title";
  heading.textContent = tool.name;
  category.after(heading);
  item.querySelector(".tool-card__description").textContent = tool.description;
  item.querySelector(".tool-card__status").textContent = ready ? "Available" : "Coming Soon";

  action.className = "tool-card__launch";
  action.append(footer.querySelector("svg"));
  if (ready) {
    action.href = workspaceHref(tool);
    if (tool.route) action.dataset.route = "/tools/" + tool.route;
    action.setAttribute("aria-label", "Open " + tool.name + " workspace");
  } else {
    action.type = "button";
    action.disabled = true;
    action.setAttribute("aria-label", tool.name + " is coming soon");
    if (tool.preview) {
      const link = document.createElement("a");
      link.className = "tool-card__preview";
      link.href = workspaceHref(tool);
      link.textContent = "Workspace preview";
      link.setAttribute("aria-label", "Preview " + tool.name + " workspace");
      item.querySelector(".tool-card__state").append(link);
    }
  }
  footer.append(action);
  return item;
}

function setupToolDirectory(directory, tools, headingTag) {
  const track = directory.querySelector("[data-tool-track]");
  const filters = directory.querySelector("[data-tool-filters]");
  const previous = directory.querySelector("[data-tool-previous]");
  const next = directory.querySelector("[data-tool-next]");
  const range = directory.querySelector("[data-tool-range]");
  const availability = directory.querySelector("[data-tool-availability]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cards = tools.map((tool) => createToolCard(tool, headingTag));

  track.replaceChildren(...cards);
  let shown = cards;

  function updateScrollControls() {
    const end = track.scrollWidth - track.clientWidth;
    previous.setAttribute("aria-disabled", String(track.scrollLeft <= 2));
    next.setAttribute("aria-disabled", String(track.scrollLeft >= end - 2));

    const bounds = track.getBoundingClientRect();
    const indexes = shown.flatMap((card, index) => {
      const rect = card.getBoundingClientRect();
      return rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2 ? [index + 1] : [];
    });
    if (indexes.length) {
      const first = indexes[0];
      const last = indexes.at(-1);
      range.textContent = (first === last ? first : first + "–" + last) + " of " + shown.length;
    } else if (shown.length === 0) {
      range.textContent = "";
    }
  }

  const groups = [["all", "All tools"], ...Object.entries(toolCategories)];
  groups.forEach(([key, label]) => {
    const button = document.createElement("button");
    const count = tools.filter((tool) => key === "all" || tool.category === key).length;
    const badge = document.createElement("span");
    button.type = "button";
    button.className = "tools__filter";
    button.setAttribute("aria-pressed", String(key === "all"));
    button.append(label + " ", badge);
    badge.textContent = count;
    filters.append(button);

    button.addEventListener("click", () => {
      for (const filter of filters.children) filter.setAttribute("aria-pressed", String(filter === button));
      shown = cards.filter((card, index) => {
        card.hidden = key !== "all" && tools[index].category !== key;
        return !card.hidden;
      });
      announceGroup();
      track.scrollTo({ left: 0, behavior: "instant" });
      updateScrollControls();
    });
  });

  function announceGroup() {
    const ready = shown.filter((card) => card.querySelector("[data-ready]")).length;
    const comingSoon = shown.length - ready;
    const readyText = ready === 0 ? "No available tools for now" : ready + " available";
    const comingSoonText = comingSoon === 0 ? "no new tools for now" : comingSoon + " coming soon";
    availability.textContent = readyText + " · " + comingSoonText;
  }

  function scrollCards(direction, page = false) {
    if (shown.length === 0) return;
    const gap = parseFloat(getComputedStyle(track).columnGap);
    const stride = shown[0].getBoundingClientRect().width + gap;
    const count = page ? Math.max(1, Math.floor((track.clientWidth + gap + 1) / stride)) : 1;
    track.scrollBy({ left: direction * stride * count, behavior: reducedMotion.matches ? "instant" : "smooth" });
  }

  previous.addEventListener("click", () => {
    if (previous.getAttribute("aria-disabled") === "false") scrollCards(-1, true);
  });
  next.addEventListener("click", () => {
    if (next.getAttribute("aria-disabled") === "false") scrollCards(1, true);
  });
  track.addEventListener("keydown", (event) => {
    if (event.target !== track) return;
    const behavior = reducedMotion.matches ? "instant" : "smooth";
    switch (event.key) {
      case "ArrowLeft": scrollCards(-1); break;
      case "ArrowRight": scrollCards(1); break;
      case "Home": track.scrollTo({ left: 0, behavior }); break;
      case "End": track.scrollTo({ left: track.scrollWidth, behavior }); break;
      default: return;
    }
    event.preventDefault();
  });

  let frame = 0;
  track.addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateScrollControls();
    });
  }, { passive: true });

  announceGroup();
  directory.hidden = false;
  updateScrollControls();
  new ResizeObserver(updateScrollControls).observe(track);
}

const scientificDirectory = document.querySelector('[data-tools-directory="scientific"]');
if (scientificDirectory) setupToolDirectory(scientificDirectory, scientificTools, "h2");

const nonResearcherDirectory = document.querySelector('[data-tools-directory="non-researcher"]');
if (nonResearcherDirectory) setupToolDirectory(nonResearcherDirectory, nonResearcherTools, "h3");

const homeTools = document.querySelector("[data-home-tools]");
if (homeTools) {
  homeTools.replaceChildren(...scientificTools.map((tool) => createToolCard(tool, "h3")));
  homeTools.hidden = scientificTools.length === 0;
}
