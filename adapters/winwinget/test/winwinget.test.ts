import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter } from "../src/index.ts";

fixtureTests(adapter, fileURLToPath(new URL("../../../fixtures/winget", import.meta.url)));
