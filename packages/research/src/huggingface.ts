import { DAILY, isResult, parseJson, type Researcher, type ResearchTarget } from "./types.ts";

const API = "https://huggingface.co/api/models";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

export function huggingfaceRepo(target: ResearchTarget): string | null {
  if (target.ecosystem !== "model") return null;
  const repo = /^hf:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?::[A-Za-z0-9_-]+)?$/.exec(target.key)?.[1];
  return repo && repo.split("/").every((part) => part !== "." && part !== "..") ? repo : null;
}

export function ggufQuant(name: string): string | null {
  return [...name.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "").matchAll(/(?:^|[.-])((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4))(?=$|[.-])/gi)].at(-1)?.[1]?.toUpperCase() ?? null;
}

export function modelFamily(name: string): { stem: string; version: number[] } {
  const stripped = name.replace(/(?:[.-](?:GGUF|instruct|it|(?:UD-)?I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4))+$/gi, "");
  const versions = [...stripped.matchAll(/v?(\d+(?:\.\d+)*)(?=[-_.]|$)/gi)];
  return { stem: stripped.replace(/\d+(?:\.\d+)?b(?=[-_.]|$)/gi, "").replace(/v?\d+(?:\.\d+)*(?=[-_.]|$)/gi, "").replace(/[-_.]+/g, "-").replace(/^-|-$/g, "").toLowerCase(), version: (versions[0]?.[1] ?? "").split(".").filter(Boolean).map(Number) };
}

function array(body: string): Record<string, unknown>[] | null {
  try { const doc: unknown = JSON.parse(body); return Array.isArray(doc) ? doc.slice(0, 20).map(object) : null; } catch { return null; }
}

const checkedAt = (target: ResearchTarget): string => target.observedAt ?? new Date().toISOString();

export const huggingface: Researcher = {
  source: "huggingface",
  ecosystems: ["model"],
  ttlMs: DAILY,
  url(target) {
    const repo = huggingfaceRepo(target);
    return repo ? `${API}/${repo}` : null;
  },
  parse(status, body, target, headers) {
    const checked = checkedAt(target);
    if (status === 401 || status === 404) return { status: "notfound", answers: [], intel: { error: status === 401 ? "gated" : "not-found", checkedAt: checked } };
    if (status === 429) return { status: "failed", answers: [], message: `Hugging Face rate limit; retry after ${headers?.["retry-after"] ?? "unknown"}` };
    const parsed = parseJson(status, body);
    if (isResult(parsed)) return parsed;
    const { doc } = parsed;
    const revision = text(doc.sha);
    if (!revision) return { status: "failed", answers: [], message: "response has no revision" };
    const files = Array.isArray(doc.siblings) ? doc.siblings.flatMap((file) => {
      const name = text(object(file).rfilename);
      return name && /\.gguf$/i.test(name) ? [name] : [];
    }) : [];
    const installed = text(target.details.revision);
    return {
      status: "ok", answers: [{ channel: "unknown", version: revision.slice(0, 12), installable: false }],
      intel: {
        latestRevision: revision, lastModified: text(doc.lastModified), hasNewerRevision: installed ? revision !== installed : null,
        ggufFiles: files, quantizations: [...new Set(files.map(ggufQuant).filter((q) => q !== null))], related: [], successors: [],
        gated: doc.gated ?? false, disabled: doc.disabled ?? false, baseModel: object(doc.cardData).base_model ?? null, createdAt: text(doc.createdAt), checkedAt: checked,
      },
    };
  },
  followups(target) {
    const repo = huggingfaceRepo(target);
    if (!repo) return {};
    const [owner, name = ""] = repo.split("/");
    const stem = modelFamily(name).stem;
    return {
      quantized: `${API}?${new URLSearchParams({ filter: `base_model:quantized:${repo}`, sort: "downloads", limit: "20" })}`,
      finetune: `${API}?${new URLSearchParams({ filter: `base_model:finetune:${repo}`, sort: "downloads", limit: "20" })}`,
      ...(stem ? { successors: `${API}?${new URLSearchParams({ author: owner!, search: stem, sort: "lastModified", limit: "20" })}` } : {}),
    };
  },
  combine(result, responses, target) {
    if (!result.intel || result.status !== "ok") return result;
    const intel = { ...result.intel };
    const errors: Record<string, string> = {};
    const lists: Record<string, Record<string, unknown>[]> = {};
    for (const [name, response] of Object.entries(responses)) {
      const docs = response.status === 200 ? array(response.body) : null;
      if (docs) lists[name] = docs;
      else errors[name] = `HTTP ${response.status} or invalid list`;
    }
    const related = new Map<string, Record<string, unknown>>();
    for (const doc of [...(lists.quantized ?? []), ...(lists.finetune ?? [])]) {
      const id = text(doc.id);
      if (!id) continue;
      const tags = Array.isArray(doc.tags) ? doc.tags.filter((tag): tag is string => typeof tag === "string") : [];
      related.set(id, { id, downloads: typeof doc.downloads === "number" ? doc.downloads : 0, likes: typeof doc.likes === "number" ? doc.likes : 0, lastModified: text(doc.lastModified), uncensored: /uncensored|abliterated|heretic|unfiltered|decensored/i.test(`${id} ${tags.join(" ")}`), gguf: /gguf/i.test(`${id} ${tags.join(" ")}`) });
    }
    intel.related = [...related.values()];
    const repo = huggingfaceRepo(target)!;
    const current = modelFamily(repo.split("/")[1]!);
    const successors: { id: string; lastModified: string | null; reason: string }[] = [];
    for (const doc of lists.successors ?? []) {
      const id = text(doc.id);
      if (!id || id === repo || id.split("/")[0] !== repo.split("/")[0]) continue;
      const candidate = modelFamily(id.split("/")[1] ?? "");
      if (candidate.stem !== current.stem) continue;
      const n = Math.max(current.version.length, candidate.version.length);
      let comparison = 0;
      for (let i = 0; i < n; i++) { comparison = (candidate.version[i] ?? 0) - (current.version[i] ?? 0); if (comparison) break; }
      // Creation dates, unlike modification dates, can support the fallback rule.
      const created = text(doc.createdAt);
      const currentCreated = text(intel.createdAt);
      const newer = created && currentCreated && Date.parse(created) > Date.parse(currentCreated);
      if (current.version.length && candidate.version.length && comparison > 0) successors.push({ id, lastModified: text(doc.lastModified), reason: "possible successor: same family stem and higher version token" });
      else if (newer) successors.push({ id, lastModified: text(doc.lastModified), reason: "possible successor: same family stem and later creation date" });
      if (successors.length >= 5) break;
    }
    intel.successors = successors;
    if (Object.keys(errors).length) intel.lookupErrors = errors;
    return { ...result, intel };
  },
};
