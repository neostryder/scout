import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureTests } from "@scout/core/testing";
import { adapter, deriveLocation } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/registry", import.meta.url));
fixtureTests(adapter, dir);

test("a folder comes from the icon first, then the uninstaller, and never from a shared or launcher path", () => {
  assert.deepEqual(deriveLocation("C:\\Program Files\\Vortex\\Vortex.exe,0", ""), { folder: "C:\\Program Files\\Vortex", source: "DisplayIcon" });
  assert.deepEqual(deriveLocation("", "\"C:\\Program Files\\USBPcap\\Uninstall.exe\" /allusers"), { folder: "C:\\Program Files\\USBPcap", source: "UninstallString" });
  assert.deepEqual(deriveLocation("", "C:\\Program Files\\Tesseract-OCR\\tesseract-uninstall.exe"), { folder: "C:\\Program Files\\Tesseract-OCR", source: "UninstallString" });
  assert.equal(deriveLocation("", "MsiExec.exe /X{16394977-6CA9-462C-99D8-7ABC61F1810B}"), null);
  assert.equal(deriveLocation("", "\"C:\\Program Files (x86)\\Steam\\steam.exe\" steam://uninstall/2430930"), null);
  assert.equal(deriveLocation("C:\\Windows\\Installer\\{ABC}\\icon.exe", ""), null);
  assert.equal(deriveLocation("C:\\Program Files\\setup.exe", ""), null);
  assert.equal(deriveLocation("null", ""), null);
});
