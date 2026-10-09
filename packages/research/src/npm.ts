import { compareVersions } from "@scout/core";
import { DAILY, isResult, parseJson, type Answer, type Researcher } from "./types.ts";

// The npm registry's dist-tags endpoint is a few hundred bytes. `latest` is the stable version. A beta channel exists
// only where the project defines one: the highest of the `beta`, `rc` and `next` tags that is newer than `latest`.

const NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const BETA_TAGS = ["beta", "rc", "next"];

export const npmRegistry: Researcher = {
  source: "npm",
  ecosystems: ["npm"],
  ttlMs: DAILY,
  url(t) {
    return NAME.test(t.key) ? `https://registry.npmjs.org/-/package/${t.key.replace("/", "%2F")}/dist-tags` : null;
  },
  parse(status, body) {
    const r = parseJson(status, body);
    if (isResult(r)) return r;
    const tags = r.doc;
    const latest = tags["latest"];
    if (typeof latest !== "string" || latest === "") return { status: "failed", answers: [], message: "no latest tag" };
    const answers: Answer[] = [{ channel: "stable", version: latest, installable: true }];
    let beta: string | null = null;
    for (const tag of BETA_TAGS) {
      const v = tags[tag];
      if (typeof v !== "string" || compareVersions(v, latest) !== 1) continue;
      if (beta === null || compareVersions(v, beta) === 1) beta = v;
    }
    if (beta !== null) answers.push({ channel: "beta", version: beta, installable: true });
    return { status: "ok", answers };
  },
};
