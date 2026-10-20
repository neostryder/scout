// The phone navigation: a bar along the bottom of the screen with the pages used most and a More sheet for the rest. It reads the address, so it follows every page and Services tab the portal opens.
const MAIN = [
  { id: "services", label: "Services", href: "/?view=services", match: (v, t) => v === "services" && !["alerts", "outages"].includes(t), path: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" },
  { id: "resources", label: "Resources", href: "/?view=resources", match: (v) => v === "resources", path: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { id: "alerts", label: "Alerts", href: "/?view=services&tab=alerts", match: (v, t) => v === "services" && t === "alerts", path: "M12 3a6 6 0 0 0-6 6c0 6-2 7-2 7h16s-2-1-2-7a6 6 0 0 0-6-6zM10 20h4" },
  { id: "outages", label: "Outages", href: "/?view=services&tab=outages", match: (v, t) => v === "services" && t === "outages", path: "M13 2L4 14h7l-1 8 9-12h-7z" },
];
const MORE = [
  { label: "Updates", href: "/", view: "updates" },
  { label: "Competitors", href: "/?view=competitors", view: "competitors", count: "competitors-count" },
  { label: "Catalog", href: "/?view=catalog", view: "catalog" },
  { label: "Review queue", href: "/?view=review", view: "review" },
  { label: "Jobs", href: "/?view=jobs", view: "jobs" },
  { label: "Settings", href: "/?view=settings", view: "settings" },
];
const SVG = "http://www.w3.org/2000/svg";

function icon(path) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const part = document.createElementNS(SVG, "path");
  part.setAttribute("d", path);
  svg.append(part);
  return svg;
}

function current() {
  const params = new URLSearchParams(location.search);
  return { view: params.get("view") || "updates", tab: params.get("tab") || "" };
}

// A tap moves inside the page: the address changes and the portal's own popstate handler draws the new view.
function go(href) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const plain = (event) => !(event.metaKey || event.ctrlKey || event.shiftKey || event.button);

function mount() {
  if (document.querySelector(".tabbar")) return;
  const bar = document.createElement("nav");
  bar.className = "tabbar";
  bar.setAttribute("aria-label", "Main");
  const sheet = document.createElement("div");
  sheet.className = "tab-sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "menu");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tab";
  more.setAttribute("aria-haspopup", "true");
  more.setAttribute("aria-expanded", "false");
  const close = () => { sheet.hidden = true; more.setAttribute("aria-expanded", "false"); };
  const links = MAIN.map((item) => {
    const link = document.createElement("a");
    link.href = item.href;
    link.className = "tab";
    link.dataset.tab = item.id;
    const label = document.createElement("span");
    label.textContent = item.label;
    link.append(icon(item.path), label);
    link.addEventListener("click", (event) => { if (!plain(event)) return; event.preventDefault(); close(); go(item.href); });
    return link;
  });
  const moreLabel = document.createElement("span");
  moreLabel.textContent = "More";
  more.append(icon("M5 12h.01M12 12h.01M19 12h.01"), moreLabel);
  const entries = MORE.map((item) => {
    const link = document.createElement("a");
    link.href = item.href;
    link.setAttribute("role", "menuitem");
    link.textContent = item.label;
    if (item.count) {
      const mark = document.createElement("span");
      mark.className = "badge";
      link.append(mark);
      const source = document.getElementById(item.count);
      const sync = () => { mark.textContent = source ? source.textContent : ""; };
      if (source) new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true });
      sync();
    }
    link.addEventListener("click", (event) => { if (!plain(event)) return; event.preventDefault(); close(); go(item.href); });
    return { link, item };
  });
  sheet.append(...entries.map((entry) => entry.link));
  more.addEventListener("click", () => { sheet.hidden = !sheet.hidden; more.setAttribute("aria-expanded", String(!sheet.hidden)); });
  document.addEventListener("click", (event) => { if (!sheet.hidden && !bar.contains(event.target) && !sheet.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) { close(); more.focus(); } });
  bar.append(...links, more);
  document.body.append(sheet, bar);
  const paint = () => {
    const { view, tab } = current();
    MAIN.forEach((item, index) => links[index].setAttribute("aria-current", String(item.match(view, tab))));
    for (const { link, item } of entries) link.setAttribute("aria-current", String(item.view === view));
    more.setAttribute("aria-current", String(MORE.some((item) => item.view === view)));
  };
  // The portal also changes the address with replaceState, which raises no event, so each change is reported here.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method].bind(history);
    history[method] = (...args) => { const result = original(...args); paint(); return result; };
  }
  window.addEventListener("popstate", paint);
  const badge = document.querySelector("#alerts-badge");
  if (badge) {
    const sync = () => { links[2].dataset.count = badge.hidden ? "" : badge.textContent.replace(/\D/g, ""); links[2].dataset.tone = badge.dataset.tone || ""; };
    new MutationObserver(sync).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  paint();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
