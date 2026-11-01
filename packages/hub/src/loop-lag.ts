interface LoopLagOptions {
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  log: (line: string) => void;
  setTimer?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}

interface Activity {
  label: string;
  start: number;
}

export function createLoopLag({ thresholdMs = 1000, intervalMs = 250, now = () => performance.now(), log, setTimer = setInterval, clearTimer = clearInterval }: LoopLagOptions): { begin(label: string): () => void; start(): void; stop(): void } {
  const running = new Set<Activity>();
  const finished: (Activity & { end: number })[] = [];
  let finishedIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previous = 0;
  let lastLog = -Infinity;

  const tick = (): void => {
    const at = now();
    const since = previous;
    previous = at;
    const blockedMs = at - since - intervalMs;
    if (blockedMs <= thresholdMs || at - lastLog < 10_000) return;
    const active = [...running].slice(0, 5).map((activity) => `${activity.label} (${Math.round(at - activity.start)} ms)`);
    const completed = finished.filter((activity) => activity.start >= since && activity.end <= at)
      .sort((a, b) => a.start - b.start).slice(0, 5)
      .map((activity) => `${activity.label} (${Math.round(activity.end - activity.start)} ms)`);
    lastLog = at;
    log(`[lag] event loop was blocked about ${Math.round(blockedMs)} ms${active.length ? `; running now: ${active.join(", ")}` : ""}${completed.length ? `; finished during the stall: ${completed.join(", ")}` : ""}`);
  };

  return {
    begin(label) {
      const activity = { label: label.replace(/[^\x20-\x7e]/g, "?"), start: now() };
      running.add(activity);
      return () => {
        if (!running.delete(activity)) return;
        finished[finishedIndex] = { ...activity, end: now() };
        finishedIndex = (finishedIndex + 1) % 50;
      };
    },
    start() {
      if (timer !== undefined) return;
      previous = now();
      timer = setTimer(tick, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer === undefined) return;
      clearTimer(timer);
      timer = undefined;
    },
  };
}
