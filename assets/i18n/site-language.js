(() => {
  const languages = {
    az: ["Azərbaycanca", "Dil"],
    en: ["English", "Language"],
    tr: ["Türkçe", "Dil"],
    ru: ["Русский", "Язык"],
    zh: ["简体中文", "语言"],
    es: ["Español", "Idioma"],
  };
  const catalog = new Map();
  const pending = new Map();
  const originals = new WeakMap();
  const exclusions = "script, style, code, kbd, [translate=no], .site-language";
  const attributes = ["alt", "aria-label", "aria-description", "aria-valuetext", "label", "placeholder", "title", "content", "value"];
  const normalize = (text) => text.trim().replace(/\s+/g, " ");
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let language = "en";
  let revision = 0;
  const languageTag = (code) => code === "zh" ? "zh-Hans" : code;

  function load(code) {
    if (catalog.has(code) || code === "en") return Promise.resolve();
    if (pending.has(code)) return pending.get(code);
    const script = document.createElement("script");
    script.src = siteAsset("assets/i18n/" + code + ".js");
    const promise = new Promise((resolve, reject) => {
      script.onload = () => {
        pending.delete(code);
        if (catalog.has(code)) resolve();
        else reject(new Error("Language catalog missing"));
      };
      script.onerror = () => {
        pending.delete(code);
        script.remove();
        reject(new Error("Language catalog unavailable"));
      };
    });
    pending.set(code, promise);
    document.head.append(script);
    return promise;
  }

  function register(code, messages, templates) {
    const patterns = new Map();
    for (const [key, value] of Object.entries(templates)) {
      const parts = key.split("{}");
      // Start with the most selective fixed segment before trying the complete pattern.
      const longest = parts.reduce((best, part) => part.length > best.length ? part : best, "");
      if (longest.trim().length < 4 && key !== "{} · {}" && key !== "{} of {}") continue;
      const prefix = parts[0] ? parts[0].match(/^[\p{L}\p{N}]+/u)?.[0] ?? "" : "";
      if (!patterns.has(prefix)) patterns.set(prefix, []);
      const field = key === "{} of {}" ? "(\\d+(?:–\\d+)?)" : "(.+?)";
      patterns.get(prefix).push({
        longest,
        specificity: parts.join("").length,
        regex: new RegExp("^" + parts.map(escape).join(field) + "$", "u"),
        value,
      });
    }
    for (const group of patterns.values()) group.sort((a, b) => b.specificity - a.specificity);
    catalog.set(code, { messages, patterns });
  }

  function translate(source, depth = 0) {
    if (typeof source !== "string") return source;
    const dictionary = catalog.get(language);
    const key = normalize(source);
    if (!dictionary || !/[A-Za-z]{2}/.test(key)) return source;
    let result = Object.hasOwn(dictionary.messages, key) ? dictionary.messages[key] : undefined;
    if (result === undefined && depth < 2 && key.length < 1000) {
      const prefix = key.match(/^[\p{L}\p{N}]+/u)?.[0] ?? "";
      const groups = prefix ? [dictionary.patterns.get(prefix), dictionary.patterns.get("")] : [dictionary.patterns.get("")];
      for (const group of groups) {
        if (!group) continue;
        for (const { longest, regex, value } of group) {
          const match = key.includes(longest) && regex.exec(key);
          if (!match) continue;
          result = value.replace(/\{(\d+)\}/g, (_, index) => translate(match[Number(index) + 1], depth + 1));
          break;
        }
        if (result !== undefined) break;
      }
    }
    if (result === undefined) return source;
    return source.match(/^\s*/)[0] + result + source.match(/\s*$/)[0];
  }

  function localize(node, property, current, update) {
    if (current === null) return;
    let values = originals.get(node);
    let previous = values?.get(property);
    if (!previous || previous.rendered !== current) {
      if (!/[A-Za-z]{2}/.test(current)) return;
      previous = { source: current, rendered: current };
      if (!values) originals.set(node, values = new Map());
      values.set(property, previous);
    }
    previous.rendered = translate(previous.source);
    if (current !== previous.rendered) update(previous.rendered);
  }

  function localizeText(node) {
    if (!node.parentElement || node.parentElement.closest(exclusions)) return;
    if (node.parentElement.matches("option:not([value])")) {
      // An option without a value attribute otherwise submits its translated label.
      node.parentElement.setAttribute("value", node.parentElement.value);
    }
    localize(node, "text", node.data, (value) => { node.data = value; });
  }

  function localizeAttributes(element) {
    if (element.closest(exclusions)) return;
    for (const attribute of attributes) {
      if (attribute === "value" && !element.matches('input[type="button"], input[type="submit"], input[type="reset"]')) continue;
      if (attribute === "content" && !element.matches('meta[name="description"]')) continue;
      if (attribute === "label" && !element.matches("option, optgroup")) continue;
      if (element.hasAttribute(attribute)) {
        localize(element, attribute, element.getAttribute(attribute), (value) => element.setAttribute(attribute, value));
      }
    }
  }

  function localizeTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      localizeText(root);
      return;
    }
    if (!(root instanceof Element) || root.closest(exclusions)) return;
    localizeAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeType === Node.ELEMENT_NODE && node.matches(exclusions)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) localizeText(node);
      else localizeAttributes(node);
    }
  }

  const observer = new MutationObserver((records) => {
    observer.disconnect();
    for (const record of records) {
      if (record.type === "attributes") localizeAttributes(record.target);
      else if (record.type === "characterData") localizeText(record.target);
      else {
        for (const node of record.addedNodes) {
          if (node.isConnected) localizeTree(node);
        }
      }
    }
    observe();
  });

  function observe() {
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes,
    });
  }

  function updateLinks() {
    for (const link of document.querySelectorAll("a[data-route]")) {
      link.href = sitePage(link.dataset.route);
    }
    for (const link of document.querySelectorAll("a[href]:not([data-route])")) {
      if (link.getAttribute("href").startsWith("#")) continue;
      const url = new URL(link.href, location.href);
      if (!url.href.startsWith(siteAsset("")) || !url.searchParams.has("lang")) continue;
      url.searchParams.set("lang", language);
      link.href = url.href;
    }
  }

  async function apply(code, save) {
    if (!Object.hasOwn(languages, code)) return;
    const current = ++revision;
    await load(code);
    if (current !== revision) return;
    observer.disconnect();
    language = code;
    if (save) saveAstroNotLanguage(code);
    document.documentElement.lang = languageTag(code);
    localizeTree(document.documentElement);
    updateLinks();
    if (code !== "en") observe();
    window.dispatchEvent(new Event("astronot-languagechange"));
  }

  window.AstroNotLanguage = { register, translate };

  const nav = document.querySelector(".site-nav, .workspace-bar__inner");
  if (!nav) return;

  const picker = document.createElement("div");
  picker.className = "site-language";
  picker.setAttribute("translate", "no");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "site-language__toggle";
  toggle.setAttribute("aria-controls", "site-language-options");
  toggle.setAttribute("aria-expanded", "false");

  const options = document.createElement("div");
  options.className = "site-language__options";
  options.id = "site-language-options";
  options.setAttribute("role", "group");
  options.hidden = true;

  const status = document.createElement("p");
  status.className = "site-language__status";
  status.setAttribute("role", "status");
  picker.append(toggle, options, status);
  nav.append(picker);

  function setOpen(open) {
    if (open) status.textContent = "";
    toggle.setAttribute("aria-expanded", String(open));
    options.hidden = !open;
  }

  function refreshSelection() {
    const [name, label] = languages[language];
    toggle.textContent = name;
    toggle.lang = languageTag(language);
    toggle.setAttribute("aria-label", label + ": " + name);
    options.setAttribute("aria-label", label);
    for (const button of options.children) button.setAttribute("aria-pressed", String(button.value === language));
  }

  async function choose(code, save = true) {
    status.textContent = "";
    try {
      await apply(code, save);
    } catch {
      status.textContent = translate("Could not load the selected language.");
    }
    refreshSelection();
  }

  for (const [code, [name]] of Object.entries(languages)) {
    const button = document.createElement("button");
    button.type = "button";
    button.value = code;
    button.lang = languageTag(code);
    button.textContent = name;
    button.addEventListener("click", () => {
      setOpen(false);
      toggle.focus();
      choose(code);
    });
    options.append(button);
  }

  toggle.addEventListener("click", () => setOpen(options.hidden));
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !options.hidden) {
      event.preventDefault();
      setOpen(false);
      toggle.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...options.children];
    const index = buttons.indexOf(event.target);
    const step = event.key === "ArrowDown" ? 1 : -1;
    setOpen(true);
    const selected = index < 0 ? buttons.findIndex((button) => button.value === language) : index + step;
    buttons[(selected + buttons.length) % buttons.length].focus();
  });
  picker.addEventListener("focusout", (event) => {
    if (!picker.contains(event.relatedTarget)) setOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!picker.contains(event.target)) setOpen(false);
  });

  refreshSelection();
  choose(getAstroNotLanguage(), false);
})();
