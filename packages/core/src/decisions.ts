export const PRIORITY_WEIGHTS = {
  behind: 35,
  usage: 20,
  running: 5,
  exposure: 10,
  security: 45,
  breaking: -5,
  migration: -5,
  removed: -5,
} as const;

export const PRIORITY_BUMP_VALUES = { major: 1, minor: 0.6, patch: 0.3, other: 0.4 } as const;
export const PRIORITY_STEP_LIMITS = { minor: 5, patch: 10 } as const;
export const PRIORITY_USAGE_WINDOWS = [{ days: 7, value: 1 }, { days: 30, value: 0.6 }, { days: 90, value: 0.3 }] as const;
export const PRIORITY_UNKNOWN_USAGE = 0.1;
export const PRIORITY_EXPOSED_KINDS = ["service", "image"] as const;
export const PRIORITY_EXPOSED_CATEGORIES = ["server", "database", "networking", "security", "security tool", "container image"] as const;
