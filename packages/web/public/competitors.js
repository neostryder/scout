import { h, safeUrl } from "./lib.js";
import { analyzedText, baselineSource, checkedText, commitsText, countLine, defaultNewOnly, filterCompetitors, latestParts, NOT_CONFIGURED, pendingText, runText, sortCompetitors, statusText, syncedText, triggerText, updateAction, UPDATE_CONFIRM } from "./competitors-model.js";

const JSON_POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

function failureText(cause) {
  return cause instanceof Error && cause.message ? cause.message : "The hub could not be reached.";
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function statusClass(row) {
  if (row.status === "new") return "tag warn";
  if (row.status === "current") return "tag ok";
  return "tag";
}

/** The Competitors view. Update and Check now post JSON the same way the other pages do, and the browser sends the origin. */
export function createCompetitorsView(root) {
  let rows = [];
  let checkedAt = null;
  let configured = true;
  let error = "";
  let notice = "";
  let loaded = false;
  let query = "";
  let newOnly = false;
  let chosen = false;
  let announced = null;
  let visible = false;
  let timer = null;
  let controller = null;

  const checked = h("p", { class: "competitors-checked" });
  const check = h("button", { type: "button", class: "primary", onclick: () => checkNow() }, "Check now");
  const status = h("p", { class: "competitors-status", role: "status", "aria-live": "polite" });
  const count = h("p", { class: "count" });
  const search = h("input", { type: "search", placeholder: "Name or organization", "aria-label": "Search competitors", autocomplete: "off", oninput: (event) => { query = event.target.value; paint(); } });
  const newOnlyInput = h("input", { type: "checkbox", onchange: (event) => { chosen = true; newOnly = event.target.checked; paint(); } });
  const toolbar = h("div", { class: "search-bar" }, h("label", { class: "search-label" }, "Search", search), h("label", { class: "competitors-new" }, newOnlyInput, "New only"));
  const tableWrap = h("div", { class: "table-wrap" });
  const dialog = h("dialog", { "aria-labelledby": "competitor-confirm-title" });

  root.classList.add("competitors");
  root.replaceChildren(
    h("header", { class: "competitors-head" }, h("div", {}, h("h1", {}, "Competitors"), checked), check),
    toolbar, status, count, tableWrap, dialog,
  );

  function noteRuns() {
    const next = rows.filter((row) => row.run).map((row) => `${row.name}: ${runText(row.run)}`).join(". ");
    if (announced !== null && next !== announced) notice = next;
    announced = next;
  }

  function links(row) {
    return [["Package", row.packageUrl], ["Repository", row.remoteUrl]].flatMap(([label, href]) => {
      const safe = safeUrl(href);
      return safe ? [h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, label)] : [];
    });
  }

  function updateCell(row) {
    const action = updateAction(row);
    if (action.kind === "hidden") return h("td", { "data-label": "Update" });
    if (action.kind === "disabled") return h("td", { "data-label": "Update" }, h("button", { type: "button", disabled: true, "aria-label": `Update ${row.name}` }, "Update"), h("span", { class: "reason" }, action.reason));
    return h("td", { "data-label": "Update" }, h("button", { type: "button", class: "primary", "data-id": row.id, "aria-label": `Update ${row.name}`, onclick: (event) => askUpdate(row, event.currentTarget) }, "Update"));
  }

  function rowView(row) {
    const latest = latestParts(row.latest);
    const commits = commitsText(row);
    const waiting = pendingText(row.pending);
    const trigger = triggerText(row.run);
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const now = new Date().toISOString();
    return h("tr", {},
      h("td", { class: "name", "data-label": "Competitor" }, h("div", { class: "t" }, row.name), row.org ? h("div", { class: "org" }, row.org) : [], flags.length ? h("div", { class: "flags" }, flags.map((flag) => h("span", { class: "tag" }, flag))) : [], h("div", { class: "commits" }, syncedText(row.sync, now)), h("div", { class: "links" }, links(row))),
      h("td", { "data-label": "Last analyzed", title: baselineSource(row.baseline) }, analyzedText(row.baseline)),
      h("td", { "data-label": "Latest" }, latest.version || (latest.error ? "" : "None"), latest.prerelease ? h("div", { class: "muted" }, latest.prerelease) : [], latest.error ? h("div", { class: "muted" }, latest.error) : []),
      h("td", { "data-label": "Status" }, h("span", { class: statusClass(row) }, statusText(row)), commits ? h("div", { class: "commits" }, commits) : [], waiting ? h("div", { class: "commits" }, waiting) : []),
      h("td", { "data-label": "Research" }, runText(row.run), trigger ? h("div", { class: "commits" }, trigger) : []),
      updateCell(row),
    );
  }

  function table(shown) {
    const heads = ["Competitor", "Last analyzed", "Latest", "Status", "Research", "Update"];
    return h("table", { "aria-label": "Competitors" }, h("thead", {}, h("tr", {}, heads.map((label) => h("th", { scope: "col" }, label)))), h("tbody", {}, shown.map(rowView)));
  }

  function paint() {
    const fresh = rows.filter((row) => row.status === "new").length;
    const badge = document.getElementById("competitors-count");
    if (badge) badge.textContent = loaded && configured && fresh ? String(fresh) : "";
    checked.textContent = loaded && configured ? checkedText(checkedAt) : "";
    check.hidden = !loaded || !configured;
    toolbar.hidden = !loaded || !configured;
    count.hidden = !loaded || !configured;
    count.textContent = loaded && configured ? countLine(rows) : "";
    newOnlyInput.checked = newOnly;
    const live = error || (!loaded ? "Reading competitors." : !configured ? NOT_CONFIGURED : notice);
    status.textContent = live;
    status.hidden = !live;
    if (!loaded || !configured || (error && !rows.length)) { tableWrap.replaceChildren(); return; }
    if (!rows.length) { tableWrap.replaceChildren(h("p", { class: "empty" }, "No competitors are listed.")); return; }
    const shown = filterCompetitors(sortCompetitors(rows), { query, newOnly });
    tableWrap.replaceChildren(shown.length ? table(shown) : h("p", { class: "empty" }, "Nothing matches."));
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      const response = await fetch("/api/competitors", { signal: mine.signal });
      if (mine !== controller) return;
      if (!response.ok) throw new Error(response.status === 404 ? "This hub is too old to report competitors. Update the hub." : `The hub answered ${response.status}.`);
      const body = await readJson(response);
      if (mine !== controller) return;
      configured = body.configured !== false;
      rows = Array.isArray(body.competitors) ? body.competitors : [];
      checkedAt = body.checkedAt || null;
      if (!chosen) newOnly = defaultNewOnly(rows);
      error = "";
      noteRuns();
    } catch (cause) {
      if (cause?.name === "AbortError" || mine !== controller) return;
      error = failureText(cause);
    }
    if (mine !== controller) return;
    loaded = true;
    paint();
  }

  function schedule() {
    clearTimeout(timer);
    if (!visible || document.hidden) return;
    if (!rows.some((row) => row.run?.state === "pulling")) return;
    timer = setTimeout(() => { if (visible && !document.hidden) load().then(schedule); }, 2000);
  }

  async function checkNow() {
    check.disabled = true;
    try {
      const response = await fetch("/api/competitors/check", JSON_POST);
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || body.reason || `The hub answered ${response.status}.`);
      notice = "Check started.";
      error = "";
      if (!visible) return;
      await load();
      schedule();
    } catch (cause) {
      error = failureText(cause);
      paint();
    } finally { check.disabled = false; }
  }

  function askUpdate(row, opener) {
    const problem = h("p", { role: "alert" });
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      try {
        const response = await fetch(`/api/competitors/${encodeURIComponent(row.id)}/update`, JSON_POST);
        const body = await readJson(response);
        if (!response.ok) throw new Error(body.error || body.reason || `The hub answered ${response.status}.`);
        const run = body?.state ? body : body?.run;
        notice = run?.state ? runText(run) : "Update queued.";
        error = "";
        dialog.close();
        if (opener?.isConnected) opener.focus();
        if (!visible) return;
        await load();
        schedule();
      } catch (cause) {
        problem.textContent = failureText(cause);
        submit.disabled = false;
      }
    } }, "Update");
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, "Confirm update"),
      h("p", {}, UPDATE_CONFIRM),
      problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => { dialog.close(); if (opener?.isConnected) opener.focus(); } }, "Cancel"), submit),
    );
    dialog.showModal();
  }

  document.addEventListener("visibilitychange", () => { if (visible && !document.hidden) load().then(schedule); });

  return {
    show() { visible = true; root.hidden = false; paint(); return load().then(schedule); },
    hide() { visible = false; clearTimeout(timer); controller?.abort(); if (dialog.open) dialog.close(); root.hidden = true; },
  };
}
