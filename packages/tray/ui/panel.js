import { actionOutcome, ago, applyRule, contextEntries, fill, hiddenTotal, needsConfirm, pickTab, planBody, rowActions, sparkRuns, tabs, totals, visibleRows } from "./model.js";

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  gear: "M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm8 3.5l-1.9-.7a6.7 6.7 0 00-.6-1.4l.9-1.8-1.6-1.6-1.8.9a6.7 6.7 0 00-1.4-.6L12.9 4h-2.3l-.7 1.9a6.7 6.7 0 00-1.4.6l-1.8-.9-1.6 1.6.9 1.8c-.3.4-.5.9-.6 1.4L4 11.1v2.3l1.9.7c.1.5.3 1 .6 1.4l-.9 1.8 1.6 1.6 1.8-.9c.4.3.9.5 1.4.6l.7 1.9h2.3l.7-1.9c.5-.1 1-.3 1.4-.6l1.8.9 1.6-1.6-.9-1.8c.3-.4.5-.9.6-1.4l1.9-.7z",
  shield: "M12 3l7 3v5c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z",
  theme: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 2a7 7 0 010 14z",
  close: "M6 6l12 12M18 6L6 18",
};

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};
const svg = (name, extra = {}) => {
  const root = document.createElementNS(SVG, "svg");
  root.setAttribute("viewBox", "0 0 24 24");
  root.setAttribute("fill", name === "close" ? "none" : "currentColor");
  if (name === "close") { root.setAttribute("stroke", "currentColor"); root.setAttribute("stroke-width", "2"); root.setAttribute("stroke-linecap", "round"); }
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  root.append(path);
  for (const [k, v] of Object.entries(extra)) root.setAttribute(k, v);
  return root;
};

const KIND_KEYS = { "windows-service": "kindWindowsService", launchd: "kindLaunchd", "scheduled-task": "kindScheduledTask", listener: "kindListener", container: "kindContainer", recipe: "kindRecipe" };
const VENDOR_KEYS = { apple: "vendorApple", microsoft: "vendorMicrosoft" };
const THEMES = ["system", "dark", "light"];

const bridge = await (async () => {
  if (window.__TAURI__) return { invoke: window.__TAURI__.core.invoke, listen: window.__TAURI__.event.listen };
  return (await import("../dev/mock.js")).createMock();
})();

const ui = {
  text: await bridge.invoke("get_text"),
  config: await bridge.invoke("get_config"),
  link: "unconfigured",
  detail: null,
  data: null,
  fetchedAt: null,
  tab: null,
  query: "",
  chip: "all",
  ops: new Map(),
  menu: null,
  toast: null,
  connect: false,
};
const t = (key, vars) => fill(ui.text[key] ?? key, vars);

const root = document.getElementById("app");
let searchInput = null;

