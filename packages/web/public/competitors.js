import { h, safeUrl } from "./lib.js";
import { addedText, analyzedText, BATCH_ORIGINAL, baselineSource, batchOptions, candidateFacts, candidateSummary, scoreText, trackedText, checkedText, commitsText, countLine, defaultNewOnly, discoveryText, filterRows, flagOptions, GATE_FIELDS, gateChange, isWatched, latestParts, NOT_CONFIGURED, overlapText, pendingText, REMOVE_CONFIRM, repoFromForm, runText, sortBy, sortCandidates, sortCompetitors, statusText, syncedText, TRACK_CONFIRM, triggerText, updateAction, UPDATE_CONFIRM, watchFromForm, WATCH_KINDS, WATCH_UPDATE_CONFIRM, watchText } from "./competitors-model.js";
import { searchCompetitors, searchNote } from "./competitors-search.js";

const JSON_POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const postJson = (value) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

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
  let candidates = [];
  let passedOver = [];
  let discovery = null;
  let discoverConfigured = false;
  let checkedAt = null;
  let configured = true;
  let error = "";
  let notice = "";
  let loaded = false;
  let whyById = new Map();
  let query = new URLSearchParams(location.search).get("q") || "";
  let newOnly = false;
  let statusChoice = "";
  let flag = "";
  let batch = "";
  let research = "";
  let sortColumn = "";
  let sortDirection = "asc";
  let meaning = null;
  let meaningTimer = null;
  let meaningFailed = "";
  let chosen = false;
  let announced = null;
  let visible = false;
  let timer = null;
  let controller = null;

  const checked = h("p", { class: "competitors-checked" });
  const check = h("button", { type: "button", class: "primary", onclick: () => checkNow() }, "Check now");
  const settings = h("button", { type: "button", onclick: (event) => askGate(event.currentTarget) }, "Update rules");
  const status = h("p", { class: "competitors-status", role: "status", "aria-live": "polite" });
  const count = h("p", { class: "count" });
  const search = h("input", { type: "search", placeholder: 'Words, "a phrase", -skip, org:name', "aria-label": "Search competitors", autocomplete: "off", value: query, oninput: (event) => { query = event.target.value; meaning = null; meaningFailed = ""; writeQuery(); paint(); }, onkeydown: (event) => { if (event.key === "Escape" && query) { event.preventDefault(); query = ""; search.value = ""; meaning = null; writeQuery(); paint(); } } });
  const newOnlyInput = h("input", { type: "checkbox", onchange: (event) => { chosen = true; newOnly = event.target.checked; paint(); } });
  const statusFilter = h("select", { "aria-label": "Filter by status", onchange: (event) => { statusChoice = event.target.value; paint(); } }, h("option", { value: "" }, "Any status"), h("option", { value: "new" }, "New version"), h("option", { value: "current" }, "Up to date"), h("option", { value: "unknown" }, "Not checked"));
  const researchFilter = h("select", { "aria-label": "Filter by research", onchange: (event) => { research = event.target.value; paint(); } }, h("option", { value: "" }, "Any research"), h("option", { value: "open" }, "Queued or in progress"), h("option", { value: "failed" }, "Failed"), h("option", { value: "none" }, "None"));
  const flagFilter = h("select", { "aria-label": "Filter by product", onchange: (event) => { flag = event.target.value; paint(); } });
  const batchFilter = h("select", { "aria-label": "Filter by research batch", onchange: (event) => { batch = event.target.value; paint(); } });
  const clearFilters = h("button", { type: "button", onclick: () => { newOnly = false; chosen = true; statusChoice = ""; flag = ""; batch = ""; research = ""; paint(); } }, "Clear filters");
  const toolbar = h("div", { class: "search-bar" }, h("label", { class: "search-label" }, "Search", search), h("label", { class: "competitors-new" }, newOnlyInput, "New only"));
  const filters = h("div", { class: "competitor-filters" }, statusFilter, researchFilter, flagFilter, batchFilter, clearFilters);
  const searchStatus = h("p", { class: "competitors-status", role: "status", "aria-live": "polite" });
  const tableWrap = h("div", { class: "table-wrap" });
  const discover = h("button", { type: "button", "data-discover": "", onclick: () => discoverNow() }, "Look for new ones");
  const candidatesNote = h("p", { class: "competitors-status" });
  const candidatesList = h("div", { class: "candidates" });
  const passedList = h("div", { class: "candidates" });
  const passedTitle = h("summary", {}, "Passed over");
  const passedPanel = h("details", { class: "passed-over" }, passedTitle, h("p", { class: "competitors-status" }, "Projects the last searches read and held back, strongest first. Track anyway adds one to the competitor list."), passedList);
  const candidatesPanel = h("section", { class: "candidates-panel", "aria-labelledby": "candidates-title" }, h("div", { class: "competitors-head" }, h("h2", { id: "candidates-title" }, "Possible competitors"), h("div", { class: "actions" }, discover)), candidatesNote, candidatesList, passedPanel);
  const dialog = h("dialog", { "aria-labelledby": "competitor-confirm-title" });

  root.classList.add("competitors");
  root.replaceChildren(
    h("header", { class: "competitors-head" }, h("div", {}, h("h1", {}, "Competitors"), checked), h("div", { class: "actions" }, settings, check)),
    toolbar, filters, searchStatus, status, count, tableWrap, candidatesPanel, dialog,
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

  function watchButton(row) {
    if (row.remoteUrl) return [];
    const buttons = [h("button", { type: "button", class: "link-button", "data-watch": row.id, "aria-label": `${row.watch ? "Change" : "Set"} watch source for ${row.name}`, onclick: (event) => askWatch(row, event.currentTarget) }, row.watch ? "Change source" : "Watch a page"),
      h("button", { type: "button", class: "link-button", "data-repo": row.id, "aria-label": `Set repository for ${row.name}`, onclick: (event) => askRepo(row, event.currentTarget) }, "Set repository")];
    if (!row.watch) buttons.push(h("button", { type: "button", class: "link-button", "data-remove": row.id, "aria-label": `Remove ${row.name}`, onclick: (event) => askRemove(row, event.currentTarget) }, "Remove"));
    return buttons;
  }

  function updateCell(row) {
    const action = updateAction(row);
    if (action.kind === "hidden") return h("td", { "data-label": "Update" });
    if (action.kind === "disabled") return h("td", { "data-label": "Update" }, h("button", { type: "button", disabled: true, "aria-label": `Update ${row.name}` }, "Update"), h("span", { class: "reason" }, action.reason), watchButton(row));
    return h("td", { "data-label": "Update" }, h("button", { type: "button", class: "primary", "data-id": row.id, "aria-label": `Update ${row.name}`, onclick: (event) => askUpdate(row, event.currentTarget) }, "Update"), watchButton(row));
  }

  function rowView(row) {
    const latest = latestParts(row.latest);
    const commits = commitsText(row);
    const waiting = pendingText(row.pending);
    const reason = whyById.get(row.id);
    const trigger = triggerText(row.run);
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const now = new Date().toISOString();
    return h("tr", {},
      h("td", { class: "name", "data-label": "Competitor" }, h("div", { class: "t" }, row.name), row.org ? h("div", { class: "org" }, row.org) : [], flags.length ? h("div", { class: "flags" }, flags.map((flag) => h("span", { class: "tag" }, flag))) : [], h("div", { class: "commits" }, isWatched(row) ? watchText(row.watch) : syncedText(row.sync, now)), reason ? h("div", { class: "why" }, reason) : [], h("div", { class: "links" }, links(row))),
      h("td", { "data-label": "Added", title: row.batch ? `Found by the search of ${batchLabel(row.batch)}` : "Part of the original list" }, addedText(row)),
      h("td", { "data-label": "Last analyzed", title: baselineSource(row.baseline) }, analyzedText(row.baseline)),
      h("td", { "data-label": "Latest" }, latest.version || (latest.error ? "" : "None"), latest.prerelease ? h("div", { class: "muted" }, latest.prerelease) : [], latest.error ? h("div", { class: "muted" }, latest.error) : []),
      h("td", { "data-label": "Status" }, h("span", { class: statusClass(row) }, statusText(row)), commits ? h("div", { class: "commits" }, commits) : [], waiting ? h("div", { class: "commits" }, waiting) : []),
      h("td", { "data-label": "Research" }, runText(row.run), trigger ? h("div", { class: "commits" }, trigger) : []),
      updateCell(row),
    );
  }

  function sortHead(label, column) {
    const active = sortColumn === column;
    const next = active && sortDirection === "asc" ? "desc" : "asc";
    return h("th", { scope: "col", "aria-sort": active ? (sortDirection === "asc" ? "ascending" : "descending") : "none" },
      h("button", { type: "button", class: "sort-button", "data-sort": column, onclick: () => { sortColumn = column; sortDirection = next; paint(); } }, label, active ? (sortDirection === "asc" ? " \u2191" : " \u2193") : ""));
  }

  function table(shown) {
    return h("table", { "aria-label": "Competitors" }, h("thead", {}, h("tr", {}, sortHead("Competitor", "competitor"), sortHead("Added", "added"), sortHead("Last analyzed", "analyzed"), h("th", { scope: "col" }, "Latest"), sortHead("Status", "status"), h("th", { scope: "col" }, "Research"), h("th", { scope: "col" }, "Update"))), h("tbody", {}, shown.map(rowView)));
  }

  function candidateView(candidate) {
    const safe = safeUrl(candidate.url);
    const facts = candidateFacts(candidate);
    const overlap = overlapText(candidate);
    return h("article", { class: "candidate", "data-candidate": candidate.id },
      h("div", { class: "t" }, safe ? h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, candidate.name) : candidate.name),
      facts ? h("div", { class: "org" }, facts) : [],
      h("p", { class: "summary" }, candidateSummary(candidate)),
      overlap ? h("div", { class: "commits" }, overlap) : [],
      scoreText(candidate) ? h("div", { class: "commits" }, scoreText(candidate)) : [],
      h("div", { class: "actions" },
        candidate.repoUrl ? h("button", { type: "button", class: "primary", "data-track": candidate.id, "aria-label": `Track ${candidate.name}`, onclick: (event) => askTrack(candidate, event.currentTarget) }, candidate.passedOver ? "Track anyway" : "Track") : [],
        candidate.passedOver ? [] : h("button", { type: "button", "data-dismiss": candidate.id, "aria-label": `Dismiss ${candidate.name}`, onclick: () => decide(candidate, "dismiss") }, "Dismiss")),
    );
  }

  function paintCandidates() {
    const show = loaded && configured && discoverConfigured;
    candidatesPanel.hidden = !show;
    if (!show) return;
    discover.disabled = Boolean(discovery?.running);
    candidatesNote.textContent = discoveryText(discovery);
    const waiting = sortCandidates(candidates);
    candidatesList.replaceChildren(...(waiting.length ? waiting.map(candidateView) : [h("p", { class: "empty" }, "Nothing is waiting for a decision.")]));
    passedPanel.hidden = passedOver.length === 0;
    passedTitle.textContent = `Passed over (${passedOver.length})`;
    passedList.replaceChildren(...passedOver.map(candidateView));
  }

  function batchLabel(value) {
    if (value === BATCH_ORIGINAL) return "Original list";
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? String(value) : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  /** The product and batch menus list only what is in the list now, and keep the choice when it is still there. */
  function paintFilterOptions() {
    const flags = flagOptions(rows);
    const batches = batchOptions(rows);
    if (flag && !flags.includes(flag)) flag = "";
    if (batch && !batches.some((item) => item.value === batch)) batch = "";
    flagFilter.replaceChildren(h("option", { value: "" }, "Any product"), ...flags.map((value) => h("option", { value }, value)));
    batchFilter.replaceChildren(h("option", { value: "" }, "Any research batch"), ...batches.map((item) => h("option", { value: item.value }, item.value === BATCH_ORIGINAL ? `Original list (${item.count})` : `Found ${batchLabel(item.value)} (${item.count})`)));
    flagFilter.value = flag;
    batchFilter.value = batch;
    statusFilter.value = statusChoice;
    researchFilter.value = research;
  }

  /** The hub ranks competitors by meaning when spelling found nothing. One request per query, after a short wait so typing finishes first. */
  function askMeaning() {
    const asked = query;
    clearTimeout(meaningTimer);
    meaningTimer = setTimeout(async () => {
      try {
        const response = await fetch("/api/competitors/semantic", postJson({ query: asked }));
        const body = await readJson(response);
        if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
        if (asked !== query) return;
        meaning = { query: asked, ids: Array.isArray(body.ids) ? body.ids : [] };
      } catch (cause) {
        if (asked !== query) return;
        meaningFailed = failureText(cause);
      }
      paint();
    }, 500);
  }

  function writeQuery() {
    try {
      const params = new URLSearchParams(location.search);
      if (query) params.set("q", query); else params.delete("q");
      history.replaceState(history.state, "", params.toString() ? `?${params}` : location.pathname);
    } catch { /* the address bar is a convenience */ }
  }

  function paint() {
    paintCandidates();
    const fresh = rows.filter((row) => row.status === "new").length;
    const badge = document.getElementById("competitors-count");
    if (badge) badge.textContent = loaded && configured && fresh ? String(fresh) : "";
    checked.textContent = loaded && configured ? checkedText(checkedAt) : "";
    check.hidden = !loaded || !configured;
    toolbar.hidden = !loaded || !configured;
    count.hidden = !loaded || !configured;
    count.textContent = loaded && configured ? countLine(rows) : "";
    newOnlyInput.checked = newOnly;
    filters.hidden = !loaded || !configured;
    searchStatus.hidden = true;
    clearFilters.hidden = !(newOnly || statusChoice || flag || batch || research);
    const live = error || (!loaded ? "Reading competitors." : !configured ? NOT_CONFIGURED : notice);
    status.textContent = live;
    status.hidden = !live;
    if (!loaded || !configured || (error && !rows.length)) { tableWrap.replaceChildren(); return; }
    if (!rows.length) { tableWrap.replaceChildren(h("p", { class: "empty" }, "No competitors are listed.")); return; }
    paintFilterOptions();
    const base = filterRows(rows, { newOnly, status: statusChoice, flag, batch, research });
    const found = searchCompetitors(base, query, { meaningIds: meaning && meaning.query === query ? meaning.ids : undefined });
    whyById = found.why;
    const ranked = found.tier === "close" || found.tier === "meaning";
    const shown = ranked ? found.rows : sortColumn ? sortBy(found.rows, sortColumn, sortDirection) : sortCompetitors(found.rows);
    searchStatus.textContent = meaningFailed && found.needsMeaning ? `Nothing matches. Similar-meaning search is not available: ${meaningFailed}` : searchNote(found, shown.length, base.length);
    searchStatus.hidden = !searchStatus.textContent;
    count.textContent = `${shown.length === rows.length ? "" : `Showing ${shown.length} of ${rows.length}. `}${countLine(rows)}`;
    if (found.needsMeaning && !meaning && !meaningFailed) askMeaning();
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
      await loadCandidates(mine);
    } catch (cause) {
      if (cause?.name === "AbortError" || mine !== controller) return;
      error = failureText(cause);
    }
    if (mine !== controller) return;
    loaded = true;
    paint();
  }

  /** The candidate list is a side panel: if the hub cannot give it, the competitor table still works. */
  async function loadCandidates(mine) {
    try {
      const response = await fetch("/api/competitors/candidates", { signal: mine.signal });
      if (!response.ok) throw new Error("no candidates");
      const body = await readJson(response);
      if (mine !== controller) return;
      discoverConfigured = body.configured === true;
      discovery = body.discovery || null;
      candidates = Array.isArray(body.candidates) ? body.candidates : [];
      passedOver = Array.isArray(body.passedOver) ? body.passedOver : [];
    } catch (cause) {
      if (cause?.name === "AbortError") throw cause;
      discoverConfigured = false;
      candidates = [];
      passedOver = [];
    }
  }

  async function discoverNow() {
    discover.disabled = true;
    try {
      const response = await fetch("/api/competitors/discover", JSON_POST);
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || body.reason || `The hub answered ${response.status}.`);
      notice = "Looking for new competitors. What it finds appears here.";
      error = "";
      if (visible) await load();
      scheduleDiscovery();
    } catch (cause) {
      error = failureText(cause);
      paint();
    } finally { paintCandidates(); }
  }

  function scheduleDiscovery() {
    clearTimeout(timer);
    if (!visible || document.hidden || !discovery?.running) return;
    timer = setTimeout(() => { if (visible && !document.hidden) load().then(scheduleDiscovery); }, 3000);
  }

  async function decide(candidate, action) {
    try {
      const response = await fetch(`/api/competitors/candidates/${encodeURIComponent(candidate.id)}/${action}`, JSON_POST);
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
      notice = action === "track" ? trackedText(candidate.name, body) : `${candidate.name} dismissed. It will not be offered again.`;
      error = "";
      if (dialog.open) dialog.close();
      if (visible) await load();
      return true;
    } catch (cause) {
      error = failureText(cause);
      paint();
      return false;
    }
  }

  function askTrack(candidate, opener) {
    const problem = h("p", { role: "alert" });
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      if (!(await decide(candidate, "track"))) { problem.textContent = error; submit.disabled = false; }
    } }, "Track");
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, `Track ${candidate.name}`),
      h("p", {}, TRACK_CONFIRM),
      problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Cancel"), submit),
    );
    dialog.showModal();
  }

  function schedule() {
    clearTimeout(timer);
    if (!visible || document.hidden) return;
    if (!rows.some((row) => row.run?.state === "pulling")) { scheduleDiscovery(); return; }
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
      h("p", {}, isWatched(row) ? WATCH_UPDATE_CONFIRM : UPDATE_CONFIRM),
      problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => { dialog.close(); if (opener?.isConnected) opener.focus(); } }, "Cancel"), submit),
    );
    dialog.showModal();
  }

  function closeDialog(opener) { dialog.close(); if (opener?.isConnected) opener.focus(); }

  function field(label, control, help) {
    return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, help ? h("span", { class: "field-help" }, help) : []);
  }

  /** One dialog edits the file-wide rules or one competitor's own. An emptied field goes back to the default. */
  async function askGate(opener) {
    dialog.replaceChildren(h("h2", { id: "competitor-confirm-title" }, "Research rules"), h("p", {}, "Reading the rules."));
    dialog.showModal();
    let current;
    try {
      const response = await fetch("/api/competitors/gate");
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
      current = body;
    } catch (cause) {
      dialog.replaceChildren(h("h2", { id: "competitor-confirm-title" }, "Research rules"), h("p", { role: "alert" }, failureText(cause)), h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Close")));
      return;
    }
    const problem = h("p", { role: "alert" });
    let scope = "";
    const scopeInput = h("select", { "aria-label": "Rules apply to", onchange: (event) => { scope = event.target.value; render(); } },
      h("option", { value: "" }, "All competitors"), sortCompetitors(rows).map((row) => h("option", { value: row.id }, row.name)));
    const inputs = {};
    const form = h("div", { class: "form" });
    const saved = () => (scope ? current.entries.find((entry) => entry.id === scope)?.gate : current.global) || {};
    function render() {
      problem.textContent = "";
      const own = saved();
      form.replaceChildren(...GATE_FIELDS.map((item) => {
        const fallback = scope && Object.hasOwn(current.global, item.key) ? current.global[item.key] : current.defaults[item.key];
        const shown = item.kind === "flag" ? (fallback ? "yes" : "no") : String(fallback);
        const control = item.kind === "flag"
          ? h("select", {}, h("option", { value: "" }, `Default (${shown})`), h("option", { value: "true" }, "Yes"), h("option", { value: "false" }, "No"))
          : h("input", { type: "number", min: String(item.min), step: "1", placeholder: `Default (${shown})`, inputmode: "numeric" });
        control.value = Object.hasOwn(own, item.key) ? String(own[item.key]) : "";
        inputs[item.key] = control;
        return field(item.label, control, item.help);
      }));
    }
    render();
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      try {
        const entered = Object.fromEntries(GATE_FIELDS.map((item) => [item.key, inputs[item.key].value]));
        const change = gateChange(saved(), entered);
        if (!Object.keys(change.set).length && !change.clear.length) { closeDialog(opener); return; }
        const response = await fetch("/api/competitors/gate", postJson({ ...(scope ? { id: scope } : {}), set: change.set, clear: change.clear }));
        const body = await readJson(response);
        if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
        notice = scope ? "Rules saved for this competitor." : "Rules saved for all competitors.";
        error = "";
        closeDialog(opener);
        paint();
      } catch (cause) {
        problem.textContent = failureText(cause);
        submit.disabled = false;
      }
    } }, "Save rules");
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, "Research rules"),
      h("p", {}, "These rules decide when new work on a competitor queues research on its own. Rules set for one competitor replace the rules for all competitors, field by field."),
      field("Rules apply to", scopeInput),
      form, problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Cancel"), submit),
    );
  }

  /** For a competitor with no repository: where to read its version, checked on the same schedule as the others. */
  function askWatch(row, opener) {
    const problem = h("p", { role: "alert" });
    const kind = h("select", { onchange: () => syncKind() }, WATCH_KINDS.map((item) => h("option", { value: item.value }, item.label)));
    kind.value = row.watch?.kind || "json";
    const url = h("input", { type: "url", placeholder: "https://", autocomplete: "off", inputmode: "url" });
    url.value = row.watch?.url || "";
    const path = h("input", { type: "text", placeholder: "latest.version", autocomplete: "off" });
    path.value = row.watch?.versionPath || "";
    const pattern = h("input", { type: "text", placeholder: "Optional, one capture group", autocomplete: "off" });
    pattern.value = row.watch?.versionPattern || "";
    const help = h("p", { class: "field-help" });
    const pathField = field("Path to the version", path);
    const patternField = field("Version pattern", pattern);
    function syncKind() {
      help.textContent = WATCH_KINDS.find((item) => item.value === kind.value)?.help || "";
      pathField.hidden = kind.value !== "json";
      patternField.hidden = kind.value !== "page";
    }
    syncKind();
    async function send(value, saved) {
      const response = await fetch(`/api/competitors/${encodeURIComponent(row.id)}/watch`, postJson({ watch: value }));
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
      notice = saved;
      error = "";
      closeDialog(opener);
      if (!visible) return;
      await load();
    }
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      try { await send(watchFromForm({ kind: kind.value, url: url.value, versionPath: path.value, versionPattern: pattern.value }), "Watch source saved. It is read on the next check."); }
      catch (cause) { problem.textContent = failureText(cause); submit.disabled = false; }
    } }, "Save source");
    const remove = row.watch ? [h("button", { type: "button", onclick: async () => {
      try { await send(null, "Watch source removed."); } catch (cause) { problem.textContent = failureText(cause); }
    } }, "Remove source")] : [];
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, `Watch ${row.name}`),
      h("p", {}, "This competitor has no public repository. Scout reads this address on every check and marks the competitor New when the version changes."),
      field("What to watch for", kind), field("Address", url, "Only public https addresses can be watched."), pathField, patternField, help, problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Cancel"), remove, submit),
    );
    dialog.showModal();
  }

  /** For a competitor with no repository: the address, and the folder where its clone lives. The clone has to exist before the hub accepts it. */
  function askRepo(row, opener) {
    const problem = h("p", { role: "alert" });
    const remote = h("input", { type: "url", placeholder: "https://github.com/owner/name", autocomplete: "off", inputmode: "url" });
    const folder = h("input", { type: "text", placeholder: row.id, autocomplete: "off" });
    const commit = h("input", { type: "text", placeholder: "Optional, 40 characters", autocomplete: "off" });
    const version = h("input", { type: "text", placeholder: "Optional, such as 1.4.0", autocomplete: "off" });
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      try {
        const repo = repoFromForm({ remoteUrl: remote.value, folder: folder.value, commit: commit.value, version: version.value });
        const response = await fetch(`/api/competitors/${encodeURIComponent(row.id)}/repo`, postJson({ repo }));
        const body = await readJson(response);
        if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
        notice = "Repository saved. The mirror syncs on the next cycle.";
        error = "";
        closeDialog(opener);
        if (!visible) return;
        await load();
      } catch (cause) { problem.textContent = failureText(cause); submit.disabled = false; }
    } }, "Save repository");
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, `Repository for ${row.name}`),
      h("p", {}, "Scout mirrors this repository and counts new commits against the last analysis. The repository must already be cloned into the mirror folder, and a watch source on this competitor is dropped."),
      field("Address", remote, "Only public https addresses work."), field("Mirror folder", folder, "A folder name inside the mirror root. Empty uses the competitor's id."),
      field("Starting commit", commit, "Where counting starts. Empty keeps the current baseline."), field("Starting version", version),
      problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Cancel"), submit),
    );
    dialog.showModal();
  }

  function askRemove(row, opener) {
    const problem = h("p", { role: "alert" });
    const submit = h("button", { type: "button", class: "primary", onclick: async () => {
      submit.disabled = true;
      problem.textContent = "";
      try {
        const response = await fetch(`/api/competitors/${encodeURIComponent(row.id)}/remove`, JSON_POST);
        const body = await readJson(response);
        if (!response.ok) throw new Error(body.error || `The hub answered ${response.status}.`);
        notice = `${row.name} removed.`;
        error = "";
        closeDialog(opener);
        if (!visible) return;
        await load();
      } catch (cause) { problem.textContent = failureText(cause); submit.disabled = false; }
    } }, "Remove");
    dialog.replaceChildren(
      h("h2", { id: "competitor-confirm-title" }, `Remove ${row.name}`),
      h("p", {}, REMOVE_CONFIRM),
      problem,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => closeDialog(opener) }, "Cancel"), submit),
    );
    dialog.showModal();
  }

  document.addEventListener("keydown", (event) => {
    if (!visible || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    event.preventDefault();
    search.focus();
  });

  document.addEventListener("visibilitychange", () => { if (visible && !document.hidden) load().then(schedule); });

  return {
    show() { visible = true; root.hidden = false; paint(); return load().then(schedule); },
    hide() { visible = false; clearTimeout(timer); controller?.abort(); if (dialog.open) dialog.close(); root.hidden = true; },
  };
}
