import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getChromeLaunchCandidates,
  openUrlInChrome
} = require("../dist-electron/main/sso-chrome.js");

const projectRoot = path.resolve(import.meta.dirname, "..");

test("macOS SSO login opens Google Chrome with the authorization URL", () => {
  const url = "https://eiam.qiuer.net/auth/oauth2/authorize?state=state-123";

  assert.deepEqual(getChromeLaunchCandidates(url, "darwin", {}), [
    { command: "/usr/bin/open", args: ["-a", "Google Chrome", url] }
  ]);
});

test("macOS SSO login can use a dedicated Chrome profile", () => {
  const url = "https://eiam.qiuer.net/auth/oauth2/authorize?state=state-123";
  const userDataDir = "/Users/tester/Library/Application Support/ZenMind/chrome-sso-profile";

  assert.deepEqual(getChromeLaunchCandidates(url, "darwin", {}, { userDataDir }), [
    {
      command: "/usr/bin/open",
      args: [
        "-n",
        "-a",
        "Google Chrome",
        "--args",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        url
      ]
    }
  ]);
});

test("Windows SSO login tries explicit Chrome install paths", () => {
  const url = "https://eiam.qiuer.net/auth/oauth2/authorize?state=state-123";
  const candidates = getChromeLaunchCandidates(url, "win32", {
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)"
  });

  assert.deepEqual(candidates, [
    {
      command: "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      args: [url],
      requiresExistingFile: true
    },
    {
      command: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [url],
      requiresExistingFile: true
    },
    {
      command: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      args: [url],
      requiresExistingFile: true
    }
  ]);
});

test("openUrlInChrome falls back to the system browser when Chrome cannot be launched", async () => {
  const url = "https://eiam.qiuer.net/auth/oauth2/authorize?state=state-123";
  const opened = [];
  const result = await openUrlInChrome(url, {
    platform: "win32",
    env: { PROGRAMFILES: "C:\\Program Files" },
    existsSync: () => false,
    execFile: () => {
      throw new Error("Chrome should be skipped when the configured path is absent");
    },
    openExternal: async (targetUrl) => {
      opened.push(targetUrl);
    }
  });

  assert.deepEqual(opened, [url]);
  assert.deepEqual(result, { ok: true, browser: "default", command: "shell.openExternal" });
});

test("openUrlInChrome uses the first launchable Chrome candidate", async () => {
  const url = "https://eiam.qiuer.net/auth/oauth2/authorize?state=state-123";
  const calls = [];
  const result = await openUrlInChrome(url, {
    platform: "linux",
    execFile: (command, args, callback) => {
      calls.push({ command, args });
      if (command === "google-chrome") {
        callback(new Error("not installed"));
        return;
      }
      callback(null);
    },
    openExternal: async () => {
      throw new Error("fallback should not be used");
    }
  });

  assert.deepEqual(calls, [
    { command: "google-chrome", args: [url] },
    { command: "google-chrome-stable", args: [url] }
  ]);
  assert.deepEqual(result, { ok: true, browser: "chrome", command: "google-chrome-stable" });
});

test("Desktop SSO startLogin opens Chrome instead of the embedded browser", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const startLoginBlock = source.match(/ipcMain\.handle\("sso\.startLogin"[\s\S]*?ipcMain\.handle\("sso\.logout"/u)?.[0] ?? "";

  assert.match(startLoginBlock, /openUrlInChrome\(result\.authorizeUrl,\s*\{/u);
  assert.match(startLoginBlock, /getDesktopSsoChromeProfileDir\(\)/u);
  assert.doesNotMatch(startLoginBlock, /openBrowserUrl/u);
});
