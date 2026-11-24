"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const dom = {
    statuses: $("#status-tabs"), regions: $("#region-tabs"), types: $("#type-choices"),
    references: $("#reference-choices"), typeSelect: $("#type-select"), grid: $("#poster-grid"),
    title: $("#collection-title"), path: $("#collection-path"), count: $("#result-count"),
    search: $("#title-search"), sort: $("#sort-select"), country: $("#country-select"), dialog: $("#detail-dialog"),
    detail: $("#dialog-content"), loading: $("#load-state"), source: $("#source-line")
  };
  const state = { status: "Watched", region: "International", type: "Cinema", reference: null, query: "", sort: "title", country: "" };
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const statusOrder = ["Watched", "Watchlist"];
  const regionOrder = ["International", "Indian"];
  const typeOrder = ["Cinema", "TV series", "Short Films", "Documentaries", "Animated documentaries", "Theatre Acts-Musicals", "Anime"];
  let records = [];
  let referenceGroups = [];
  let lastTrigger = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value);
      return /^(https?:)$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function values(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => typeof item === "string" ? item : item?.name || item?.title || "").filter(Boolean);
  }

  function titleOf(record) {
    if (typeof record.title === "string" && record.title.trim()) return record.title.trim();
    const identity = record.imdbId || record.id;
    if (record.kind === "person") return `IMDb person ${identity}`;
    if (record.kind === "list") return `IMDb list ${identity}`;
    if (record.kind === "title") return `IMDb title ${identity}`;
    const url = safeHttpUrl(record.sourceUrl) || (record.sourceUrls || []).map(safeHttpUrl).find(Boolean);
    if (url) {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, "");
      if (parsed.hostname === "en.wikipedia.org" && path.startsWith("/wiki/")) return decodeURIComponent(path.slice(6)).replace(/_/g, " ");
      return `${parsed.hostname.replace(/^www\./, "")}${path === "/" ? "" : path}`;
    }
    return `Source link ${identity || ""}`.trim();
  }

  function normalize(value) {
    return String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function placements(record) { return Array.isArray(record.placements) ? record.placements : []; }
  function isListPlacement(placement) { return /imdb\s+lists?/i.test(placement.type || ""); }
  function inBranch(record, status = state.status, region = state.region, type = null) {
    return placements(record).some(p => p.status === status && (!region || p.region === region) && (!type || p.type === type));
  }
  function branchTypes() {
    const types = new Set();
    for (const record of records) for (const p of placements(record)) {
      if (p.status === state.status && p.region === state.region && !isListPlacement(p)) types.add(p.type);
    }
    return [...types].filter(Boolean).sort((a, b) => {
      const ai = typeOrder.indexOf(a), bi = typeOrder.indexOf(b);
      return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || collator.compare(a, b);
    });
  }
  function availableRegions(status) {
    const all = new Set(records.flatMap(record => placements(record).filter(p => p.status === status).map(p => p.region).filter(Boolean)));
    return [...regionOrder.filter(region => all.has(region)), ...[...all].filter(region => !regionOrder.includes(region)).sort(collator.compare)];
  }
  function ensureBranch() {
    const regions = availableRegions(state.status);
    if (!regions.includes(state.region)) state.region = regions[0] || null;
    const types = branchTypes();
    if (!types.includes(state.type)) state.type = types.includes("Cinema") ? "Cinema" : types[0] || null;
  }
  function countBranch(status, region = null, type = null) {
    return records.filter(record => inBranch(record, status, region, type)).length;
  }
  function makeChoice(className, label, count, pressed, action) {
    const button = element("button", className);
    button.type = "button";
    button.setAttribute("aria-pressed", String(pressed));
    button.append(element("span", "", label), element("span", "nav-count", count));
    button.addEventListener("click", action);
    return button;
  }

  function referenceCollection() {
    const groups = new Map();
    for (const record of records) for (const p of placements(record)) {
      if (p.status === "Reference") {
        const key = `source:${p.type}`;
        if (!groups.has(key)) groups.set(key, { key, label: p.type, records: new Set() });
        groups.get(key).records.add(record);
      }
    }
    const lists = records.filter(record => record.kind === "list" || placements(record).some(isListPlacement));
    if (lists.length) groups.set("imdb-lists", { key: "imdb-lists", label: "IMDb lists", records: new Set(lists) });
    const unplaced = records.filter(record => !placements(record).length);
    if (unplaced.length) groups.set("other-sources", { key: "other-sources", label: "Other sources", records: new Set(unplaced) });
    return [...groups.values()].map(group => ({ ...group, records: [...group.records] }));
  }

  function chooseBranch(status, region) {
    state.country = "";
    state.status = status;
    if (region !== undefined) state.region = region;
    state.reference = null;
    state.type = "Cinema";
    ensureBranch();
    render();
  }

  function renderNavigation() {
    dom.statuses.replaceChildren(...statusOrder.map(status => makeChoice("status-tab", status, countBranch(status), !state.reference && state.status === status, () => chooseBranch(status))));
    dom.regions.replaceChildren(...availableRegions(state.status).map(region => makeChoice("region-tab", region, countBranch(state.status, region), state.region === region, () => chooseBranch(state.status, region))));
    dom.regions.hidden = Boolean(state.reference);
    const types = branchTypes();
    dom.types.replaceChildren(...types.map(type => makeChoice("type-choice", type, countBranch(state.status, state.region, type), !state.reference && state.type === type, () => {
      state.type = type;
      state.reference = null;
      render();
    })));
    dom.references.replaceChildren(...referenceGroups.map(group => makeChoice("reference-choice", group.label, group.records.length, state.reference === group.key, () => {
      state.reference = group.key;
      render();
    })));
    $("#reference-section").hidden = !referenceGroups.length;

    const options = [];
    if (types.length) {
      const branch = element("optgroup");
      branch.label = [state.status, state.region].filter(Boolean).join(" / ");
      for (const type of types) {
        const option = element("option", "", `${type} (${countBranch(state.status, state.region, type)})`);
        option.value = `type:${type}`;
        branch.append(option);
      }
      options.push(branch);
    }
    if (referenceGroups.length) {
      const references = element("optgroup");
      references.label = "Reference";
      for (const group of referenceGroups) {
        const option = element("option", "", `${group.label} (${group.records.length})`);
        option.value = `ref:${group.key}`;
        references.append(option);
      }
      options.push(references);
    }
    dom.typeSelect.replaceChildren(...options);
    dom.typeSelect.value = state.reference ? `ref:${state.reference}` : `type:${state.type}`;
  }

  function countriesOf(record) {
    const aliases = {"West Germany":"Germany", "Weimar Republic":"Germany", "Kingdom of Italy":"Italy", "People's Republic of China":"China"};
    const found = values(record.countries).map(c => aliases[c] || c);
    if (!found.length && placements(record).some(p => p.region === "Indian")) found.push("India");
    return [...new Set(found)];
  }
  function renderCountries(branch) {
    const names = [...new Set(branch.flatMap(countriesOf))].sort(collator.compare);
    if (state.country && !names.includes(state.country) && state.country !== "unknown") state.country = "";
    const options = [["", "All countries"], ...names.map(c => [c,c])];
    if (branch.some(r => !countriesOf(r).length)) options.push(["unknown", "Country not listed"]);
    dom.country.replaceChildren(...options.map(([value,label]) => { const o=element("option", "", label);o.value=value;return o; }));
    dom.country.value=state.country;
    dom.country.closest("label").hidden=Boolean(state.reference) || state.region !== "International";
  }

  function posterMark(kind) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 32 28");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("fallback-mark");
    const path = document.createElementNS(ns, "path");
    if (kind === "person") path.setAttribute("d", "M21 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM6 25c0-6 4-10 10-10s10 4 10 10");
    else if (kind === "list" || kind === "link") path.setAttribute("d", "M4 5h24M4 14h24M4 23h24");
    else path.setAttribute("d", "M1 2h30v24H1ZM7 2v24M25 2v24M1 8h6M1 14h6M1 20h6M25 8h6M25 14h6M25 20h6m-18-12 8 6-8 6Z");
    svg.append(path);
    return svg;
  }

  function posterFrame(record, detail = false) {
    const frame = element("span", `poster-frame${detail ? " detail-poster" : ""}`);
    frame.setAttribute("aria-hidden", "true");
    const fallback = element("span", "poster-fallback");
    fallback.append(posterMark(record.kind), element("span", "fallback-title", titleOf(record)), element("span", "fallback-label", record.kind === "person" ? "Filmmaker" : record.kind === "list" ? "IMDb list" : record.kind === "link" ? "Source link" : "No poster"));
    frame.append(fallback);
    const url = safeHttpUrl(typeof record.poster === "string" ? record.poster : record.poster?.url || record.poster?.src);
    if (url) {
      const fallbackLabel = fallback.querySelector(".fallback-label");
      fallbackLabel.hidden = true;
      const image = element("img");
      image.alt = "";
      image.width = 300;
      image.height = 450;
      image.loading = detail ? "eager" : "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("load", () => frame.classList.add("is-loaded"), { once: true });
      let retriedOriginal = false;
      image.addEventListener("error", () => {
        if (!retriedOriginal && image.src !== url) {
          retriedOriginal = true;
          image.src = url;
          return;
        }
        image.remove();
        frame.classList.remove("is-loaded");
        fallbackLabel.textContent = "Poster unavailable";
        fallbackLabel.hidden = false;
      });
      image.src = new URL(url).hostname === "m.media-amazon.com" ? url.replace("._V1_.jpg", detail ? "._V1_QL85_UX600_.jpg" : "._V1_QL75_UX360_.jpg") : url;
      frame.append(image);
      if (image.complete && image.naturalWidth) frame.classList.add("is-loaded");
    }
    return frame;
  }

  function card(record) {
    const li = element("li");
    li.dataset.recordId = record.id;
    const button = element("button", "film-card");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    const caption = element("span", "film-caption");
    caption.append(element("span", "film-title", titleOf(record)));
    const directors = values(record.directors);
    const year = Number.isFinite(record.year) ? String(record.year) : "";
    if (year) caption.append(element("span", "film-meta film-year", year));
    if (directors.length) caption.append(element("span", "film-meta film-directors", directors.join(", ")));
    if (!year && !directors.length && record.kind !== "title") caption.append(element("span", "film-meta", record.kind === "person" ? "Filmmaker" : record.kind === "list" ? "IMDb list" : "Source link"));
    button.append(posterFrame(record), caption);
    button.addEventListener("click", () => showDetails(record, button));
    li.append(button);
    return li;
  }

  function render() {
    renderNavigation();
    const group = referenceGroups.find(item => item.key === state.reference);
    let visible = group ? group.records : records.filter(record => inBranch(record, state.status, state.region, state.type));
    renderCountries(visible);
    if (!group && state.country) visible = visible.filter(r => state.country === "unknown" ? !countriesOf(r).length : countriesOf(r).includes(state.country));
    const total = visible.length;
    const terms = normalize(state.query.trim()).split(/\s+/).filter(Boolean);
    visible = visible.filter(record => {
      const haystack = normalize([titleOf(record), record.originalTitle || "", ...values(record.directors), ...countriesOf(record)].join(" "));
      return terms.every(term => haystack.includes(term));
    }).sort((a, b) => {
      if (state.sort !== "title") {
        const aYear = Number.isFinite(a.year) ? a.year : null;
        const bYear = Number.isFinite(b.year) ? b.year : null;
        if (aYear === null && bYear !== null) return 1;
        if (aYear !== null && bYear === null) return -1;
        if (aYear !== null && bYear !== null && aYear !== bYear) return state.sort === "year-desc" ? bYear - aYear : aYear - bYear;
      }
      return collator.compare(titleOf(a), titleOf(b)) || collator.compare(a.id, b.id);
    });
    dom.title.textContent = group ? group.label : state.type || "Cinema";
    dom.path.textContent = group ? "Reference" : [state.status, state.region].filter(Boolean).join(" / ");
    dom.count.textContent = terms.length ? `${visible.length} of ${total} entries` : `${total} ${total === 1 ? "entry" : "entries"}`;
    dom.grid.replaceChildren(...visible.map(card));
    $("#empty-state").hidden = visible.length > 0;
    $("#empty-message").textContent = terms.length ? "No entries match this search." : "This collection has no entries.";
    $("#clear-search").hidden = !terms.length;
  }

  function link(label, url) {
    const safe = safeHttpUrl(url);
    if (!safe) return null;
    const a = element("a", "", label);
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function fact(list, label, value) {
    if (!value) return;
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    list.append(row);
  }

  function sanitizedNotes(html) {
    const fragment = document.createDocumentFragment();
    if (typeof html !== "string" || !html.trim()) return fragment;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const allowed = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "H3", "H4", "H5", "CODE", "PRE", "SUP", "SUB", "HR", "SPAN", "DIV", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
    const discarded = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SVG", "MATH", "TEMPLATE"]);
    function copy(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || discarded.has(node.tagName)) return;
      let clean;
      if (node.tagName === "A") {
        const url = safeHttpUrl(node.getAttribute("href"));
        clean = url ? link("", url) : element("span");
      } else if (node.tagName === "IMG") {
        const url = safeHttpUrl(node.getAttribute("src"));
        if (!url) return;
        clean = element("img");
        clean.src = url;
        clean.alt = node.getAttribute("alt") || "";
        clean.loading = "lazy";
        clean.referrerPolicy = "no-referrer";
      } else if (allowed.has(node.tagName)) clean = element(node.tagName.toLowerCase());
      else { for (const child of node.childNodes) copy(child, parent); return; }
      for (const child of node.childNodes) copy(child, clean);
      parent.append(clean);
    }
    for (const child of parsed.body.childNodes) copy(child, fragment);
    return fragment;
  }

  function showDetails(record, trigger) {
    lastTrigger = trigger;
    const header = element("div", "detail-header");
    const heading = element("div", "detail-heading");
    const selectedPlacement = placements(record).find(p => state.reference ? p.status === "Reference" || isListPlacement(p) : p.status === state.status && p.region === state.region && p.type === state.type);
    const kind = selectedPlacement?.type || (record.kind === "person" ? "Filmmaker" : record.kind === "list" ? "IMDb list" : "Cinema");
    heading.append(element("p", "detail-kind", kind));
    const title = element("h2", "", titleOf(record));
    title.id = "dialog-title";
    heading.append(title);
    if (Number.isFinite(record.year)) heading.append(element("p", "detail-year", record.year));
    if (record.originalTitle && record.originalTitle !== record.title) heading.append(element("p", "detail-original", record.originalTitle));
    const facts = element("dl", "detail-facts");
    fact(facts, values(record.directors).length === 1 ? "Director" : "Directors", values(record.directors).join(", "));
    fact(facts, values(record.countries).length === 1 ? "Country" : "Countries", values(record.countries).join(", "));
    fact(facts, values(record.languages).length === 1 ? "Language" : "Languages", values(record.languages).join(", "));
    const sourcePlacements = [...new Set(placements(record).map(p => [p.status, p.region, p.type].filter(Boolean).join(" / ")))];
    fact(facts, "Collection", sourcePlacements.join("; "));
    if (facts.children.length) heading.append(facts);
    header.append(posterFrame(record, true), heading);
    const content = [header];
    const notes = sanitizedNotes(record.notesHtml);
    if (notes.childNodes.length) {
      const section = element("div", "detail-notes");
      section.append(notes);
      content.push(section);
    }
    const links = element("div", "detail-links");
    const originalUrls = [...new Set((Array.isArray(record.sourceUrls) ? record.sourceUrls : []).map(safeHttpUrl).filter(Boolean))];
    if (!originalUrls.length && safeHttpUrl(record.sourceUrl)) originalUrls.push(safeHttpUrl(record.sourceUrl));
    originalUrls.forEach((url, index) => links.append(link(originalUrls.length === 1 ? "Original source" : `Original source ${index + 1}`, url)));
    const canonical = safeHttpUrl(record.sourceUrl);
    if (canonical && !originalUrls.includes(canonical)) links.append(link(canonical.includes("imdb.com/") ? "IMDb" : "Source", canonical));
    if (links.children.length) content.push(links);
    const posterSource = safeHttpUrl(typeof record.poster === "string" ? record.sourceUrl : record.poster?.sourceUrl);
    if (posterSource) {
      const credit = element("p", "poster-credit");
      credit.append(link("Poster source", posterSource));
      content.push(credit);
    }
    dom.detail.replaceChildren(...content);
    dom.dialog.showModal();
    dom.dialog.scrollTop = 0;
  }

  function renderSource(source) {
    const sourceUrl = safeHttpUrl(source?.url);
    if (!sourceUrl) return;
    const sourcePart = element("span");
    sourcePart.append(document.createTextNode("Source: "), link("Notion", sourceUrl));
    dom.source.replaceChildren(sourcePart);
    dom.source.hidden = false;
  }

  dom.search.addEventListener("input", () => { state.query = dom.search.value; render(); });
  dom.country.addEventListener("change", () => { state.country = dom.country.value; render(); });
  dom.sort.addEventListener("change", () => { state.sort = dom.sort.value; render(); });
  dom.typeSelect.addEventListener("change", () => {
    const value = dom.typeSelect.value;
    if (value.startsWith("ref:")) state.reference = value.slice(4);
    else { state.type = value.slice(5); state.reference = null; }
    render();
  });
  $("#clear-search").addEventListener("click", () => { state.query = ""; dom.search.value = ""; render(); dom.search.focus(); });
  dom.dialog.addEventListener("close", () => { lastTrigger?.focus({ preventScroll: true }); });
  dom.dialog.addEventListener("click", event => {
    if (event.target !== dom.dialog) return;
    const rect = dom.dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dom.dialog.close();
  });

  const themeButton = $("#theme-toggle");
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
    $("meta[name='theme-color']").content = theme === "dark" ? "#1d1d1d" : "#f6f3ed";
  }
  try { setTheme(localStorage.getItem("cinema-theme") === "light" ? "light" : "dark"); } catch { setTheme("dark"); }
  themeButton.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    try { localStorage.setItem("cinema-theme", theme); } catch { /* Theme still works when storage is unavailable. */ }
  });

  fetch("./data/cinema.json")
    .then(response => {
      if (!response.ok) throw new Error(`Collection request failed (${response.status})`);
      return response.json();
    })
    .then(data => {
      if (!Array.isArray(data.records)) throw new Error("The collection data is not available.");
      records = data.records;
      referenceGroups = referenceCollection();
      ensureBranch();
      render();
      $("#collection-navigation").hidden = false;
      $("#screening-room").hidden = false;
      dom.loading.hidden = true;
    })
    .catch(error => {
      dom.loading.replaceChildren(document.createTextNode("The collection could not be loaded. "));
      const retry = element("button", "text-button", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => window.location.reload());
      dom.loading.append(retry);
      console.error(error);
    });
})();
