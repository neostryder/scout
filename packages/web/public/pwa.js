// Registers the service worker that lets a browser offer to install Scout as an app.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
