import { h } from "./lib.js";

let message = "";
let busy = false;

export function dependencyCard(proposal, decide) {
  const subject = proposal.subject;
  const [from, to] = proposal.packages;
  return h("article", { class: "proposal" },
    h("h3", {}, `${from?.name || subject.from.key} needs ${to?.name || subject.to.key}`),
    h("p", {}, `${subject.kind} / ${subject.constraint || (subject.together ? "updates together" : "No version constraint")} / ${subject.confidence} confidence`),
    subject.together && subject.constraint ? h("p", {}, "updates together") : [],
    h("p", {}, subject.evidence),
    h("p", {}, `Machines: ${subject.machines.join(", ")}`),
    h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => decide(proposal.id, true) }, "Confirm"),
      h("button", { type: "button", onclick: () => decide(proposal.id, false) }, "Reject"),
    ),
  );
}

export function discoveryControls(reload, fetcher = fetch) {
  const status = h("p", { role: "status", "aria-live": "polite" }, message);
  const button = h("button", { type: "button", disabled: busy, onclick: async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = "Scout is checking dependencies...";
    try {
      const response = await fetcher("/api/dependencies/discover", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Scout could not check dependencies.");
      message = result.status === "no_model" ? "No model is configured." : result.status === "unusable" ? "The response could not be read. The queue has not changed." : `Found ${result.proposed} possible dependencies.${result.omitted ? ` ${result.omitted} were left out for size.` : ""}`;
      busy = false;
      status.textContent = message;
      await reload();
    } catch (error) {
      message = error.message || "Scout could not check dependencies.";
      status.textContent = message;
    } finally {
      busy = false;
      button.disabled = false;
    }
  } }, "Look for hidden dependencies");
  return h("div", {}, button, status);
}
