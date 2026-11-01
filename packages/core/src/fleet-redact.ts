import type { IncidentPacket } from "./fleet-packet.ts";

export interface Redaction { text: string; rules: string[] }

// A 40-character hex run after the word "commit" is a git sha, so the hex rule leaves it alone.
const COMMIT_SHA = /commit:?\s+$/i;

function apply(text: string, rules: string[], id: string, pattern: RegExp, replacement: string): string {
  const next = text.replace(pattern, replacement);
  if (next !== text) rules.push(id);
  return next;
}

export function redact(text: string): Redaction {
  const rules: string[] = [];
  let next = text;
  next = apply(next, rules, "private-key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g, "[redacted:private-key]");
  next = apply(next, rules, "discord", /https?:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g, "[redacted:discord]");
  next = apply(next, rules, "url-credential", /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted:url-credential]@");
  next = apply(next, rules, "github", /(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,})/g, "[redacted:github]");
  next = apply(next, rules, "telegram", /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, "[redacted:telegram]");
  next = apply(next, rules, "aws", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted:aws]");
  next = apply(next, rules, "jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted:jwt]");
  next = apply(next, rules, "authorization", /Authorization:\s*\S+/gi, "[redacted:authorization]");
  next = apply(next, rules, "bearer", /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, "[redacted:bearer]");
  next = apply(next, rules, "secret", /(?<![A-Za-z0-9_])(password|passwd|secret|token|api[_-]?key|apikey|credential)(\s*[=:]\s*)(["']?)(?!\[redacted:)([^\s"'&,;]+)/gi, "$1$2$3[redacted:secret]");
  const beforeLong = next;
  let sawHex = false;
  let sawBase64 = false;
  next = next.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, (match, offset: number) => {
    const body = match.replace(/=+$/, "");
    if (/^[0-9a-fA-F]+$/.test(body)) {
      const prefix = beforeLong.slice(Math.max(0, offset - 24), offset);
      if (body.length === 40 && COMMIT_SHA.test(prefix)) return match;
      sawHex = true;
      return "[redacted:hex]";
    }
    sawBase64 = true;
    return "[redacted:base64]";
  });
  if (sawHex) rules.push("hex");
  if (sawBase64) rules.push("base64");
  return { text: next, rules };
}

export function redactPacket(packet: IncidentPacket): IncidentPacket {
  const found: string[] = [];
  const one = (value: string): string => {
    const result = redact(value);
    for (const rule of result.rules) if (!found.includes(rule)) found.push(rule);
    return result.text;
  };
  const evidence: IncidentPacket["evidence"] = { ...packet.evidence };
  if (evidence.stderrTail !== undefined) evidence.stderrTail = one(evidence.stderrTail);
  if (evidence.journalTail !== undefined) evidence.journalTail = one(evidence.journalTail);
  if (evidence.recentChanges) evidence.recentChanges = evidence.recentChanges.map(one);
  if (evidence.snapshot) {
    const snapshot: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(evidence.snapshot)) snapshot[key] = typeof value === "string" ? one(value) : value;
    evidence.snapshot = snapshot;
  }
  const summary = one(packet.summary);
  const rules = [...packet.redaction.rules];
  for (const rule of found) if (!rules.includes(rule)) rules.push(rule);
  return { ...packet, summary, evidence, redaction: { applied: rules.length > 0, rules } };
}
