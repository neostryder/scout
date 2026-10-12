// Density choice: Auto picks roomy rows on a touch screen and tight rows with a mouse, and Comfortable and Compact override it. The choice is remembered in this browser.
const MODES = ["auto", "comfortable", "compact"];
const LABEL = { auto: "Auto", comfortable: "Comfortable", compact: "Compact" };
const SVG = "http://www.w3.org/2000/svg";
// Each icon is a stack of lines on a 24 by 24 grid: widely spaced for Comfortable, tightly spaced for Compact, and a shorter stack beside a spark for Auto.
const ICON = {
  auto: [["path", { d: "M4 7h10M4 12h10M4 17h10" }], ["path", { d: "M19 5v4M17 7h4M19 15v4M17 17h4" }]],
  comfortable: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
  compact: [["path", { d: "M4 8h16M4 11h16M4 14h16M4 17h16" }]],
};

function stored() {
  try { return MODES.includes(localStorage.getItem("scout-density")) ? localStorage.getItem("scout-density") : "auto"; } catch { return "auto"; }
}

function apply(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-density");
  else document.documentElement.setAttribute("data-density", mode);
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
  if (!header || header.querySelector(".density-toggle")) return;
  let mode = stored();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "density-toggle theme-toggle";
  button.style.marginLeft = "0";
  const paint = () => {
    button.replaceChildren(icon(mode));
    const next = LABEL[MODES[(MODES.indexOf(mode) + 1) % MODES.length]];
    button.title = `Density: ${LABEL[mode]}. Click for ${next}.`;
    button.setAttribute("aria-label", `Density: ${LABEL[mode]}. Click for ${next}.`);
  };
  button.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem("scout-density", mode); } catch { /* the choice just will not be remembered */ }
    apply(mode);
    paint();
  });
  paint();
  const theme = header.querySelector(".theme-toggle");
  if (theme) theme.after(button);
  else header.append(button);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
