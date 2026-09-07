import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electron from "electron";

test("real Electron persists SSO across restart and persists logout", {
  skip: process.env.RUN_SSO_ELECTRON_TEST !== "1", timeout: 90000
}, async (t) => {
  const scenarios = [{ migrate: false, legacyPartition: false }, { migrate: false, legacyPartition: true }];
  if (process.platform === "darwin") scenarios.push({ migrate: true, legacyPartition: false });
  for (const { migrate, legacyPartition } of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-sso-persistence-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const phase of ["write", "restore", "logout", "signed-out"]) {
      const env = { ...process.env, SSO_PERSISTENCE_TEST_ROOT: root, SSO_PERSISTENCE_TEST_PHASE: phase,
        SSO_PERSISTENCE_MIGRATE_ROOT: migrate && phase === "write" ? "1" : "0" };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [fileURLToPath(new URL("./fixtures/sso-persistence-electron.cjs", import.meta.url))], {
        env, stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      assert.equal(code, 0, `phase=${phase} migration=${migrate}\n${output}`);
      const result = JSON.parse(fs.readFileSync(path.join(root, `${phase}.json`), "utf8"));
      assert.equal(result.ok, true);
      if (phase === "write" && legacyPartition) {
        // Emulate a previous release, then let production initialization migrate
        // the real Chromium Cookie store before the restore process opens it.
        fs.mkdirSync(path.dirname(result.legacySsoRoot), { recursive: true });
        fs.renameSync(result.profileRoot, result.legacySsoRoot);
        const localState = path.join(result.legacySsoRoot, "Local State");
        if (fs.existsSync(localState)) {
          fs.renameSync(localState, path.join(path.dirname(path.dirname(result.legacySsoRoot)), "Local State"));
        }
      }
    }
  }
});
