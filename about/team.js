// Renders the team profiles from about/team-data.js into the Team section.
(function () {
  const section = document.querySelector("[data-team]");
  if (!section) return;
  const empty = section.querySelector("[data-team-empty]");
  const list = section.querySelector("[data-team-list]");
  const members = Array.isArray(window.ASTRONOT_TEAM) ? window.ASTRONOT_TEAM : [];

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function photoUrl(photo) {
    const src = text(photo && photo.src);
    // Only files inside assets/team/ are accepted, so a profile cannot point anywhere else on the site.
    if (!/^assets\/team\/[a-z\d][a-z\d._-]*\.(?:jpg|png|svg)$/i.test(src)) return "";
    return typeof siteAsset === "function" ? siteAsset(src) : "../" + src;
  }

  function profileLink(link) {
    const label = text(link && link.label);
    let url;
    try {
      url = new URL(text(link && link.url));
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !label) return null;
    return { href: url.href, label };
  }

  function buildMember(member) {
    const name = text(member && member.name);
    const role = text(member && member.role);
    const contribution = text(member && member.contribution);
    if (!name || !role) return null;

    const item = element("li", "team-member");
    const article = element("article", "team-member__body");

    const src = photoUrl(member.photo);
    const alt = text(member.photo && member.photo.alt);
    const frame = element("span", "team-member__photo");
    if (src && alt) {
      const image = element("img", "team-member__image");
      image.src = src;
      image.alt = alt;
      image.width = 112;
      image.height = 112;
      image.loading = "lazy";
      image.decoding = "async";
      const crop = member.photo.crop;
      if (crop) {
        image.classList.add("team-member__image--cropped");
        image.style.width = 100 * crop.width / crop.size + "%";
        image.style.left = -100 * crop.left / crop.size + "%";
        image.style.top = -100 * crop.top / crop.size + "%";
      }
      frame.append(image);
    } else {
      frame.classList.add("team-member__photo--placeholder");
      frame.setAttribute("aria-hidden", "true");
    }
    article.append(frame);

    const copy = element("div", "team-member__copy");
    copy.append(element("h3", "team-member__name", name), element("p", "team-member__role", role));
    if (contribution) copy.append(element("p", "team-member__bio", contribution));

    const link = profileLink(member.link);
    if (link) {
      const anchor = element("a", "text-link team-member__link");
      anchor.href = link.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.append(link.label, element("span", "team-member__sr", " (opens in a new tab)"));
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M5 19 19 5M8 5h11v11");
      arrow.append(path);
      anchor.append(arrow);
      copy.append(anchor);
    }

    article.append(copy);
    item.append(article);
    return item;
  }

  const items = members.map(buildMember).filter(Boolean);
  if (!items.length) {
    // Nothing confirmed: keep the coming-soon message and show nothing else.
    empty.hidden = false;
    list.hidden = true;
    section.classList.remove("team--single", "team--group");
    return;
  }

  list.replaceChildren(...items);
  list.hidden = false;
  empty.hidden = true;
  section.classList.toggle("team--single", items.length === 1);
  section.classList.toggle("team--group", items.length > 1);
})();
