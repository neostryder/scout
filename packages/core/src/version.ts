// Version comparison for installed and available versions from many ecosystems. It is deliberately loose: dotted
// numbers compare by value, a pre-release word (alpha, beta, rc, dev, preview) sorts below the release it precedes, and
// anything after "_" or "-r" is a packaging revision that sorts above the bare version. A string with no digits cannot
// be compared, and the answer is then null rather than a guess.

const PRE = /^(alpha|a|beta|b|pre|preview|rc|c|dev|snapshot|nightly|canary|insiders|next)$/i;

interface Token {
  num: boolean;
  text: string;
}

function tokens(version: string): Token[] {
  const v = version.trim().replace(/^v(?=\d)/i, "");
  const out: Token[] = [];
  for (const m of v.matchAll(/\d+|[A-Za-z]+/g)) out.push({ num: /^\d/.test(m[0]), text: m[0] });
  return out;
}

function cmpNumber(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** -1, 0 or 1, or null when either string has no digits. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
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
        if (c !== 0) return c as -1 | 1;
      } else if (p.num !== q.num) {
        // A number against a word: a pre-release word is below a number (1.0-rc1 < 1.0.1), any other word is above.
        const word = p.num ? q : p;
        const lowWord = PRE.test(word.text);
        return (p.num ? (lowWord ? 1 : -1) : lowWord ? -1 : 1) as -1 | 1;
      } else if (p.text.toLowerCase() !== q.text.toLowerCase()) {
        const pp = PRE.test(p.text);
        const qp = PRE.test(q.text);
        if (pp !== qp) return pp ? -1 : 1;
        return p.text.toLowerCase() < q.text.toLowerCase() ? -1 : 1;
      }
    } else if (p) {
      // a has more tokens. A trailing pre-release word means a is older; a trailing number or other word means newer.
      return p.num ? (BigInt(p.text) === 0n && x.slice(i).every((t) => t.num && BigInt(t.text) === 0n) ? 0 : 1) : PRE.test(p.text) ? -1 : 1;
    } else if (q) {
      return q.num ? (BigInt(q.text) === 0n && y.slice(i).every((t) => t.num && BigInt(t.text) === 0n) ? 0 : -1) : PRE.test(q.text) ? 1 : -1;
    }
  }
  return 0;
}

/** True when `latest` is strictly newer than `installed`; false when equal, older or not comparable. */
export function isNewer(latest: string, installed: string): boolean {
  return compareVersions(latest, installed) === 1;
}

/** The highest of several versions, skipping any that cannot be compared with the running best. */
export function maxVersion(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (best === null || compareVersions(v, best) === 1) best = v;
  return best;
}
