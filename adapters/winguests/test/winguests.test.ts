import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { sbxAdapter, wslAdapter } from "../src/index.ts";

fixtureTests(wslAdapter, fileURLToPath(new URL("../../../fixtures/wsl", import.meta.url)));
fixtureTests(sbxAdapter, fileURLToPath(new URL("../../../fixtures/sbx", import.meta.url)));
