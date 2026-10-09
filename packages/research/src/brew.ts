import { DAILY, isResult, parseJson, type Researcher } from "./types.ts";

// formulae.brew.sh publishes one small JSON file per formula and per cask. Only the official taps are listed there, so a
// package from a third-party tap is not asked about. Homebrew's own version is what `brew upgrade` installs, which is
// why these answers are installable. A formula revision shows in the installed version as a "_N" suffix, so it is added
// here to keep an unchanged install from looking out of date.

export const brewApi: Researcher = {
  source: "brew-api",
  ecosystems: ["brew", "cask"],
  ttlMs: DAILY,
  url(t) {
    if (!/^[a-z0-9][a-z0-9@._+-]*$/i.test(t.key)) return null;
    if (t.ecosystem === "brew") return t.tap === null || t.tap === "homebrew/core" ? `https://formulae.brew.sh/api/formula/${encodeURIComponent(t.key)}.json` : null;
    return t.tap === null || t.tap === "homebrew/cask" ? `https://formulae.brew.sh/api/cask/${encodeURIComponent(t.key)}.json` : null;
  },
  parse(status, body, t) {
    const r = parseJson(status, body);
    if (isResult(r)) return r;
    if (t.ecosystem === "cask") {
      const version = typeof r.doc["version"] === "string" ? r.doc["version"] : null;
      if (version === null) return { status: "failed", answers: [], message: "cask has no version field" };
      // "latest" means the cask follows the vendor's download and names no version; "4.93.0,240920" carries a build after the comma.
      if (version === "latest") return { status: "ok", answers: [], message: "cask version is 'latest'" };
      return { status: "ok", answers: [{ channel: "stable", version: version.split(",")[0] ?? version, installable: true }] };
    }
    const versions = r.doc["versions"];
    const stable = versions && typeof versions === "object" ? (versions as Record<string, unknown>)["stable"] : null;
    if (typeof stable !== "string" || stable === "") return { status: "failed", answers: [], message: "formula has no stable version" };
    const revision = typeof r.doc["revision"] === "number" && r.doc["revision"] > 0 ? `_${r.doc["revision"]}` : "";
    return { status: "ok", answers: [{ channel: "stable", version: `${stable}${revision}`, installable: true }] };
  },
};
