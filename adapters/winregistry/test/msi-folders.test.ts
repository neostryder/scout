import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { adapter, parseMsiFolders } from "../src/index.ts";
import { MSI_SCRIPT } from "../src/msi-script.ts";

// Lines are real output of the probe on one machine: good folders and the noise the validator has to drop.
const MSI_OUTPUT = [
  "{16394977-6CA9-462C-99D8-7ABC61F1810B}\tC:/Program Files/GitHub CLI\t1",
  "{5F29C20F-A69A-45EB-9542-45054FE9D77F}\tC:/Program Files/Cloudflare/Cloudflare WARP\t598",
  "{5CF7D504-E832-450F-B0D0-5555ED775F51}\tC:/cloudflared\t2",
  "{31F92FD4-9AB9-4640-9DA2-CE25F7BFC72B}\tC:/Users/public/AppData/Roaming/Flixmate\t14",
  "{8AFB30E7-8172-472A-BE7A-B2367DED2FD5}\tC:\t1451",
  "{E127FDCB-98C7-41B6-AD61-F01331070020}\tC:/C:\t15",
  "{F0C3E5D1-1ADE-321E-8167-68EF0DE699A5}\tC:/?Windows/SysWOW64\t18",
  "{1851460E-0E63-4117-B5BA-25A2F045801B}\tC:/WINDOWS/Fonts\t2",
  "{9BE518E6-ECC6-35A9-88E4-87755C07200F}\tC:/?Program Files (x86)/Common Files/Microsoft Shared/VC\t1",
  "{AC21E17B-1DBC-444C-9CA8-DD45A9221D2F}\tC:/Program Files\t35",
  "not a product line",
  "",
].join("\n");

test("folders from the Windows Installer are kept only when they name one product", () => {
  const folders = parseMsiFolders(MSI_OUTPUT);
  assert.deepEqual([...folders].sort(), [
    ["{16394977-6CA9-462C-99D8-7ABC61F1810B}", "C:\\Program Files\\GitHub CLI"],
    ["{31F92FD4-9AB9-4640-9DA2-CE25F7BFC72B}", "C:\\Users\\public\\AppData\\Roaming\\Flixmate"],
    ["{5CF7D504-E832-450F-B0D0-5555ED775F51}", "C:\\cloudflared"],
    ["{5F29C20F-A69A-45EB-9542-45054FE9D77F}", "C:\\Program Files\\Cloudflare\\Cloudflare WARP"],
  ]);
  assert.equal(parseMsiFolders("").size, 0);
});

test("a registry row with no folder takes the installer folder, and one with its own folder keeps it", () => {
  const list = JSON.stringify([
    { Hive: "HKLM", Key: "{16394977-6CA9-462C-99D8-7ABC61F1810B}", DisplayName: "GitHub CLI", DisplayVersion: "2.97.0", Publisher: "GitHub, Inc.", InstallLocation: null, DisplayIcon: null, UninstallString: "MsiExec.exe /X{16394977-6CA9-462C-99D8-7ABC61F1810B}", SystemComponent: null },
    { Hive: "HKLM", Key: "{5CF7D504-E832-450F-B0D0-5555ED775F51}", DisplayName: "cloudflared", DisplayVersion: "2026.9.3", Publisher: "cloudflare", InstallLocation: "D:\\Tools\\cloudflared", DisplayIcon: null, UninstallString: null, SystemComponent: null },
    { Hive: "HKLM", Key: "{AC21E17B-1DBC-444C-9CA8-DD45A9221D2F}", DisplayName: "Synergy", DisplayVersion: "3.7.0.0", Publisher: "Symless Ltd", InstallLocation: null, DisplayIcon: null, UninstallString: null, SystemComponent: null },
  ]);
  const result = adapter.parse({ list: { exitCode: 0, stdout: list, stderr: "" }, msi: { exitCode: 0, stdout: MSI_OUTPUT, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  const by = Object.fromEntries(result.installs.map((i) => [i.name, i]));
  assert.equal(by["GitHub CLI"]?.location, "C:\\Program Files\\GitHub CLI");
  assert.equal(by["GitHub CLI"]?.details?.["locationSource"], "WindowsInstaller");
  assert.equal(by["cloudflared"]?.location, "D:\\Tools\\cloudflared");
  assert.equal(by["Synergy"]?.location, "");
  const without = adapter.parse({ list: { exitCode: 0, stdout: list, stderr: "" }, msi: { exitCode: 1, stdout: "", stderr: "boom" } }, "");
  assert.equal(without.status, "ok");
  assert.equal(without.installs[0]?.location, "");
});

test("the embedded installer script is byte-identical to tools/probes/windows/msi.ps1", () => {
  const file = fileURLToPath(new URL("../../../tools/probes/windows/msi.ps1", import.meta.url));
  assert.equal(MSI_SCRIPT, readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
});

test("the probe list names the installer probe as optional", () => {
  const probes = adapter.probes({ machineId: "m", os: "windows", roots: {} }, "");
  assert.deepEqual(probes.map((p) => [p.id, p.optional ?? false]), [["list", false], ["msi", true]]);
});
