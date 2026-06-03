import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  syncZenmindAppServerDesktopEnv
} = require("../dist-electron/main/services/manager/app-server-env.js");

const TEST_BCRYPT = "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1ue";
const CUSTOM_BCRYPT = "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1uf";

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

function writeTemplate(layout, content) {
  fs.mkdirSync(layout.programDir, { recursive: true });
  fs.writeFileSync(path.join(layout.programDir, ".env.example"), content, "utf8");
}

test("syncZenmindAppServerDesktopEnv repairs db path and unsafe bcrypt values", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-app-server-env-"));
  try {
    const layout = createLayout(tempRoot);
    writeTemplate(layout, [
      `AUTH_ADMIN_PASSWORD_BCRYPT='${TEST_BCRYPT}'`,
      `AUTH_APP_MASTER_PASSWORD_BCRYPT='${TEST_BCRYPT}'`
    ].join("\n"));
    const updates = new Map();

    syncZenmindAppServerDesktopEnv(layout, [
      "AUTH_DB_PATH=",
      `AUTH_ADMIN_PASSWORD_BCRYPT=${TEST_BCRYPT}`,
      "AUTH_APP_MASTER_PASSWORD_BCRYPT=not-a-bcrypt-hash"
    ].join("\n"), updates);

    assert.equal(updates.get("AUTH_DB_PATH"), path.join(layout.dataDir, "auth.db"));
    assert.equal(updates.get("AUTH_ADMIN_PASSWORD_BCRYPT"), `'${TEST_BCRYPT}'`);
    assert.equal(updates.get("AUTH_APP_MASTER_PASSWORD_BCRYPT"), `'${TEST_BCRYPT}'`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("syncZenmindAppServerDesktopEnv preserves custom valid single-quoted bcrypt values", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-app-server-env-custom-"));
  try {
    const layout = createLayout(tempRoot);
    writeTemplate(layout, [
      `AUTH_ADMIN_PASSWORD_BCRYPT='${TEST_BCRYPT}'`,
      `AUTH_APP_MASTER_PASSWORD_BCRYPT='${TEST_BCRYPT}'`
    ].join("\n"));
    const updates = new Map();

    syncZenmindAppServerDesktopEnv(layout, [
      `AUTH_ADMIN_PASSWORD_BCRYPT='${CUSTOM_BCRYPT}'`,
      `AUTH_APP_MASTER_PASSWORD_BCRYPT='${CUSTOM_BCRYPT}'`
    ].join("\n"), updates);

    assert.equal(updates.get("AUTH_DB_PATH"), path.join(layout.dataDir, "auth.db"));
    assert.equal(updates.has("AUTH_ADMIN_PASSWORD_BCRYPT"), false);
    assert.equal(updates.has("AUTH_APP_MASTER_PASSWORD_BCRYPT"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
