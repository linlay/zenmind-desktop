import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const serviceRepos = ["agent-container-hub", "agent-webclient", "agent-platform", "identity-center"];

for (const scenario of ["success", "keep", "failure", "dry-run"]) {
  test(`PowerShell release orchestration: ${scenario}`, { skip: process.platform !== "win32" }, (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-ps-release-"));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(tempRoot).startsWith("zenmind-ps-release-"));
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });
    const desktopRoot = path.join(tempRoot, "desktop");
    const scriptsRoot = path.join(desktopRoot, "scripts");
    const workspaceRoot = path.join(tempRoot, "workspace with spaces");
    const logPath = path.join(tempRoot, "calls.jsonl");
    fs.mkdirSync(scriptsRoot, { recursive: true });
    const scriptPath = path.join(scriptsRoot, "build-builtin-services.ps1");
    fs.copyFileSync(path.resolve("scripts/build-builtin-services.ps1"), scriptPath);
    fs.writeFileSync(path.join(scriptsRoot, "sync-builtin-assets.mjs"), `
      import fs from 'node:fs';
      fs.appendFileSync(process.env.TEST_RELEASE_LOG, JSON.stringify({sync: process.argv.slice(2)}) + '\\n');
    `);
    for (const repo of serviceRepos) {
      const repoRoot = path.join(workspaceRoot, repo);
      fs.mkdirSync(path.join(repoRoot, "dist/release"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "dist/release/stale.txt"), "stale");
      fs.writeFileSync(path.join(repoRoot, "Makefile"), 'SHELL := cmd.exe\n.SHELLFLAGS := /d /s /c\nrelease:\n\t@node release.cjs $(ARCH)\n');
      fs.writeFileSync(path.join(repoRoot, "release.cjs"), `
        const fs = require('node:fs');
        fs.appendFileSync(process.env.TEST_RELEASE_LOG, JSON.stringify({
          repo: ${JSON.stringify(repo)}, arch: process.argv[2],
          stale: fs.existsSync('dist/release/stale.txt'),
          version: process.env.VERSION, targets: process.env.PROGRAM_TARGETS,
          matrix: process.env.PROGRAM_TARGET_MATRIX, goos: process.env.GOOS
        }) + '\\n');
        if (process.env.TEST_FAIL_REPO === ${JSON.stringify(repo)}) process.exit(2);
      `);
    }
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
    if (scenario !== "keep") args.push("-Clean");
    if (scenario === "dry-run") args.push("-DryRun");
    const result = spawnSync("powershell.exe", args, {
      encoding: "utf8",
      env: {
        ...process.env, DESKTOP_WORKSPACE_ROOT: workspaceRoot,
        TEST_RELEASE_LOG: logPath, TEST_FAIL_REPO: scenario === "failure" ? "agent-platform" : "",
        VERSION: "must-not-forward", PROGRAM_TARGETS: "must-not-forward",
        PROGRAM_TARGET_MATRIX: "must-not-forward", GOOS: "windows"
      }
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, scenario === "failure" ? 1 : 0, output);
    const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse) : [];
    if (scenario === "dry-run") {
      assert.deepEqual(calls, []);
      for (const repo of serviceRepos) assert.ok(fs.existsSync(path.join(workspaceRoot, repo, "dist/release/stale.txt")));
      assert.match(output, /sync current upstream release packages/u);
      return;
    }
    const releases = calls.filter((call) => call.repo);
    assert.deepEqual(releases.map((call) => call.repo), scenario === "failure" ? serviceRepos.slice(0, 3) : serviceRepos);
    for (const call of releases) {
      assert.equal(call.arch, "amd64");
      assert.equal(call.stale, scenario === "keep");
      assert.equal(call.version, undefined);
      assert.equal(call.targets, undefined);
      assert.equal(call.matrix, undefined);
      assert.equal(call.goos, "windows");
    }
    if (scenario === "failure") {
      assert.equal(calls.length, 3);
      assert.ok(fs.existsSync(path.join(workspaceRoot, "identity-center/dist/release/stale.txt")));
    } else {
      assert.deepEqual(calls.at(-1).sync, [
        ...serviceRepos.map((repo) => `--source=${path.join(workspaceRoot, repo, "dist/release")}`),
        "--os=windows", "--arch=amd64"
      ]);
    }
  });
}
