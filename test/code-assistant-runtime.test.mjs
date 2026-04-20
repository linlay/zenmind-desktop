import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCodeAssistantRuntime } from "../scripts/lib/code-assistant-runtime.mjs";
import { resolveBundledWindowsBunPath } from "../scripts/dist-win.mjs";

function createRuntimeSourceFixture(tempRoot) {
  const sourceRoot = path.join(tempRoot, "claude-code-guotai");
  const distRoot = path.join(sourceRoot, "dist");

  fs.mkdirSync(distRoot, { recursive: true });
  fs.writeFileSync(path.join(distRoot, "cli.js"), "console.log('cli');\n", "utf8");
  fs.writeFileSync(
    path.join(distRoot, "relay-chunk.js"),
    "async function startRelayServer() { return {}; }\nexport { startRelayServer };\n",
    "utf8"
  );

  return sourceRoot;
}

test("resolveBundledWindowsBunPath validates configured bun.exe paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-dist-win-bun-"));
  const validBunPath = path.join(tempRoot, "bun.exe");
  const invalidBunPath = path.join(tempRoot, "bun");

  try {
    fs.writeFileSync(validBunPath, "binary", "utf8");
    fs.writeFileSync(invalidBunPath, "binary", "utf8");

    assert.equal(resolveBundledWindowsBunPath({}), null);
    assert.equal(
      resolveBundledWindowsBunPath({ ZENMIND_DESKTOP_BUNDLED_BUN_PATH: validBunPath }),
      validBunPath
    );
    assert.throws(
      () => resolveBundledWindowsBunPath({ ZENMIND_DESKTOP_BUNDLED_BUN_PATH: invalidBunPath }),
      /bun\.exe/u
    );
    assert.throws(
      () =>
        resolveBundledWindowsBunPath({
          ZENMIND_DESKTOP_BUNDLED_BUN_PATH: path.join(tempRoot, "missing-bun.exe")
        }),
      /未找到 Windows 版 bun\.exe/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  "syncCodeAssistantRuntime fails fast for windows targets without an explicit bun.exe on non-Windows hosts",
  { skip: process.platform === "win32" },
  () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-runtime-sync-"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = createRuntimeSourceFixture(tempRoot);

    try {
      fs.mkdirSync(projectRoot, { recursive: true });
      assert.throws(
        () =>
          syncCodeAssistantRuntime(projectRoot, {
            os: "windows",
            arch: "amd64",
            sourceRoot
          }),
        /ZENMIND_DESKTOP_BUNDLED_BUN_PATH/u
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
);
