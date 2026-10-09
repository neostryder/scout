// A standing reminder while proposals wait for a decision. It stays until the queue is empty and hides itself
// on the review page, where the cards are.
const EVERY_MS = 60_000;

function isReview() { return new URLSearchParams(location.search).get("view") === "review"; }

async function openProposals() {
  try {
    const response = await fetch("/api/summary", { headers: { accept: "application/json" } });
    if (!response.ok) return 0;
    const data = await response.json();
    return Number.isFinite(data.openProposals) ? data.openProposals : 0;
  } catch {
    return 0;
  }
}

function mount() {
  const header = document.querySelector("header.top");
  if (!header) return;
  const bar = document.createElement("div");
  bar.className = "review-reminder";
  bar.setAttribute("role", "status");
  bar.hidden = true;
  const text = document.createElement("span");
  const link = document.createElement("a");
  link.href = "/?view=review";
  link.textContent = "Review them";
  bar.append(text, " ", link);
  header.after(bar);
  let count = 0;
  const paint = () => {
    text.textContent = count === 1 ? "1 proposal is waiting for your decision." : `${count} proposals are waiting for your decision.`;
    bar.hidden = count === 0 || isReview();
  };
  const refresh = async () => { count = await openProposals(); paint(); };
  void refresh();
  setInterval(refresh, EVERY_MS);
  // The page switches views without a reload, so the review check runs on a short timer as well.
  setInterval(paint, 500);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