function applyTheme() {
  const wanted = ui.config.theme;
  const dark = wanted === "dark" || (wanted !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

async function api(method, path, body) {
  const reply = await bridge.invoke("hub_request", { method, path, body: body === undefined ? null : JSON.stringify(body) });
  let json = null;
  try { json = JSON.parse(reply.body); } catch { /* not JSON */ }
  return { status: reply.status, json, text: reply.body };
}

function setSnapshot(snapshot) {
  ui.link = snapshot.link;
  ui.detail = snapshot.detail ?? null;
  if (snapshot.link === "ok" && snapshot.body) {
    try {
      ui.data = JSON.parse(snapshot.body);
      ui.fetchedAt = Date.now();
    } catch { /* keep the last good data */ }
  }
  if (snapshot.link === "unconfigured") ui.connect = true;
  ui.tab = pickTab(ui.data, ui.tab);
  render();
}

function sortedTabs() { return tabs(ui.data); }
const currentMachine = () => sortedTabs().find((m) => m.id === ui.tab) ?? null;
const findRow = (key) => sortedTabs().flatMap((m) => m.rows).find((r) => r.key === key) ?? null;

function dot(state) { return h("span", { class: `dot ${state}`, "aria-hidden": "true" }); }

function header() {
  const sum = totals(ui.data);
  return h("div", { class: "head" },
    h("div", { class: "brand" }, "Scout"),
    sum.down ? h("span", { class: "pill down" }, t("pillDown", { n: sum.down })) : null,
    sum.changed ? h("span", { class: "pill changed" }, t("pillChanged", { n: sum.changed })) : null,
    h("button", { class: "icon-btn", title: t("settingsLabel"), "aria-label": t("settingsLabel"), onclick: () => { ui.connect = true; render(); } }, svg("gear")),
    h("button", { class: "icon-btn", title: t("ariaClose"), "aria-label": t("ariaClose"), onclick: () => bridge.invoke("close_panel") }, svg("close")),
  );
}

function tools() {
  if (!searchInput) {
    searchInput = h("input", { class: "search", type: "search", "aria-label": t("ariaSearch"), placeholder: t("searchPlaceholder"), oninput: (e) => { ui.query = e.target.value; renderList(); } });
  }
  const chip = (id, label) => h("button", { class: "chip", "aria-pressed": String(ui.chip === id), onclick: () => { ui.chip = id; render(); } }, label);
  return h("div", { class: "tools" }, searchInput, h("div", { class: "chips" }, chip("all", t("chipAll")), chip("down", t("chipDown")), chip("mine", t("chipMine"))));
}

function tabBar() {
  const list = sortedTabs();
  return h("div", { class: "tabs", role: "tablist", "aria-label": t("ariaTabs") }, list.map((m) => {
    const problems = (m.counts?.down ?? 0) + (m.counts?.changed ?? 0);
    const badge = problems ? h("span", { class: `badge ${m.counts.down ? "down" : "changed"}` }, String(problems)) : h("span", { class: "badge" }, String(m.counts?.up ?? 0));
    return h("button", { class: "tab", role: "tab", "aria-selected": String(m.id === ui.tab), onclick: () => { ui.tab = m.id; render(); } }, dot(m.reachable ? m.worst : "unknown"), m.name, badge);
  }));
}

function notices() {
  const out = [];
  if (ui.link === "refused") out.push(h("div", { class: "notice warn" }, t("bannerRefused")));
  else if (ui.link === "unreachable") out.push(h("div", { class: "notice warn" }, t("bannerUnreachable"), ui.fetchedAt ? ` ${t("staleNote", { time: ago(new Date(ui.fetchedAt).toISOString()) })}` : ""));
  else if (ui.link === "unconfigured") out.push(h("div", { class: "notice" }, t("bannerUnconfigured")));
  if (ui.data?.fileError) out.push(h("div", { class: "notice warn" }, t("bannerFileDamaged", { detail: ui.data.fileError })));
  const m = currentMachine();
  if (m && !m.reachable && m.id !== "stacks") out.push(h("div", { class: "notice warn" }, m.lastSeen ? t("machineUnreachable", { time: ago(m.lastSeen) }) : t("machineNeverSeen")));
  return out;
}

function sparkline(row) {
  const runs = sparkRuns(row.spark);
  if (!runs.length) return h("span", { class: "spark" });
  const el = document.createElementNS(SVG, "svg");
  el.setAttribute("class", "spark");
  el.setAttribute("viewBox", "0 0 46 14");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", t("sparkLabel", { n: row.spark.length }));
  for (const points of runs) {
    const line = document.createElementNS(SVG, "polyline");
    line.setAttribute("points", points);
    el.append(line);
  }
  return el;
}

function rowView(row) {
  const op = ui.ops.get(row.key);
  const el = h("div", { class: `row${row.pinned ? " pinned" : ""}${ui.menu?.key === row.key ? " menu-open" : ""}`, "data-key": row.key, oncontextmenu: (e) => { e.preventDefault(); openMenu(row, e.clientX, e.clientY); } });
  const tipState = { up: "stateUp", down: "stateDown", changed: "stateChanged", stopped: "stateStopped", unknown: "stateUnknown" }[row.state];
  const d = dot(row.state);
  d.setAttribute("title", t(tipState));
  el.append(d);
  el.append(h("span", { class: "name", title: row.label }, row.label, row.detail && (row.kind === "recipe" || row.kind === "stack") ? h("span", { class: "sub" }, row.detail) : null));
  el.append(h("span", { class: "meta" }, row.port ? h("span", { class: "port" }, `:${row.port}`) : null, sparkline(row), row.protected ? h("span", { class: "shield-wrap", title: row.protectedReason ?? t("protectedLabel") }, svg("shield", { class: "shield" })) : null));
  const showActions = !op || op.phase === "result";
  const buttons = h("span", { class: "hover-actions" }, rowActions(row).map(({ action, available, reason }) => {
    const label = t(action === "start" ? "actionStart" : action === "stop" ? "actionStop" : "actionRestart");
    return h("button", { class: `act ${action}`, disabled: !available, title: !available && reason ? reason : null, onclick: () => (needsConfirm(action) ? beginConfirm(row, action) : runAction(row, action)) }, label);
  }));
  el.append(showActions ? buttons : h("span"));
  if (row.protected && !op) el.append(h("div", { class: "line note" }, t("protectedNote", { reason: row.protectedReason ?? t("protectedLabel") })));
  if (op) el.append(opLine(row, op));
  return el;
}

function opLine(row, op) {
  const name = row.label;
  if (op.phase === "confirm") {
    const yes = t(op.action === "stop" ? "confirmYesStop" : op.action === "disable" ? "confirmYesDisable" : "confirmYesRestart");
    return h("div", { class: "line confirm" }, h("span", { class: "q" }, t(op.action === "stop" ? "confirmStop" : op.action === "disable" ? "confirmDisable" : "confirmRestart", { name })),
      h("button", { class: "act danger", onclick: () => runAction(row, op.action) }, yes), h("button", { class: "act", onclick: () => clearOp(row.key) }, t("cancel")));
  }
  if (op.phase === "working") {
    return h("div", { class: "line" }, t({ start: "workingStart", stop: "workingStop", restart: "workingRestart", disable: "workingDisable", enable: "workingEnable" }[op.action], { name }), op.admin ?? null);
  }
  if (op.phase === "result") return h("div", { class: "line ok" }, t({ start: "resultStarted", stop: "resultStopped", restart: "resultRestarted", disable: "resultDisabled", enable: "resultEnabled" }[op.action], { name }));
  return h("div", { class: "line bad" }, op.text, h("button", { class: "link", onclick: () => clearOp(row.key) }, "OK"));
}

function renderList() {
  const holder = root.querySelector(".list");
  if (!holder) return;
  const keep = holder.scrollTop;
  const machine = currentMachine();
  const rows = visibleRows(machine, { query: ui.query, chip: ui.chip });
  holder.replaceChildren(...(rows.length ? rows.map(rowView) : [h("div", { class: "empty" }, !machine ? "" : machine.id === "stacks" && !machine.rows.length ? t("noStacks") : machine.rows.length ? t("emptyFilter") : t("emptyMachine", { name: machine.name }))]));
  holder.scrollTop = keep;
}

function footer() {
  const hidden = hiddenTotal(ui.data);
  const label = { system: "themeSystem", dark: "themeDark", light: "themeLight" }[ui.config.theme] ?? "themeSystem";
  return h("div", { class: "foot" },
    h("button", { onclick: () => bridge.invoke("open_portal").catch(showError) }, t("footerOpen")),
    hidden ? h("span", { class: "hidden-count" }, t("footerHidden", { n: hidden })) : null,
    h("span", { class: "grow" }),
    h("button", { class: "icon-btn", title: t(label), "aria-label": t("ariaThemeToggle"), onclick: cycleTheme }, svg("theme")),
  );
}

async function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(ui.config.theme) + 1) % THEMES.length];
  ui.config.theme = next;
  applyTheme();
  await bridge.invoke("set_theme", { theme: next }).catch(() => {});
  render();
}

