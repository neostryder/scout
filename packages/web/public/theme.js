// Theme choice: Auto follows the system, Light and Dark override it. The choice is remembered in this browser.
const MODES = ["auto", "light", "dark"];
const LABEL = { auto: "Auto", light: "Light", dark: "Dark" };
const SVG = "http://www.w3.org/2000/svg";
// Each icon is a list of [tag, attributes] drawn on a 24 by 24 grid: a half-lit circle for Auto, a sun for Light, a moon for Dark.
const ICON = {
  auto: [["circle", { cx: 12, cy: 12, r: 8 }], ["path", { d: "M12 4v16", }], ["path", { d: "M12 4a8 8 0 0 1 0 16z", fill: "currentColor" }]],
  light: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]],
  dark: [["path", { d: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" }]],
};

function stored() {
  try { return MODES.includes(localStorage.getItem("scout-theme")) ? localStorage.getItem("scout-theme") : "auto"; } catch { return "auto"; }
}

function apply(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
}

function icon(mode) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of ICON[mode]) {
    const part = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, String(value));
    svg.append(part);
  }
  return svg;
}

apply(stored());

function mount() {
  const header = document.querySelector("header.top");
  if (!header || header.querySelector(".theme-toggle")) return;
  let mode = stored();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-toggle";
  const paint = () => {
    button.replaceChildren(icon(mode));
    button.title = `Theme: ${LABEL[mode]}`;
    button.setAttribute("aria-label", `Theme: ${LABEL[mode]}. Activate to change it.`);
  };
  button.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem("scout-theme", mode); } catch { /* the choice just will not be remembered */ }
    apply(mode);
    paint();
  });
  paint();
  header.append(button);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
