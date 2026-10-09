import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadFileName, downloadHttps, resolveCaskDownload, resolveGithubDownload, resolveSparkleDownload, resolveWingetDownload } from "../src/download-source.ts";

const windows = { platform: "windows" as const, arch: "x64" as const };
const arm = { platform: "macos" as const, arch: "arm64" as const };
const intel = { platform: "macos" as const, arch: "x64" as const };
const hash = "a".repeat(64);
const asset = (name: string, extra: Record<string, unknown> = {}) => ({ name, browser_download_url: `https://releases.example.test/${encodeURIComponent(name)}`, content_type: "application/octet-stream", size: 123, digest: `sha256:${hash}`, ...extra });

test("download GitHub fixtures select one installer and reject ambiguous or wrong assets", () => {
  const good = asset("Demo-windows-x64.exe");
  const result = resolveGithubDownload({ assets: [asset("Demo-windows-arm64.exe"), asset("source-windows-x64.exe"), asset("Demo-linux-x64.exe"), asset("Demo-windows-x86.exe"), asset("Demo-windows-x64.exe.sha256"), good] }, windows);
  assert.deepEqual(result, { url: good.browser_download_url, fileName: good.name, size: 123, sha256: hash, source: "github" });
  assert.equal(resolveGithubDownload({ assets: [good, asset("Demo-windows-x64.msi")] }, windows), null);
  assert.equal(resolveGithubDownload({ assets: [good] }, { ...windows, arch: "arm64" }), null);
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-macos-x64.dmg")] }, arm), null);
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-macos-arm64.dmg")] }, intel), null);
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-macos-arm64.zip")] }, arm), null);
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-macos-universal.dmg"), asset("Demo.app-macos-arm64.zip", { content_type: "application/zip" })] }, arm)?.fileName, "Demo-macos-universal.dmg");
  assert.equal(resolveGithubDownload({ assets: [asset("Demo.app-macos-arm64.zip", { content_type: "application/zip" })] }, arm)?.fileName, "Demo.app-macos-arm64.zip");
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-windows-x64.exe", { content_type: "text/plain" })] }, windows), null);
  assert.equal(resolveGithubDownload({ assets: [asset("Demo-windows-x64.exe", { digest: null })] }, windows)?.sha256, null);
  assert.equal(resolveGithubDownload({ assets: [good], prerelease: true }, windows), null);
  assert.equal(resolveGithubDownload({ assets: [asset("../Demo-windows-x64.exe", { browser_download_url: "https://localhost/file.exe" })] }, windows), null);
});

test("download cask fixtures resolve arch blocks and published API variations", () => {
  const cask = { url: "https://vendor.example.test/Demo.dmg", sha256: hash, on_arm: { url: "https://vendor.example.test/Demo-arm64.dmg", sha256: "b".repeat(64) }, on_intel: { url: "https://vendor.example.test/Demo-x64.dmg", sha256: "no_check" } };
  assert.equal(resolveCaskDownload(cask, arm)?.sha256, "b".repeat(64));
  assert.equal(resolveCaskDownload(cask, intel)?.sha256, null);
  assert.equal(resolveCaskDownload(cask, windows), null);
  assert.equal(resolveCaskDownload({ url: cask.url, arch: "arm64" }, intel), null);
  assert.equal(resolveCaskDownload({ url: "https://vendor.example.test/Demo-#{arch}.dmg", arch: { arm: "arm64", intel: "x64" }, sha256: { arm: hash, intel: "no_check" } }, arm)?.fileName, "Demo-arm64.dmg");
  assert.equal(resolveCaskDownload({ url: cask.url, sha256: hash, variations: { arm64_tahoe: { url: "https://vendor.example.test/arm64.dmg" }, tahoe: { url: "https://vendor.example.test/x64.dmg" } } }, intel)?.fileName, "x64.dmg");
  assert.equal(resolveCaskDownload({ url: cask.url, variations: { arm64_tahoe: { url: "https://vendor.example.test/a.dmg" }, arm64_sonoma: { url: "https://vendor.example.test/b.dmg" } } }, arm), null);
  assert.equal(resolveCaskDownload({ url: "https://vendor.example.test/Demo-x64.dmg" }, arm), null);
  assert.equal(resolveCaskDownload({ url: cask.url, depends_on: { arch: [{ type: "arm", bits: 64 }] } }, intel), null);
  assert.equal(resolveCaskDownload({ url: cask.url }, arm)?.sha256, null);
  assert.equal(resolveCaskDownload({ url: "http://vendor.example.test/Demo.dmg" }, arm), null);
  assert.equal(resolveCaskDownload({ url: cask.url, sha256: "invalid" }, arm), null);
});

