import { h } from "./lib.js";

// The page is served as plain files, so it cannot import the catalog's version compare.
const PRE = /^(alpha|a|beta|b|pre|preview|rc|c|dev|snapshot|nightly|canary|insiders|next)$/i;
const AFTER_TAG = /^(.*)-(\d+)-g[0-9a-f]+$/i;
const DETAIL_BYTES = 4 * 1024;

function tokens(version) {
  const v = version.trim().replace(/^v(?=\d)/i, "");
  const out = [];
  for (const m of v.matchAll(/\d+|[A-Za-z]+/g)) out.push({ num: /^\d/.test(m[0]), text: m[0] });
  return out;
}

function cmpNumber(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareVersions(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.some((t) => t.num) || !y.some((t) => t.num)) return null;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i];
    const q = y[i];
    if (p && q) {
      if (p.num && q.num) {
        const c = cmpNumber(p.text, q.text);
        if (c !== 0) return c;
      } else if (p.num !== q.num) {
        const word = p.num ? q : p;
        const lowWord = PRE.test(word.text);
        return p.num ? (lowWord ? 1 : -1) : lowWord ? -1 : 1;
      } else if (p.text.toLowerCase() !== q.text.toLowerCase()) {
        const pp = PRE.test(p.text);
        const qp = PRE.test(q.text);
        if (pp !== qp) return pp ? -1 : 1;
        return p.text.toLowerCase() < q.text.toLowerCase() ? -1 : 1;
      }
    } else if (p) {
      return p.num ? (BigInt(p.text) === 0n && x.slice(i).every((t) => t.num && BigInt(t.text) === 0n) ? 0 : 1) : PRE.test(p.text) ? -1 : 1;
    } else if (q) {
      return q.num ? (BigInt(q.text) === 0n && y.slice(i).every((t) => t.num && BigInt(t.text) === 0n) ? 0 : -1) : PRE.test(q.text) ? 1 : -1;
    }
  }
  return 0;
}

function newerRelease(nearestTag, describe, releaseTag) {
  if (releaseTag === null || releaseTag === "") return false;
  if (nearestTag && compareVersions(nearestTag, releaseTag) === -1) return true;
  const match = AFTER_TAG.exec(describe ?? "");
  if (!match) return false;
  const commits = Number(match[2]);
  if (!Number.isInteger(commits) || commits <= 0) return false;
  return compareVersions(releaseTag, match[1] ?? "") === 1;
}

function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function paragraphs(lines) {
  return lines.filter((line) => line).map((line) => ({ type: "p", text: line }));
}

function capBytes(value, max) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= max) return value;
  let size = 0;
  let end = 0;
  for (const char of value) {
    const next = size + new TextEncoder().encode(char).length;
    if (next > max) break;
    size = next;
    end += char.length;
  }
  return value.slice(0, end);
}

function cloneCount(clones, commit) {
  if (!commit || !clones) return undefined;
  const key = commit.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(clones, key)) return clones[key];
  for (const [name, value] of Object.entries(clones)) if (name.toLowerCase() === key) return value;
  return undefined;
}

function gitcloneBlocks(data, details) {
  const release = record(data.latestRelease);
  const tag = text(release?.tag);
  const published = text(release?.publishedAt);
  const branch = text(data.defaultBranch);
  const headAt = text(data.headAt);
  const count = cloneCount(record(data.clones), text(details?.commit));
  const behind = typeof count === "number" && Number.isFinite(count)
    ? `This clone is ${Math.trunc(count)} commits behind the default branch`
    : "Commits behind: not measured yet";
  const releaseLine = tag
    ? (newerRelease(text(details?.nearestTag), text(details?.describe), tag) ? `A newer release exists: ${tag}` : "Up to date with the latest release")
    : null;
  return paragraphs([
    branch ? `Default branch: ${branch}` : null,
    headAt ? `Head commit date: ${headAt}` : null,
    tag ? (published ? `Latest release: ${tag}, published ${published}` : `Latest release: ${tag}`) : null,
    behind,
    releaseLine,
    data.archived === true ? "Archived upstream" : null,
  ]);
}

function relatedLine(entry) {
  const row = record(entry);
  if (!row) return null;
  const id = text(row.id) ?? "unknown";
  const downloads = typeof row.downloads === "number" && Number.isFinite(row.downloads) ? Math.trunc(row.downloads) : 0;
  return `${id}, ${downloads} downloads${row.uncensored === true ? ", uncensored" : ""}`;
}

function successorLine(entry) {
  const row = record(entry);
  if (!row) return null;
  const id = text(row.id) ?? "unknown";
  const reason = text(row.reason) ?? "";
  const note = /possible/i.test(reason) ? reason : `possible successor: ${reason}`;
  return `${id}: ${note}`;
}

function huggingfaceBlocks(data) {
  if (data.error === "not-found") return paragraphs(["Hugging Face does not list this repository"]);
  if (data.error === "gated") return paragraphs(["This repository is gated; sign in to Hugging Face to see more"]);
  const revision = text(data.latestRevision);
  const changed = text(data.lastModified);
  const quants = Array.isArray(data.quantizations) ? data.quantizations.filter((item) => text(item)) : [];
  const related = (Array.isArray(data.related) ? data.related : []).slice(0, 8).map(relatedLine).filter((line) => line);
  const successors = (Array.isArray(data.successors) ? data.successors : []).map(successorLine).filter((line) => line);
  const blocks = paragraphs([
    revision ? (changed ? `Latest revision ${revision.slice(0, 12)}, changed ${changed}` : `Latest revision ${revision.slice(0, 12)}`) : null,
    data.hasNewerRevision === true ? "A newer revision exists" : data.hasNewerRevision === false ? "This is the latest revision" : null,
  ]);
  if (quants.length) blocks.push({ type: "p", text: "Quantizations" }, { type: "ul", items: quants });
  if (related.length) blocks.push({ type: "h3", text: "Related models" }, { type: "ul", items: related });
  if (successors.length) blocks.push({ type: "h3", text: "Possible successors" }, { type: "ul", items: successors });
  return blocks;
}

function unknownBlock(data) {
  let pretty = "";
  try { pretty = JSON.stringify(data ?? {}, null, 2); } catch { pretty = ""; }
  return { type: "details", summary: "Details", text: capBytes(pretty, DETAIL_BYTES) };
}

export function upstreamBlocks(detail) {
  const docs = Array.isArray(detail?.intel) ? detail.intel : [];
  if (docs.length === 0) return [];
  const blocks = [{ type: "h3", text: "Upstream" }];
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    if (doc.truncated === true) {
      blocks.push({ type: "p", text: "This upstream record is too large to show." });
      continue;
    }
    const data = record(doc.data) ?? {};
    if (doc.source === "gitclone") blocks.push(...gitcloneBlocks(data, record(detail?.details)));
    else if (doc.source === "huggingface") blocks.push(...huggingfaceBlocks(data));
    else blocks.push(unknownBlock(data));
  }
  return blocks;
}

export function upstreamSections(detail) {
  return upstreamBlocks(detail).map((block) => {
    if (block.type === "h3") return h("h3", {}, block.text);
    if (block.type === "ul") return h("ul", {}, block.items.map((item) => h("li", {}, item)));
    if (block.type === "details") return h("details", {}, h("summary", {}, block.summary), h("pre", {}, block.text));
    return h("p", {}, block.text);
  });
}
