import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/uvtool", import.meta.url));
fixtureTests(adapter, dir);