function showError(err) {
  ui.toast = String(err?.message ?? err);
  render();
  setTimeout(() => { ui.toast = null; render(); }, 6000);
}

function render() {
  if (ui.connect) { renderConnect(); return; }
  const list = h("div", { class: "list" });
  root.replaceChildren(...[header(), tools(), tabBar(), ...notices(), list, footer(), ui.menu ? menuView() : null, ui.toast ? h("div", { class: "toast", role: "status" }, ui.toast) : null].filter(Boolean));
  renderList();
}

// ---- row actions -----------------------------------------------------------------

function clearOp(key) { ui.ops.delete(key); renderList(); }
function beginConfirm(row, action) { ui.ops.set(row.key, { phase: "confirm", action }); renderList(); }

async function runAction(row, action) {
  const op = { phase: "working", action, admin: null };
  ui.ops.set(row.key, op);
  renderList();
  const fail = (text) => { ui.ops.set(row.key, { phase: "error", action, text }); renderList(); };
  try {
    const planned = await api("POST", "/api/services/actions/plan", planBody(row, action));
    const plan = planned.json?.plan;
    if (!plan || plan.allowed === false) return fail(t("planRefused", { name: row.label, reason: plan?.refusal ?? planned.json?.error ?? `${planned.status}` }));
    const ran = await api("POST", "/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true });
    if (!ran.json?.actionId) return fail(t(`failed${action[0].toUpperCase()}${action.slice(1)}`, { name: row.label, reason: ran.json?.error ?? `${ran.status}` }));
    const sudo = ran.json.sudoCommand ?? plan.sudoCommand ?? null;
    if (plan.admin === "uac") op.admin = h("span", { class: "line" }, t("adminUac", { machine: machineName(row.machineId) }));
    else if (sudo) op.admin = h("span", { class: "cmd-box" }, h("span", { class: "line" }, t("adminSudo", { machine: machineName(row.machineId) })), h("span", { class: "line cmd" }, sudo));
    renderList();
    await waitForAction(row, action, ran.json.actionId);
  } catch (err) {
    fail(t(`failed${action[0].toUpperCase()}${action.slice(1)}`, { name: row.label, reason: String(err?.message ?? err) }));
  }
}

const machineName = (id) => sortedTabs().find((m) => m.id === id)?.name ?? id;

async function waitForAction(row, action, actionId) {
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 700 : 2000));
    const got = await api("GET", `/api/services/actions?limit=20&machine=${encodeURIComponent(row.machineId)}`);
    const record = (got.json?.items ?? []).find((a) => a.id === actionId);
    const out = actionOutcome(record);
    if (!out.done) continue;
    if (out.ok) {
      ui.ops.set(row.key, { phase: "result", action });
      renderList();
      await bridge.invoke("refresh_now");
      setTimeout(() => { if (ui.ops.get(row.key)?.phase === "result") clearOp(row.key); }, 6000);
    } else {
      ui.ops.set(row.key, { phase: "error", action, text: t(`failed${action[0].toUpperCase()}${action.slice(1)}`, { name: row.label, reason: out.reason }) });
      renderList();
    }
    return;
  }
  ui.ops.set(row.key, { phase: "error", action, text: t(`failed${action[0].toUpperCase()}${action.slice(1)}`, { name: row.label, reason: "timed out" }) });
  renderList();
}

