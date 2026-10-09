import { DAILY, isResult, parseJson, type Researcher } from "./types.ts";

const MODULE = /^[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)+$/;
const PSEUDO = /(?:-|\.)\d{14}-[0-9a-f]{12}(?:\+incompatible)?$/;

export const goproxy: Researcher = {
  source: "goproxy",
  ecosystems: ["go-bin"],
  ttlMs: DAILY,
  url(target) {
    const module = target.details.module;
    if (typeof module !== "string" || !MODULE.test(module) || module.split("/").some((part) => part === "." || part === "..")) return null;
    const escaped = module.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
    return `https://proxy.golang.org/${escaped}/@latest`;
  },
  parse(status, body) {
    const result = parseJson(status, body);
    if (isResult(result)) return result;
    const version = result.doc["Version"];
    if (typeof version !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return { status: "failed", answers: [], message: "response has no module version" };
    if (PSEUDO.test(version)) return { status: "ok", answers: [], message: "the latest module version is a pseudo-version" };
    if (version.includes("-")) return { status: "ok", answers: [], message: "the latest module version is a prerelease" };
    return { status: "ok", answers: [{ channel: "stable", version, installable: false }] };
  },
};
