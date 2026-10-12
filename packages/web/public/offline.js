// The offline strip. When the hub cannot be reached the service worker serves the last copy it saved, and this strip says how old that copy is.
// The page stays readable and every control that changes something is dimmed; when the hub answers again the strip offers a reload.
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function mount() {
  const header = document.querySelector("header.top");
  if (!header || document.querySelector(".offline-strip")) return;
  const strip = document.createElement("div");
  strip.className = "offline-strip";
  strip.setAttribute("role", "status");
  strip.hidden = true;
  const text = document.createElement("span");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.hidden = true;
  reload.addEventListener("click", () => location.reload());
  strip.append(text, reload);
  header.after(strip);
  let oldest = null;
  let offline = false;
  const show = (on) => {
    offline = on;
    if (on) document.documentElement.setAttribute("data-offline", "");
    else document.documentElement.removeAttribute("data-offline");
  };
  const render = () => {
    text.textContent = `Offline, as of ${clock(oldest)}. This is the last copy Scout saved, and controls are off.`;
    reload.hidden = true;
    strip.hidden = false;
  };
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "offline" && typeof message.at === "string") {
      if (!oldest || message.at < oldest) oldest = message.at;
      show(true);
      render();
    } else if (message.type === "online" && offline) {
      show(false);
      oldest = null;
      text.textContent = "Scout is back online. Reload to see current data.";
      reload.hidden = false;
      strip.hidden = false;
    }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
