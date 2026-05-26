import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  resolveWebviewOpenDisposition,
  shouldDownloadUrlFromWebview,
  shouldOpenUrlInDesktopTab
} = require("../dist-electron/main/webview-open-tab.js");

test("shouldOpenUrlInDesktopTab only keeps http and https inside the desktop shell", () => {
  assert.equal(shouldOpenUrlInDesktopTab("https://example.com/workbench"), true);
  assert.equal(shouldOpenUrlInDesktopTab("http://127.0.0.1:3000/app"), true);
  assert.equal(shouldOpenUrlInDesktopTab("mailto:support@example.com"), false);
  assert.equal(shouldOpenUrlInDesktopTab("zenmind://open/settings"), false);
  assert.equal(shouldOpenUrlInDesktopTab("not-a-url"), false);
});

test("resolveWebviewOpenDisposition routes browser URLs to tabs and everything else externally", () => {
  assert.equal(resolveWebviewOpenDisposition("https://example.com/new-tab"), "tab");
  assert.equal(resolveWebviewOpenDisposition("http://localhost:11949/health"), "tab");
  assert.equal(resolveWebviewOpenDisposition("http://127.0.0.1:7080/tmp/hello.docx"), "download");
  assert.equal(resolveWebviewOpenDisposition("mailto:team@example.com"), "external");
  assert.equal(resolveWebviewOpenDisposition("file:///tmp/report.html"), "external");
});

test("shouldDownloadUrlFromWebview detects generated file artifacts", () => {
  assert.equal(shouldDownloadUrlFromWebview("http://127.0.0.1:7080/tmp/hello.docx"), true);
  assert.equal(shouldDownloadUrlFromWebview("https://example.com/export/report.xlsx?token=abc"), true);
  assert.equal(shouldDownloadUrlFromWebview("http://localhost:11949/health"), false);
  assert.equal(shouldDownloadUrlFromWebview("mailto:team@example.com"), false);
});

test("parseHttpUrl rejects invalid or unsupported protocols", () => {
  assert.equal(__testInternals.parseHttpUrl("https://example.com")?.protocol, "https:");
  assert.equal(__testInternals.parseHttpUrl("http://example.com")?.protocol, "http:");
  assert.equal(__testInternals.parseHttpUrl("ftp://example.com"), null);
  assert.equal(__testInternals.parseHttpUrl(""), null);
});
