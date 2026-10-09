import { brewApi } from "./brew.ts";
import { npmRegistry } from "./npm.ts";
import { pypi } from "./pypi.ts";
import { github } from "./github.ts";
import { goproxy } from "./goproxy.ts";
import { crates } from "./crates.ts";
import { sparkle } from "./sparkle.ts";
import { endoflife } from "./endoflife.ts";
import { vendor } from "./vendor.ts";
import type { Researcher } from "./types.ts";

export * from "./types.ts";
export * from "./runner.ts";
export { brewApi, npmRegistry, pypi };
export { github, goproxy, crates, sparkle };
export { endoflife, vendor };
export * from "./changelog.ts";

/** Every researcher Scout runs, in the order the design prefers: the owning package manager first. */
export const RESEARCHERS: Researcher[] = [brewApi, npmRegistry, pypi, goproxy, crates, sparkle, github, endoflife, vendor];
