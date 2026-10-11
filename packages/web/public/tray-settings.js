import { h } from "./lib.js";
import { KINDS, CLASSES, VENDORS, emptyRules, normalizeRules, toggleHide, addNameRule, removeNameRule, removePin, parseImport, exportText, sameRules, pinLabel } from "./tray-model.js";
import { TEXT } from "./tray-text.js";

const t = (key) => TEXT[key] ?? key;

/** The Tray panel section of Settings: the hide rules and pins, saved to the hub as one document. */
export function createTraySettings() {
  const section = h("section", { class: "settings-section", "aria-labelledby": "tray-settings-heading" });
  const model = { saved: emptyRules(), draft: emptyRules(), machines: [], fileError: "", status: "", error: "", loaded: false, busy: false };

  async function readJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  async function load() {
    model.error = ""; model.status = t("loading"); render();
    try {
      const [rules, tray] = await Promise.all([fetch("/api/tray/rules").then(readJson), fetch("/api/tray").then(readJson)]);
      model.saved = normalizeRules(rules.rules); model.draft = structuredClone(model.saved);
      model.fileError = rules.fileError || "";
      model.machines = (tray.machines || []).filter((machine) => machine.id !== "stacks").map((machine) => ({ id: machine.id, name: machine.name }));
      model.loaded = true; model.status = "";
    } catch (error) { model.error = `${t("loadFailed")} ${error.message}`; model.status = ""; }
    render();
  }

  async function save() {
    model.busy = true; model.error = ""; model.status = t("saving"); render();
    try {
      const body = await fetch("/api/tray/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: model.draft }) }).then(readJson);
      model.saved = normalizeRules(body.rules); model.draft = structuredClone(model.saved); model.fileError = ""; model.status = t("saved");
    } catch (error) { model.error = `${t("saveFailed")} ${error.message}`; model.status = ""; }
    model.busy = false; render();
  }

  const edit = (next) => { model.draft = next; model.status = ""; render(); };
  const dirty = () => !sameRules(model.draft, model.saved);

  function checks(field, values, labelPrefix) {
    return h("div", { class: "settings-checks" }, values.map((value) => h("label", {}, h("input", { type: "checkbox", checked: model.draft.hide[field].includes(value), onchange: (event) => edit(toggleHide(model.draft, field, value, event.currentTarget.checked)) }), t(`${labelPrefix}_${value}`))));
  }

  function nameRules() {
    const input = h("input", { type: "text", placeholder: t("namePlaceholder"), "aria-label": t("namesHeading"), maxlength: "200" });
    const select = h("select", { "aria-label": t("anyMachine") }, h("option", { value: "" }, t("anyMachine")), model.machines.map((machine) => h("option", { value: machine.id }, machine.name)));
    const add = () => { edit(addNameRule(model.draft, select.value, input.value)); };
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); add(); } });
    const rows = model.draft.hide.names.map((rule, index) => h("li", {}, h("code", {}, rule.match), h("span", { class: "quiet" }, ` ${rule.machine ? model.machines.find((m) => m.id === rule.machine)?.name || rule.machine : t("anyMachine")}`), h("button", { type: "button", "aria-label": `${t("removeRule")} ${rule.match}`, onclick: () => edit(removeNameRule(model.draft, index)) }, t("removeRule"))));
    return [h("div", { class: "settings-add" }, input, select, h("button", { type: "button", onclick: add }, t("addRule"))), rows.length ? h("ul", { class: "settings-list" }, rows) : h("p", { class: "quiet" }, t("namesEmpty"))];
  }

  function pins() {
    if (!model.draft.pins.length) return h("p", { class: "quiet" }, t("pinsEmpty"));
    return h("ul", { class: "settings-list" }, model.draft.pins.map((pin, index) => h("li", {}, h("code", {}, pinLabel(pin, model.machines)), h("button", { type: "button", "aria-label": `${t("removePin")} ${pinLabel(pin, model.machines)}`, onclick: () => edit(removePin(model.draft, index)) }, t("removePin")))));
  }

  function download() {
    const url = URL.createObjectURL(new Blob([exportText(model.draft)], { type: "application/json" }));
    const link = h("a", { href: url, download: "scout-tray-rules.json" });
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  async function pick(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try { model.draft = parseImport(await file.text()); model.error = ""; model.status = t("importLoaded"); }
    catch (error) { model.error = `${t("importInvalid")} ${error.message}`; model.status = ""; }
    render();
  }

  function render() {
    const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: pick });
    section.replaceChildren(
      h("h2", { id: "tray-settings-heading" }, t("trayHeading")),
      h("p", { class: "quiet" }, t("trayIntro")),
      ...(model.fileError ? [h("p", { class: "error", role: "alert" }, `${t("fileDamaged")} ${model.fileError}`)] : []),
      ...(!model.loaded ? [h("p", { class: model.error ? "error" : "quiet", role: "status" }, model.error || model.status)] : [
        h("h3", {}, t("kindsHeading")), h("p", { class: "quiet" }, t("kindsHelp")), checks("kinds", KINDS, "kind"),
        h("h3", {}, t("classesHeading")), checks("classes", CLASSES, "class"),
        h("h3", {}, t("vendorsHeading")), checks("vendors", VENDORS, "vendor"),
        h("h3", {}, t("machinesHeading")), h("p", { class: "quiet" }, t("machinesHelp")),
        h("div", { class: "settings-checks" }, model.machines.map((machine) => h("label", {}, h("input", { type: "checkbox", checked: model.draft.hide.machines.includes(machine.id), onchange: (event) => edit(toggleHide(model.draft, "machines", machine.id, event.currentTarget.checked)) }), machine.name))),
        h("h3", {}, t("namesHeading")), h("p", { class: "quiet" }, t("namesHelp")), ...nameRules(),
        h("h3", {}, t("pinsHeading")), h("p", { class: "quiet" }, t("pinsHelp")), pins(),
        h("div", { class: "settings-actions" },
          h("button", { type: "button", class: "primary", disabled: !dirty() || model.busy, onclick: save }, model.busy ? t("saving") : t("save")),
          h("button", { type: "button", disabled: !dirty() || model.busy, onclick: () => edit(structuredClone(model.saved)) }, t("discard")),
          h("button", { type: "button", onclick: download }, t("exportRules")),
          h("button", { type: "button", onclick: () => fileInput.click() }, t("importRules")), fileInput),
        h("p", { class: "quiet" }, t("importHelp")),
        h("p", { class: model.error ? "error" : "quiet", role: "status", "aria-live": "polite" }, model.error || (dirty() && !model.status ? t("unsaved") : model.status)),
      ]),
    );
  }

  return { section, load };
}
