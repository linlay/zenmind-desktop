import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  createAssistantBootstrapStateMonitor,
  getAssistantBootstrapState,
  resolveAssistantOwnerProfilePath,
} = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "assistant",
  "core",
  "bootstrap-state.js",
));
const { resolveRuntimeRoot } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "env-bootstrap.js",
));

function createHomeApp(homePath) {
  return {
    getPath(name) {
      assert.equal(name, "home");
      return homePath;
    },
  };
}

function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("timed out waiting for bootstrap state change"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("OWNER marker path follows macOS and Windows runtime-root resolution", () => {
  const macApp = createHomeApp("/Users/linlay");
  assert.equal(
    resolveAssistantOwnerProfilePath(macApp, "darwin"),
    path.join(resolveRuntimeRoot(macApp, "darwin"), "owner", "OWNER.md"),
  );

  const windowsApp = createHomeApp("C:\\Users\\linlay");
  assert.equal(
    resolveAssistantOwnerProfilePath(windowsApp, "win32"),
    path.win32.join(resolveRuntimeRoot(windowsApp, "win32"), "owner", "OWNER.md"),
  );
});

test("OWNER marker must be a regular file and read failures mean not initialized", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-owner-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createHomeApp(path.join(root, "home"));
  const ownerPath = resolveAssistantOwnerProfilePath(app, "darwin");

  assert.deepEqual(getAssistantBootstrapState(app, "darwin"), { ownerProfileExists: false });
  fs.mkdirSync(ownerPath, { recursive: true });
  assert.deepEqual(getAssistantBootstrapState(app, "darwin"), { ownerProfileExists: false });
  fs.rmSync(ownerPath, { recursive: true, force: true });
  fs.writeFileSync(ownerPath, "owner profile\n", "utf8");
  assert.deepEqual(getAssistantBootstrapState(app, "darwin"), { ownerProfileExists: true });
});

test("OWNER monitor reports initial absence, creation, and deletion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-owner-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createHomeApp(path.join(root, "home"));
  const ownerPath = resolveAssistantOwnerProfilePath(app, "darwin");
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  const states = [];
  const monitor = createAssistantBootstrapStateMonitor({
    app,
    platform: "darwin",
    intervalMs: 20,
    onChange: (state) => states.push(state.ownerProfileExists),
  });
  t.after(() => monitor.stop());

  monitor.start();
  assert.deepEqual(states, [false]);
  fs.writeFileSync(ownerPath, "owner profile\n", "utf8");
  await waitFor(() => states.includes(true));
  fs.rmSync(ownerPath);
  await waitFor(() => states.length >= 3 && states.at(-1) === false);
  assert.deepEqual(states, [false, true, false]);
});
