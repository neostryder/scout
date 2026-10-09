interface Version {
  parts: [number, number, number];
  pre: string[];
}

interface Bound {
  version: Version;
  count: number;
}

interface Comparator {
  operator: ">=" | ">" | "<=" | "<" | "=";
  version: Version;
}

function bound(text: string): Bound | null {
  const match = /^v?(0|[1-9]\d*|x|\*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(0|[1-9]\d*|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/i.exec(text);
  if (!match) return null;
  const raw = match.slice(1, 4);
  let count = 0;
  let partial = false;
  const parts: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const value = raw[i];
    if (value === undefined || /^[x*]$/i.test(value)) partial = true;
    else {
      if (partial || !Number.isSafeInteger(Number(value))) return null;
      parts[i] = Number(value);
      count++;
    }
  }
  const pre = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  if ((pre.length > 0 || build.length > 0) && count !== 3) return null;
  if ([...pre, ...build].some((part) => part === "")) return null;
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { version: { parts, pre }, count };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! < b.parts[i]! ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function ceiling(version: Version, index: number): Version {
  const parts: [number, number, number] = [...version.parts];
  parts[index] = parts[index]! + 1;
  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  // The next line's prereleases belong to that line, not the wildcard or caret below it.
  return { parts, pre: ["0"] };
}

function expand(operator: string, value: Bound): Comparator[] | null {
  const { version, count } = value;
  const cmp = (operator: Comparator["operator"], version: Version): Comparator => ({ operator, version });
  if (count === 0) {
    if (["", "=", "==", ">=", "<=", "^", "~"].includes(operator)) return [];
    return null;
  }
  if (operator === "^" || operator === "~") {
    const index = operator === "~" ? Math.min(count - 1, 1) : version.parts[0] > 0 || count === 1 ? 0 : version.parts[1] > 0 || count === 2 ? 1 : 2;
    return [cmp(">=", version), cmp("<", ceiling(version, index))];
  }
  if (operator === "" || operator === "=" || operator === "==") {
    return count === 3 ? [cmp("=", version)] : [cmp(">=", version), cmp("<", ceiling(version, count - 1))];
  }
  if (operator === ">=") return [cmp(">=", version)];
  if (operator === "<") return [cmp("<", count === 3 ? version : { parts: version.parts, pre: ["0"] })];
  if (operator === ">") return [cmp(count === 3 ? ">" : ">=", count === 3 ? version : { parts: ceiling(version, count - 1).parts, pre: [] })];
  if (operator === "<=") return [cmp(count === 3 ? "<=" : "<", count === 3 ? version : ceiling(version, count - 1))];
  return null;
}

function alternative(text: string): Comparator[] | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const lower = bound(hyphen[1]!);
    const upper = bound(hyphen[2]!);
    if (!lower || !upper || lower.count === 0 || upper.count === 0) return null;
    return [{ operator: ">=", version: lower.version }, { operator: upper.count === 3 ? "<=" : "<", version: upper.count === 3 ? upper.version : ceiling(upper.version, upper.count - 1) }];
  }
  const tokens = text.replace(/(>=|<=|==|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|==|>|<|=|\^|~)?(.+)$/.exec(token);
    if (!match) return null;
    const value = bound(match[2]!);
    if (!value) return null;
    const expanded = expand(match[1] ?? "", value);
    if (!expanded) return null;
    comparators.push(...expanded);
  }
  return comparators;
}

/** Unknown syntax returns null because an unreadable requirement cannot establish compatibility. */
export function satisfiesDependencyRange(version: string, range: string): boolean | null {
  try {
    const target = bound(version.trim());
    if (!target || target.count !== 3 || range.trim() === "") return null;
    const alternatives = range.trim().split("||").map((part) => alternative(part.trim()));
    if (alternatives.some((part) => part === null)) return null;
    return alternatives.some((comparators) => {
      if (!comparators) return false;
      if (target.version.pre.length > 0 && !comparators.some((cmp) => cmp.version.pre.length > 0 && cmp.version.parts.every((n, i) => n === target.version.parts[i]))) return false;
      return comparators.every((cmp) => {
        const order = compare(target.version, cmp.version);
        switch (cmp.operator) {
          case ">=": return order >= 0;
          case ">": return order > 0;
          case "<=": return order <= 0;
          case "<": return order < 0;
          case "=": return order === 0;
        }
      });
    });
  } catch {
    return null;
  }
}