test("download Sparkle fixtures ignore signatures and reject incompatible enclosures", () => {
  const item = { url: "https://vendor.example.test/Demo.dmg", length: "1234", "sparkle:edSignature": "signature" };
  assert.deepEqual(resolveSparkleDownload(item, arm), { url: item.url, fileName: "Demo.dmg", size: 1234, sha256: null, source: "sparkle" });
  assert.equal(resolveSparkleDownload(item, windows), null);
  assert.equal(resolveSparkleDownload({ ...item, "sparkle:arch": "x86_64" }, arm), null);
  assert.equal(resolveSparkleDownload({ ...item, "sparkle:os": "windows" }, arm), null);
  assert.equal(resolveSparkleDownload({ ...item, length: "bad" }, arm)?.size, null);
  assert.equal(resolveSparkleDownload({ ...item, url: "https://[::1]/Demo.dmg" }, arm), null);
});

test("download winget fixtures keep repeated installer labels in separate blocks", () => {
  const block = (arch: string, file = "Demo.exe") => `Installer Type: exe\nInstaller Url: https://vendor.example.test/${file}\nInstaller SHA256: ${hash}\nArchitecture: ${arch}\n`;
  assert.equal(resolveWingetDownload(block("arm64") + block("x64"), windows)?.fileName, "Demo.exe");
  assert.equal(resolveWingetDownload(block("x64") + block("x64", "Other.exe"), windows), null);
  assert.equal(resolveWingetDownload(block("arm64"), windows), null);
  assert.equal(resolveWingetDownload(block("x64"), arm), null);
  assert.equal(resolveWingetDownload("Installer Type: msi\nArchitecture: x64\nInstaller Url: https://vendor.example.test/Demo.msi", windows)?.sha256, null);
  assert.equal(resolveWingetDownload(block("x64").replace(hash, "bad"), windows), null);
  assert.equal(resolveWingetDownload(block("x64").replace("vendor.example.test", "127.0.0.1"), windows), null);
});

test("download URL and file name fixtures reject unsafe values and preserve extensions", () => {
  for (const url of ["http://example.test/f", "file:///f", "https://127.1/f", "https://2130706433/f", "https://[2001:db8::1]/f", "https://localhost./f", "https://a.localhost/f", "https://user:password@example.test/f", "invalid"]) assert.equal(downloadHttps(url), null);
  assert.equal(downloadFileName("../../evil\\path:   Demo?.exe"), "evilpath Demo.exe");
  assert.equal(downloadFileName("."), null);
  assert.equal(downloadFileName("***"), null);
  assert.equal(downloadFileName("CON.exe"), null);
  const long = downloadFileName("x".repeat(200) + ".msix");
  assert.equal(long?.length, 120);
  assert.ok(long?.endsWith(".msix"));
  for (const value of [null, [], {}, 5, "malformed"]) {
    assert.equal(resolveGithubDownload(value, arm), null);
    assert.equal(resolveCaskDownload(value, arm), null);
    assert.equal(resolveSparkleDownload(value, arm), null);
    assert.equal(resolveWingetDownload(value, windows), null);
  }
});
