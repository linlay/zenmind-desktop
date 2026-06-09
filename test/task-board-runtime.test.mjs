import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readTaskBoardWsConfig } = await import("../dist-electron/main/task-board-runtime.js");

function createTempApp(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-task-board-runtime-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

function writeKanbanConfig(app, config) {
  const configPath = path.join(app.getPath("home"), ".zenmind", ".desktop", "config", "desktop", "kanban.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

test("task board websocket config is disabled until remote control is allowed", (t) => {
  const app = createTempApp(t);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a"
  });
  assert.equal(readTaskBoardWsConfig(app), null);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a",
    remoteControlEnabled: true
  });
  assert.deepEqual(readTaskBoardWsConfig(app), {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a"
  });
});
