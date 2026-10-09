import { badgeModel } from "./services-model.js";

const EVERY_MS = 60_000;

function mount() {
  const badge = document.querySelector("#alerts-badge");
  if (!badge) return;
  let timer = null;
  async function refresh() {
    if (document.hidden) return;
    try {
      const response = await fetch("/api/services/alerts/summary", { headers: { accept: "application/json" } });
      if (!response.ok) { badge.hidden = true; return; }
      const model = badgeModel(await response.json());
      badge.textContent = model.text;
      badge.dataset.tone = model.tone;
      badge.hidden = model.hidden;
    } catch { badge.hidden = true; }
  }
  refresh();
  timer = setInterval(refresh, EVERY_MS);
  window.addEventListener("scout-alert", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(timer); timer = null; }
    else if (!timer) { refresh(); timer = setInterval(refresh, EVERY_MS); }
  });
  window.addEventListener("pagehide", () => { clearInterval(timer); timer = null; });
  window.addEventListener("pageshow", () => { if (!document.hidden && !timer) { refresh(); timer = setInterval(refresh, EVERY_MS); } });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
