import { fileURLToPath } from "node:url";
import { usageFixtureTests } from "@scout/core/testing";
import { processesAdapter, spotlightAdapter } from "../src/index.ts";

const spotlightDir = fileURLToPath(new URL("../../../fixtures/spotlight", import.meta.url));
const processesDir = fileURLToPath(new URL("../../../fixtures/processes-mac", import.meta.url));

usageFixtureTests(spotlightAdapter, spotlightDir);
usageFixtureTests(processesAdapter, processesDir);
