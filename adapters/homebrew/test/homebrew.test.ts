import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { brewAdapter, caskAdapter } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/homebrew", import.meta.url));
fixtureTests(brewAdapter, dir);
fixtureTests(caskAdapter, dir);
