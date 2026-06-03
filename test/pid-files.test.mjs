import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getManagedPidFilePaths,
  readManagedPidFile
} = require("../dist-electron/main/services/manager/pid-files.js");

function createService(pidRelativePath = "run/zenmind-app-server.pid") {
  return {
    runtime: {
      pidRelativePath
    }
  };
}

function createLayout(root) {
  return {
    programDir: path.join(root, "program"),
    configDir: path.join(root, "config"),
    dataDir: path.join(root, "data"),
    stateDir: path.join(root, "state"),
    logDir: path.join(root, "logs"),
    envPath: path.join(root, "config", ".env")
  };
}

test("getManagedPidFilePaths includes state, program, and legacy pid directory paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pid-paths-"));
  try {
    const layout = createLayout(tempRoot);
    assert.deepEqual(getManagedPidFilePaths(createService(), layout), [
      path.join(layout.stateDir, "zenmind-app-server.pid"),
      path.join(layout.programDir, "run", "zenmind-app-server.pid"),
      path.join(layout.stateDir, "pid", "zenmind-app-server.pid")
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("readManagedPidFile preserves live pid files when process ownership is unknown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pid-unknown-"));
  const pidPath = path.join(tempRoot, "service.pid");

  try {
    fs.writeFileSync(pidPath, "4321\n", "utf8");

    const pid = readManagedPidFile([pidPath], tempRoot, {
      isProcessRunningImpl: (candidatePid) => candidatePid === 4321,
      matchProcessInstallDirImpl: () => "unknown"
    });

    assert.equal(pid, 4321);
    assert.equal(fs.existsSync(pidPath), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("readManagedPidFile removes live pid files from unrelated install dirs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pid-mismatch-"));
  const pidPath = path.join(tempRoot, "service.pid");

  try {
    fs.writeFileSync(pidPath, "4321\n", "utf8");

    const pid = readManagedPidFile([pidPath], tempRoot, {
      isProcessRunningImpl: (candidatePid) => candidatePid === 4321,
      matchProcessInstallDirImpl: () => "mismatched"
    });

    assert.equal(pid, null);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
