// The one seam through which Scout asks a language model anything. The hub builds a real runner at start-up; every
// module that needs a model takes this type as an injected option, and tests pass a fake. A request names its task
// and the class of data in the prompt: "public" is text from public pages and release notes, "internal" is a view of
// the inventory that has been stripped of usernames, paths and project names.

export interface ModelRequest {
  /** A short fixed name for the job, such as `changelog-summary`, `vendor-version` or `dependency-discovery`. */
  task: string;
  prompt: string;
  dataClass: "public" | "internal";
  failOnCap?: boolean;
}

export class ModelCapError extends Error {
  constructor(cap: number) {
    super(`model hourly cap of ${cap} calls reached`);
    this.name = "ModelCapError";
  }
}

/** Resolves to the model's plain-text answer, or null when no model could answer. It never throws for an unavailable model. */
export type ModelRunner = (request: ModelRequest) => Promise<string | null>;
