import { h } from "./lib.js";
import { exposureLabel, stateLabel } from "./services-model.js";

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

export function renderRoutes(routes, reader = { state: "never" }, onSelect = () => {}, onAll = () => {}, total = routes.length) {
  const quiet = reader.state === "off" ? "Cloudflare reader is off. Add a Cloudflare token to turn it on." : reader.state === "never" ? "Domains appear when the Cloudflare reader is connected." : "No public domains were found.";
  const age = reader.lastReadAt ? Math.max(0, Math.floor((Date.now() - Date.parse(reader.lastReadAt)) / 60000)) : null;
  const warning = ["stale", "failed"].includes(reader.state);
  const shown = routes.slice(0, 12);
  const placed = reader.state === "off" || reader.state === "never";
  return h("div", { class: `edge-band${warning ? " stale" : ""}` }, h("div", { class: "edge-heading" }, h("h2", {}, "Cloudflare edge"), h("span", { class: `edge-reader ${warning ? "stale" : ""}`, title: reader.error || "" }, age == null ? reader.state : `Cloudflare read ${age} min ago${reader.error ? `: ${reader.error}` : ""}`)), placed ? h("p", {}, quiet) : h("div", { class: "domain-chips" }, ...shown.map((row, index) => h("button", { type: "button", class: "domain-chip", "data-route-index": index, onclick: () => onSelect(row), "aria-label": `${row.hostname}${row.path || ""}, ${row.stateText}, ${row.via} via ${row.tunnel?.name || row.worker?.script || "DNS"}, ${row.machineName || "unplaced"}, ${row.origin?.service || "no origin"}, ${row.listener?.processName || "process unknown"}${row.access ? ", Access protected" : ", no Access"}` }, h("span", { class: `state-dot ${row.state}` }), row.access ? h("span", { class: "lock-mark", "aria-hidden": "true" }, "Lock") : null, h("strong", {}, `${row.hostname}${row.path || ""}`), h("small", {}, row.machineName && row.origin ? `${row.machineName}:${row.origin.port}` : "Unplaced"))), routes.some((row) => !row.machineName) ? h("span", { class: "unplaced-marker" }, "Unplaced routes") : null, total > 12 ? h("button", { type: "button", class: "show-domains", onclick: onAll }, `Show all ${total} domains`) : null, ...(!routes.length ? [h("p", {}, quiet)] : [])));
}

export function renderDiagram(root, machines, listeners, onSelect, routes = [], reader, onRouteSelect, onAll, totalRoutes) {
  const islands = machines.map((machine) => {
    const ports = listeners.filter((row) => row.machineId === machine.id && !row.classification.hidden && !row.goneAt && row.serviceName);
    const drawing = svg("svg", { viewBox: "0 0 400 88", preserveAspectRatio: "none", "aria-hidden": "true", class: "island-outline" }, svg("path", { d: "M44 4 H366 Q396 4 396 32 V60 Q396 84 364 84 H30 Q4 84 4 60 V34 Q4 4 44 4 Z", fill: "none", stroke: "currentColor", "stroke-width": "1" }));
    const label = svg("svg", { class: "island-label", "aria-hidden": "true" }, svg("circle", { cx: 8, cy: 22, r: 4, class: machine.live.state, fill: "currentColor" }), svg("text", { x: 22, y: 30, class: "island-name" }, machine.name), svg("text", { x: 0, y: 54, class: "island-caption" }, `${machine.os} - ${stateLabel(machine.live.state)}`), svg("text", { x: 0, y: 76, class: "island-caption" }, `${machine.services.running} running, ${machine.services.optionalRunning} could disable`));
    const button = h("button", { type: "button", class: "island-select", onclick: () => onSelect(machine, null), "aria-label": `Show ${machine.name} services and machine details. ${machine.os}, ${stateLabel(machine.live.state)}, ${machine.services.running} running, ${machine.services.optionalRunning} could disable` }, label);
    return h("section", { class: `island ${machine.live.state}`, "aria-label": machine.name }, drawing, button, h("div", { class: "port-markers" }, ...ports.map((row) => h("button", { type: "button", class: `port-marker ${row.bind}`, onclick: () => onSelect(machine, row), "aria-label": `${machine.name} port ${row.port}, ${row.processName || row.containerName || row.serviceName}, ${exposureLabel(row.bind)}` }, svg("svg", { viewBox: "0 0 8 8", width: 8, height: 8, "aria-hidden": "true" }, svg("circle", { cx: 4, cy: 4, r: 4, fill: "currentColor" })), ` ${row.port} ${row.processName || row.containerName || row.serviceName}`)), ...(ports.length ? [] : [h("p", { class: "quiet" }, "No visible listening services.")])));
  });
  root.replaceChildren(renderRoutes(routes, reader, onRouteSelect, onAll, totalRoutes), h("div", { class: "islands" }, ...islands), h("p", { class: "atlas-key quiet" }, "Ports: loopback muted, LAN amber, all interfaces red. Select a machine or port for details."));
  const connectors = svg("svg", { class: "route-connectors", "aria-hidden": "true" });
  root.append(connectors);
  requestAnimationFrame(() => {
    const bounds = root.getBoundingClientRect();
    connectors.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    connectors.setAttribute("width", String(bounds.width)); connectors.setAttribute("height", String(bounds.height));
    for (const chip of root.querySelectorAll("[data-route-index]")) {
      const row = routes[Number(chip.dataset.routeIndex)]; if (!row) continue;
      const source = chip.getBoundingClientRect();
      const machine = root.querySelector(`.island[aria-label="${CSS.escape(row.machineName || "")}"]`);
      const target = machine?.getBoundingClientRect() || root.querySelector(".unplaced-marker")?.getBoundingClientRect();
      const x1 = source.left + source.width / 2 - bounds.left; const y1 = source.bottom - bounds.top;
      const x2 = target ? target.left + target.width / 2 - bounds.left : bounds.width - 8; const y2 = target ? target.top - bounds.top : y1 + 22;
      connectors.append(svg("path", { d: `M ${x1} ${y1} C ${x1} ${y1 + 22}, ${x2} ${y2 - 22}, ${x2} ${y2}`, fill: "none", stroke: "currentColor", "stroke-width": 1, class: row.machineName ? "route-connector" : "route-connector unplaced" }));
    }
  });
}