// ---- right-click menu ------------------------------------------------------------

function menuLabel(entry, row) {
  switch (entry.id) {
    case "disable": return t("menuDisable");
    case "enable": return t("menuEnable");
    case "hide": return t("menuHide");
    case "hide-kind": return t("menuHideKind", { kind: t(KIND_KEYS[entry.value] ?? "kindListener") });
    case "hide-vendor": return t("menuHideVendor", { vendor: t(VENDOR_KEYS[entry.value] ?? "vendorApple") });
    case "pin": return t("menuPin");
    case "unpin": return t("menuUnpin");
    default: return t("menuOpen");
  }
}

function openMenu(row, x, y) {
  ui.menu = { key: row.key, x, y, entries: contextEntries(row).filter((e) => !(e.id === "hide-kind" && !KIND_KEYS[e.value]) && !(e.id === "hide-vendor" && !VENDOR_KEYS[e.value])) };
  render();
}

function menuView() {
  const row = findRow(ui.menu.key);
  const left = Math.min(ui.menu.x, window.innerWidth - 216);
  const top = Math.min(ui.menu.y, window.innerHeight - 8 - ui.menu.entries.length * 30);
  return h("div", { class: "menu", role: "menu", style: `left:${Math.max(4, left)}px;top:${Math.max(4, top)}px` },
    ui.menu.entries.map((entry) => h("button", { role: "menuitem", onclick: () => chooseEntry(entry, row) }, menuLabel(entry, row))));
}

