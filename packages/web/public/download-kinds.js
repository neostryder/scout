// Colors the Download buttons by what Scout found for each row: an exact file (green, "Download"), only a page
// (violet, "Download page", which also covers the product's home page or repo as a last resort), or nothing yet. The hub works this out in the background, so the page asks again
// until the pass is done.
const RETRY_MS = 3000;
const MAX_TRIES = 20;
let timer = null;
let tries = 0;

function buttons() { return [...document.querySelectorAll("button.download[data-install-id]")]; }

function paint(kinds) {
  for (const button of buttons()) {
    const kind = kinds[button.dataset.installId];
    if (!kind) continue;
    const label = kind === "page" ? "Download page" : "Download";
    const title = kind === "file" ? "Download the exact file to this machine's Downloads folder" : kind === "page" ? "Open the page where a newer version can be downloaded" : "No exact file or page was found for this version";
    button.classList.toggle("direct", kind === "file");
    button.classList.toggle("page", kind === "page");
    button.classList.toggle("none", kind === "none");
    // Writing the same text again would still wake the observer below, so only change what differs.
    if (button.textContent !== label) button.textContent = label;
    if (button.title !== title) button.title = title;
  }
}

async function refresh() {
  if (buttons().length === 0) return;
  try {
    const response = await fetch("/api/downloads/kinds", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    paint(data.kinds || {});
    if (data.pending && tries++ < MAX_TRIES) timer = setTimeout(refresh, RETRY_MS);
  } catch {
    // The buttons keep their neutral look when the hub does not answer.
  }
}

function schedule() {
  clearTimeout(timer);
  tries = 0;
  timer = setTimeout(refresh, 200);
}

function mount() {
  new MutationObserver(() => {
    if (buttons().some((button) => !["direct", "page", "none"].some((name) => button.classList.contains(name)))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  schedule();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
