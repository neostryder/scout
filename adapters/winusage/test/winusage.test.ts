import { fileURLToPath } from "node:url";
import { usageFixtureTests } from "@scout/core/testing";
import { userassistAdapter, processesAdapter } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../fixtures", import.meta.url));
usageFixtureTests(userassistAdapter, `${root}/userassist`);
usageFixtureTests(processesAdapter, `${root}/processes`);
