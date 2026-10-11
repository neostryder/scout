// A stand-in for the Tauri side so the panel can be developed and checked in a plain browser. It is never bundled into the app.
const params = new URLSearchParams(location.search);

export async function createMock() {
  const [text, fixture] = await Promise.all([fetch("../ui/text.json").then((r) => r.json()), fetch("../dev/fixture.json").then((r) => r.json())]);
  const data = structuredClone(fixture);
  const link = params.get("link") ?? "ok";
  let config = { hubUrl: link === "unconfigured" ? "" : "https://scout.example.com", clientId: link === "unconfigured" ? "" : "tray-eru.access", hasSecret: link !== "unconfigured", theme: params.get("theme") ?? "system" };
  let rules = { hide: { kinds: [], classes: [], machines: [], vendors: [], names: [] }, pins: [] };
  const listeners = new Map();
  const actions = [];
  let nextId = 1;

  // Give the first few running rows on each machine a pulse of response times, and make one row down so the red state shows.
  for (const machine of data.machines) {
    machine.rows.filter((r) => r.state === "up" && r.port).slice(0, 4).forEach((row, i) => {
      row.spark = Array.from({ length: 24 }, (_, n) => (i === 1 && n === 11 ? null : 20 + Math.round(15 * Math.sin(n / 3 + i) + (n % 5) * 3)));
    });
  }
  const eru = data.machines.find((m) => m.id === "eru");
  const victim = eru?.rows.find((r) => r.state === "up" && !r.protected && r.port);
  if (params.get("down") && victim) { victim.state = "down"; victim.actions = victim.actions.map((a) => ({ ...a, available: a.action === "start", reason: null })); eru.counts.up--; eru.counts.down++; eru.worst = "down"; data.state = "down"; }

  const snapshot = () => ({ link, body: link === "ok" ? JSON.stringify(data) : null, detail: link === "unreachable" ? "connection refused" : null });
  const emit = (name, payload) => (listeners.get(name) ?? []).forEach((fn) => fn({ payload }));
  const reply = (status, body) => ({ status, body: JSON.stringify(body), etag: null });
  const rowOf = (id) => data.machines.flatMap((m) => m.rows).find((r) => r.id === id);
  const move = (row, to) => {
    const machine = data.machines.find((m) => m.id === row.machineId);
    machine.counts[row.state]--;
    machine.counts[to]++;
    row.state = to;
    row.actions = row.actions.map((a) => ({ ...a, available: to === "up" ? a.action !== "start" && !row.protected : a.action === "start" }));
  };

  const commands = {
    get_text: () => text,
    get_config: () => config,
    get_snapshot: () => snapshot(),
    set_theme: ({ theme }) => { config = { ...config, theme }; },
    close_panel: () => {},
    open_portal: () => { console.info("open portal"); },
    quit_app: () => { console.info("quit"); },
    refresh_now: () => emit("snapshot", snapshot()),
    save_config: async ({ hubUrl, clientId, secret }) => {
      if (!hubUrl.startsWith("https://")) throw new Error("the hub address must start with https://");
      config = { ...config, hubUrl, clientId, hasSecret: config.hasSecret || Boolean(secret) };
      emit("snapshot", { link: "ok", body: JSON.stringify(data), detail: null });
    },
    hub_request: async ({ method, path, body }) => {
      await new Promise((r) => setTimeout(r, 120));
      const payload = body ? JSON.parse(body) : null;
      if (path === "/api/tray/rules" && method === "GET") return reply(200, { rules, fileError: null });
      if (path === "/api/tray/rules" && method === "PUT") { rules = payload.rules; return reply(200, { rules, fileError: null }); }
      if (path === "/api/services/actions/plan") {
        const row = payload.target === "stack" ? data.machines.find((m) => m.id === "stacks").rows.find((r) => r.name === payload.name) : rowOf(payload.id);
        if (row?.protected && payload.action !== "start") return reply(200, { plan: { allowed: false, refusal: row.protectedReason, refusalKind: "protected" } });
        const admin = row?.needsAdmin ? (row.machineId === "eru" ? "uac" : "sudo") : "none";
        return reply(200, { plan: { allowed: true, id: `p${nextId}`, token: "t", admin, sudoCommand: admin === "sudo" ? `sudo launchctl kickstart -k system/${row.name}` : null, rowKey: row?.key, action: payload.action } });
      }
      if (path === "/api/services/actions/run") {
        const id = nextId++;
        const planned = JSON.parse(JSON.stringify(payload));
        const record = { id, state: "running", message: null, planId: planned.planId, key: null };
        actions.push(record);
        const row = data.machines.flatMap((m) => m.rows).find((r) => r.key === lastRowKey);
        setTimeout(() => {
          if (params.get("fail")) { record.state = "failed"; record.message = "The service refused to stop within 10 s."; return; }
          record.state = "done";
          if (row) move(row, lastAction === "stop" ? "stopped" : "up");
        }, 1600);
        return reply(202, { actionId: id, state: "running" });
      }
      if (path.startsWith("/api/services/actions")) return reply(200, { items: actions });
      return reply(404, { error: "no such route" });
    },
  };
  let lastRowKey = null;
  let lastAction = null;
  const original = commands.hub_request;
  commands.hub_request = async (args) => {
    if (args.path === "/api/services/actions/plan") {
      const payload = JSON.parse(args.body);
      const row = payload.target === "stack" ? data.machines.find((m) => m.id === "stacks").rows.find((r) => r.name === payload.name) : rowOf(payload.id);
      lastRowKey = row?.key ?? null;
      lastAction = payload.action;
    }
    return original(args);
  };

  return {
    invoke: async (name, args = {}) => {
      const fn = commands[name];
      if (!fn) throw new Error(`unknown command ${name}`);
      return fn(args);
    },
    listen: async (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; },
    /** Lets a person or a test fire a shell event, such as confirm-quit, from the browser console. */
    emit,
  };
}