async function chooseEntry(entry, row) {
  ui.menu = null;
  render();
  if (!row) return;
  if (entry.scope === "portal") { bridge.invoke("open_portal").catch(showError); return; }
  if (entry.scope === "startup") { if (needsConfirm(entry.action)) beginConfirm(row, entry.action); else runAction(row, entry.action); return; }
  try {
    const got = await api("GET", "/api/tray/rules");
    if (!got.json?.rules) throw new Error(got.json?.error ?? `${got.status}`);
    const put = await api("PUT", "/api/tray/rules", { rules: applyRule(got.json.rules, entry, row) });
    if (put.status !== 200) throw new Error(put.json?.error ?? `${put.status}`);
    if (entry.scope !== "pin") { ui.toast = t("rowHiddenToast", { name: row.label }); setTimeout(() => { ui.toast = null; render(); }, 6000); }
    await bridge.invoke("refresh_now");
  } catch (err) {
    showError(t("ruleFailed", { reason: String(err?.message ?? err) }));
  }
}

document.addEventListener("click", (e) => { if (ui.menu && !e.target.closest(".menu")) { ui.menu = null; render(); } });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (ui.menu) { ui.menu = null; render(); } else if (ui.connect && ui.link !== "unconfigured") { ui.connect = false; render(); } else bridge.invoke("close_panel");
});

// ---- connection screen -----------------------------------------------------------

function renderConnect() {
  let status = null;
  const hub = h("input", { type: "url", value: ui.config.hubUrl ?? "", placeholder: t("fieldHubPlaceholder"), spellcheck: "false", autocomplete: "off" });
  const client = h("input", { type: "text", value: ui.config.clientId ?? "", spellcheck: "false", autocomplete: "off" });
  const secret = h("input", { type: "password", placeholder: ui.config.hasSecret ? t("secretKept") : "", autocomplete: "off" });
  const result = h("div", { class: "result" });
  const save = h("button", { class: "primary", onclick: async () => {
    save.disabled = true;
    result.className = "result";
    result.textContent = "";
    try {
      await bridge.invoke("save_config", { hubUrl: hub.value, clientId: client.value, secret: secret.value || null });
      ui.config = await bridge.invoke("get_config");
      result.className = "result ok";
      result.textContent = t("connectOk");
      setTimeout(() => { ui.connect = false; render(); }, 700);
    } catch (err) {
      ui.config = await bridge.invoke("get_config").catch(() => ui.config);
      result.className = "result bad";
      result.textContent = t("connectFailed", { reason: String(err?.message ?? err) });
    } finally { save.disabled = false; }
  } }, t("connectSave"));
  const back = ui.link === "unconfigured" ? null : h("button", { class: "plain", onclick: () => { ui.connect = false; render(); } }, t("connectBack"));
  void status;
  root.replaceChildren(h("div", { class: "connect" },
    h("h1", {}, t("connectTitle")), h("p", {}, t("connectHelp")),
    h("label", {}, h("span", {}, t("fieldHub")), hub), h("label", {}, h("span", {}, t("fieldClient")), client), h("label", {}, h("span", {}, t("fieldSecret")), secret),
    h("div", { class: "buttons" }, save, back), result));
  hub.focus();
}

// ---- start -----------------------------------------------------------------------

applyTheme();
await bridge.listen("snapshot", (event) => setSnapshot(event.payload));
await bridge.listen("show-connect", () => { ui.connect = true; render(); });
await bridge.listen("panel-open", () => { ui.menu = null; if (!ui.connect) { render(); searchInput?.focus(); } });
setSnapshot(await bridge.invoke("get_snapshot"));
if (ui.link === "unconfigured") { ui.connect = true; render(); }
