import { DAILY, isResult, parseJson, type Researcher } from "./types.ts";

// PyPI's JSON API reports the newest non-pre-release version in info.version. A yanked release is not offered.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const pypi: Researcher = {
  source: "pypi",
  ecosystems: ["pipx", "uv-tool"],
  ttlMs: DAILY,
  url(t) {
    return NAME.test(t.key) ? `https://pypi.org/pypi/${encodeURIComponent(t.key)}/json` : null;
  },
  parse(status, body) {
    const r = parseJson(status, body);
    if (isResult(r)) return r;
    const info = r.doc["info"];
    const version = info && typeof info === "object" ? (info as Record<string, unknown>)["version"] : null;
    if (typeof version !== "string" || version === "") return { status: "failed", answers: [], message: "no info.version" };
    if ((info as Record<string, unknown>)["yanked"] === true) return { status: "ok", answers: [], message: "the newest release is yanked" };
    return { status: "ok", answers: [{ channel: "stable", version, installable: true }] };
  },
};
