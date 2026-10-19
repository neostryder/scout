import type { Channel, SupportWindow } from "@scout/core";

// A researcher asks one source what the latest version of a package is. Like an inventory adapter it is pure: `url`
// names the request and `parse` turns the recorded response into answers, so each one is tested against responses
// recorded from the real service. The runner owns the network, the cache and the storage.

export interface ResearchTarget {
  id: number;
  ecosystem: string;
  key: string;
  name: string;
  /** Homebrew tap of an install of this package, when the catalog knows it. */
  tap: string | null;
  homepage: string | null;
  /** Details from the newest live install of this package. */
  details: Record<string, unknown>;
  /** The runner supplies the observation time for support-calendar comparisons. */
  observedAt?: string;
}

export interface Answer {
  channel: Channel;
  version: string;
  installable: boolean;
  advisory?: boolean;
}

export interface Researched {
  /** ok: the source knows the package (answers may still be empty); notfound: it does not; failed: the answer was unusable. */
  status: "ok" | "notfound" | "failed";
  answers: Answer[];
  message?: string;
  /** Stored with putIntel. Omitted when the source has nothing beyond its version answers. */
  intel?: Record<string, unknown>;
}

export interface Researcher {
  /** Stored with every assertion. */
  source: string;
  ecosystems: string[];
  /** How long an answer, or a "not found", is reused before the package is asked about again. */
  ttlMs: number;
  /** The request for this package, or null when this source cannot be asked about it (a third-party tap, an odd name). */
  url(target: ResearchTarget): string | null;
  parse(status: number, body: string, target: ResearchTarget, headers?: ResponseHeaders): Researched;
  /** The next request, when an earlier response decides it. Sources that need one request omit this. */
  follow?(target: ResearchTarget, prior: { url: string; status: number; body: string }[]): string | null;
  extra?(target: ResearchTarget, status: number, body: string): SupportWindow[];
}

const HOUR = 3_600_000;
export const DAILY = 24 * HOUR;
export const WEEKLY = 7 * DAILY;
export const SIX_HOURS = 6 * HOUR;
export type ResponseHeaders = Record<string, string>;

/** Shared status handling: 404 is notfound, any other non-200 is failed, and a body that is not JSON is failed. */
export function parseJson(status: number, body: string): { doc: Record<string, unknown> } | Researched {
  if (status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
  if (status !== 200) return { status: "failed", answers: [], message: `HTTP ${status}` };
  try {
    const doc: unknown = JSON.parse(body);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) return { doc: doc as Record<string, unknown> };
  } catch {
    // fall through
  }
  return { status: "failed", answers: [], message: "response is not a JSON object" };
}

export const isResult = (v: { doc: Record<string, unknown> } | Researched): v is Researched => "status" in v;
