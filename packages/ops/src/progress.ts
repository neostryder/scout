import type { JobPhase } from "@scout/core";

/** What one line of an update's output says: the stage it reached, and whether an administrator prompt is about to appear. */
export interface ProgressEvent { phase?: JobPhase; uacExpected?: true }

const RANK: Record<JobPhase, number> = { download: 1, verify: 2, install: 3, finish: 4 };

// winget prints no progress bar to a pipe, only these stage lines, so stages are the honest measure of progress.
const WINGET: [RegExp, ProgressEvent][] = [
  [/^Downloading\b/, { phase: "download" }],
  [/^Successfully verified installer hash/, { phase: "verify" }],
  [/^Starting package install/, { phase: "install" }],
  [/will request to run as administrator|Expect a prompt/i, { uacExpected: true }],
  [/^Successfully installed\b/, { phase: "finish" }],
];
const BREW: [RegExp, ProgressEvent][] = [
  [/^==> Downloading\b/, { phase: "download" }],
  [/^==> (?:Pouring|Installing|Moving App|Linking)\b/, { phase: "install" }],
  [/^==> (?:Caveats|Summary)\b/, { phase: "finish" }],
];

/** Ecosystems whose single command has no stages Scout can read; the update itself is the install stage. */
export const unstaged = (ecosystem: string): boolean => !["winget", "msstore", "brew", "cask"].includes(ecosystem);

/**
 * A line-buffered reader for one update command's output. Chunks may split a line and winget redraws with carriage returns,
 * so both are line breaks. A stage is reported once, when it is first reached, and the stages never move backwards.
 */
export function progressReader(ecosystem: string): (chunk: string) => ProgressEvent[] {
  const rules = ecosystem === "winget" || ecosystem === "msstore" ? WINGET : ecosystem === "brew" || ecosystem === "cask" ? BREW : [];
  let pending = "";
  let reached = 0;
  return (chunk) => {
    const lines = (pending + chunk).split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    const events: ProgressEvent[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      for (const [pattern, event] of rules) {
        if (!pattern.test(line)) continue;
        if (event.phase) {
          if (RANK[event.phase] <= reached) break;
          reached = RANK[event.phase];
        }
        events.push(event);
        break;
      }
    }
    return events;
  };
}
