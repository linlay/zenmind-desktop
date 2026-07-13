import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = process.cwd();
const buildAllScript = path.join(projectRoot, "scripts", "build-all-dist.sh");
const serviceRepos = [
  "agent-container-hub",
  "agent-webclient",
  "agent-platform",
  "identity-center"
];

test("build-all-dist releases every upstream service with only ARCH and explicit sources", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-build-all-workspace-"));
  t.after(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  for (const repoName of serviceRepos) {
    const repoRoot = path.join(workspaceRoot, repoName);
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "Makefile"), "release:\n\t@true\n", "utf8");
  }

  const output = execFileSync(
    "bash",
    [buildAllScript, "--dry-run", "--sync-os", "darwin", "--sync-arch", "arm64"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DESKTOP_WORKSPACE_ROOT: workspaceRoot,
        VERSION: "desktop-must-not-forward",
        PROGRAM_TARGETS: "windows",
        PROGRAM_TARGET_MATRIX: "windows/amd64"
      }
    }
  );

  for (const repoName of serviceRepos) {
    const repoRoot = path.join(workspaceRoot, repoName);
    assert.match(
      output,
      new RegExp(`\\(cd ${escapeRegExp(repoRoot)} && unset VERSION PROGRAM_TARGETS PROGRAM_TARGET_MATRIX && make release ARCH=arm64\\)`, "u")
    );
    assert.match(output, new RegExp(`--source=${escapeRegExp(path.join(repoRoot, "dist", "release"))}`, "u"));
  }
  assert.doesNotMatch(output, /--only|--skip|--no-clean|--no-sync/u);
});

test("build-all-dist leaves existing Desktop assets untouched when an upstream release fails", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-build-all-failure-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const desktopRoot = path.join(tempRoot, "desktop");
  const scriptsRoot = path.join(desktopRoot, "scripts");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.copyFileSync(buildAllScript, path.join(scriptsRoot, "build-all-dist.sh"));
  const existingAsset = path.join(desktopRoot, "build", "resources", "services", "keep.txt");
  fs.mkdirSync(path.dirname(existingAsset), { recursive: true });
  fs.writeFileSync(existingAsset, "keep\n", "utf8");

  for (const repoName of serviceRepos) {
    const repoRoot = path.join(workspaceRoot, repoName);
    fs.mkdirSync(repoRoot, { recursive: true });
    const releaseRecipe = repoName === serviceRepos[0]
      ? [
          "release:",
          "\t@printf 'ARCH=%s VERSION=%s TARGETS=%s\\n' \"$$ARCH\" \"$$VERSION\" \"$$PROGRAM_TARGETS\" > invocation.txt",
          "\t@false"
        ].join("\n")
      : "release:\n\t@true";
    fs.writeFileSync(path.join(repoRoot, "Makefile"), `${releaseRecipe}\n`, "utf8");
  }

  assert.throws(
    () => execFileSync(
      "bash",
      [path.join(scriptsRoot, "build-all-dist.sh"), "--sync-os", "darwin", "--sync-arch", "arm64"],
      {
        cwd: desktopRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DESKTOP_WORKSPACE_ROOT: workspaceRoot,
          VERSION: "desktop-must-not-forward",
          PROGRAM_TARGETS: "windows"
        }
      }
    )
  );

  assert.equal(fs.readFileSync(existingAsset, "utf8"), "keep\n");
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, serviceRepos[0], "invocation.txt"), "utf8"),
    "ARCH=arm64 VERSION= TARGETS=\n"
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
