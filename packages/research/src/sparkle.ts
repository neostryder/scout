import { compareVersions } from "@scout/core";
import { SIX_HOURS, type Answer, type Researcher } from "./types.ts";

interface Element {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
  text: string;
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (!name.startsWith("#")) return named[name] ?? entity;
    const value = name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

function readXml(body: string): Element {
  const root: Element = { name: "", attributes: {}, children: [], text: "" };
  const stack = [root];
  // Appcasts sometimes contain incomplete items. A missing closing tag must not discard the rest of the feed.
  for (const match of body.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g)) {
    const token = match[0];
    const parent = stack.at(-1) ?? root;
    if (token.startsWith("<![CDATA[")) {
      parent.text += token.slice(9, -3);
    } else if (token.startsWith("<!") || token.startsWith("<?")) {
      continue;
    } else if (token.startsWith("</")) {
      const name = /^<\/\s*([^\s>]+)/.exec(token)?.[1];
      const index = stack.findLastIndex((node) => node.name === name);
      if (index > 0) stack.length = index;
    } else if (token.startsWith("<")) {
      const name = /^<\s*([^\s/>]+)/.exec(token)?.[1];
      if (!name) continue;
      const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const attribute of token.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributes[attribute[1] as string] = decode(attribute[2] ?? attribute[3] ?? "");
      }
      if (name === "item" && stack.some((node) => node.name === "item")) stack.length = stack.findIndex((node) => node.name === "item");
      const node: Element = { name, attributes, children: [], text: "" };
      (stack.at(-1) ?? root).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
    } else {
      parent.text += decode(token);
    }
  }
  return root;
}

export const sparkle: Researcher = {
  source: "sparkle",
  ecosystems: ["bundle"],
  ttlMs: SIX_HOURS,
  url(target) {
    const feed = target.details.sparkleFeed;
    if (typeof feed !== "string" || !URL.canParse(feed)) return null;
    const url = new URL(feed);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? feed : null;
  },
  parse(status, body) {
    if (status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
    if (status !== 200) return { status: "failed", answers: [], message: `HTTP ${status}` };
    const root = readXml(body);
    if (!root.children.some((node) => node.name === "rss")) return { status: "failed", answers: [], message: "response is not an RSS appcast" };
    let stable: string | null = null;
    let beta: string | null = null;
    const nodes = [...root.children];
    while (nodes.length) {
      const item = nodes.pop() as Element;
      if (item.name !== "item") {
        nodes.push(...item.children);
        continue;
      }
      const enclosure = item.children.find((node) => node.name === "enclosure");
      const field = (name: string): string => (enclosure?.attributes[`sparkle:${name}`] ?? item.children.find((node) => node.name === `sparkle:${name}`)?.text ?? "").trim();
      const version = field("shortVersionString") || field("version");
      if (!/^v?\d+(?:[.\dA-Za-z+_-]*)$/.test(version)) continue;
      const channel = field("channel");
      if (channel === "") {
        if (stable === null || compareVersions(version, stable) === 1) stable = version;
      } else if (["beta", "rc", "preview", "nightly"].includes(channel)) {
        if (beta === null || compareVersions(version, beta) === 1) beta = version;
      }
    }
    const answers: Answer[] = [];
    if (stable !== null) answers.push({ channel: "stable", version: stable, installable: false });
    if (beta !== null && (stable === null || compareVersions(beta, stable) === 1)) answers.push({ channel: "beta", version: beta, installable: false });
    return { status: "ok", answers };
  },
};
