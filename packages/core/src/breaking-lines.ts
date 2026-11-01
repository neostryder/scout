export interface BreakingLine { line: number; text: string; reason: string }

const patterns: [RegExp, string][] = [
  [/\bbreaking\s+change\b/i, "breaking change"],
  [/\bbreaking\s*:/i, "breaking change"],
  [/\bBREAKING\b/i, "breaking change"],
  [/\bbackwards? incompatible\b/i, "incompatible change"],
  [/\bnot backward compatible\b/i, "incompatible change"],
  [/\bincompatible with\b/i, "incompatible change"],
  [/\b(?:removed|drops?) support for\b/i, "support dropped"],
  [/\bdropped support\b/i, "support dropped"],
  [/\bno longer supported\b/i, "support dropped"],
  [/\brequires migration\b|\bmigration required\b|\bmust migrate\b/i, "migration needed"],
  [/\brenamed\b.*\bto\b/i, "renamed interface"],
  [/\bdeprecated and removed\b/i, "deprecated and removed"],
  [/\bremoves the\b/i, "removed interface"],
  [/\bnow requires\s+(?:(?:v|version\s*)?\d+(?:\.\d+)*(?:[-+][\w.]+)?|node|python|java|go|rust|dotnet|glibc|macos|windows|openssl)\b/i, "new minimum requirement"],
];
const section = /^\s{0,3}#{1,6}\s+breaking changes?\s*#*\s*$/i;
const heading = /^\s{0,3}(#{1,6})\s+/;
const bullet = /^\s{0,3}(?:[-+*]\s+|\d+[.)]\s+)/;
const renamedInterface = /\b(?:api|option|flag|command|config)\b/i;

export function breakingLines(text: string): BreakingLine[] {
  if (!text) return [];
  const result: BreakingLine[] = [];
  const lines = text.split(/\r?\n/);
  let fence: { char: string; length: number } | null = null;
  let breakingLevel: number | null = null;
  for (let index = 0; index < lines.length; index++) {
    const value = lines[index]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(value);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const headingMatch = heading.exec(value);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      if (breakingLevel !== null && level <= breakingLevel) breakingLevel = null;
      if (section.test(value)) {
        result.push({ line: index + 1, text: value, reason: "breaking section" });
        breakingLevel = level;
        continue;
      }
    }
    if (breakingLevel !== null && bullet.test(value)) {
      result.push({ line: index + 1, text: value, reason: "under a breaking section" });
      continue;
    }
    for (const [pattern, reason] of patterns) {
      if (!pattern.test(value)) continue;
      if (reason === "renamed interface" && !renamedInterface.test(value)) continue;
      result.push({ line: index + 1, text: value, reason });
      break;
    }
  }
  return result;
}
