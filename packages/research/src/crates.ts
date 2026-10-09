import { compareVersions } from "@scout/core";
import { DAILY, isResult, parseJson, type Answer, type Researcher } from "./types.ts";

export const crates: Researcher = {
  source: "crates",
  ecosystems: ["cargo"],
  ttlMs: DAILY,
  url(target) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target.key) ? `https://crates.io/api/v1/crates/${encodeURIComponent(target.key)}` : null;
  },
  parse(status, body) {
    const result = parseJson(status, body);
    if (isResult(result)) return result;
    const crate = result.doc["crate"];
    if (!crate || typeof crate !== "object" || Array.isArray(crate)) return { status: "failed", answers: [], message: "response has no crate" };
    const fields = crate as Record<string, unknown>;
    const stable = fields["max_stable_version"];
    const latest = fields["max_version"];
    const valid = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
    if (stable !== null && !valid(stable)) return { status: "failed", answers: [], message: "crate has no stable version field" };
    if (!valid(latest)) return { status: "failed", answers: [], message: "crate has no maximum version" };
    const answers: Answer[] = [];
    if (valid(stable)) answers.push({ channel: "stable", version: stable, installable: false });
    if (stable === null || compareVersions(latest, stable) === 1) answers.push({ channel: "beta", version: latest, installable: false });
    return { status: "ok", answers };
  },
};
