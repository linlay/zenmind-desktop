import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

function runMenuAssertion(scriptBody) {
  const appMenuPath = path.resolve("dist-electron/main/app-shell/app-menu.js");
  const script = `
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
const calls = { template: null, menu: null, quitCount: 0, settingsCount: 0 };
Module._load = function(request, parent, isMain) {
  if (request === "electron") {
    return {
      Menu: {
        buildFromTemplate(template) {
          calls.template = template;
          return { template };
        },
        setApplicationMenu(menu) {
          calls.menu = menu;
        }
      }
    };
  }
  return originalLoad.apply(this, arguments);
};
const { buildApplicationMenu } = require(${JSON.stringify(appMenuPath)});
const messages = {
  "menu.file": "File",
  "menu.settings": "Settings",
  "menu.settingsEllipsis": "Settings...",
  "menu.quit": "Quit {appName}"
};
const t = (key, params = {}) => messages[key].replace("{appName}", params.appName ?? "");
${scriptBody}
`;
  execFileSync(process.execPath, ["-e", script], { stdio: "pipe" });
}

test("macOS application menu routes Command+Q through the guarded quit callback", () => {
  runMenuAssertion(`
buildApplicationMenu({
  appName: "ZenMind",
  platform: "darwin",
  t,
  openSettings: () => {
    calls.settingsCount += 1;
  },
  requestQuit: () => {
    calls.quitCount += 1;
  }
});
const appMenu = calls.template[0];
const quitItem = appMenu.submenu.at(-1);
assert.equal(appMenu.label, "ZenMind");
assert.equal(quitItem.role, undefined);
assert.equal(quitItem.label, "Quit ZenMind");
assert.equal(quitItem.accelerator, "Command+Q");
quitItem.click();
assert.equal(calls.quitCount, 1);
assert.equal(calls.menu.template, calls.template);
`);
});

test("non-macOS application menu keeps the default Electron quit role", () => {
  runMenuAssertion(`
buildApplicationMenu({
  appName: "ZenMind",
  platform: "win32",
  t,
  openSettings: () => {
    calls.settingsCount += 1;
  },
  requestQuit: () => {
    calls.quitCount += 1;
  }
});
const fileMenu = calls.template[0];
const quitItem = fileMenu.submenu.at(-1);
assert.equal(fileMenu.label, "File");
assert.equal(quitItem.role, "quit");
assert.equal(quitItem.click, undefined);
assert.equal(calls.quitCount, 0);
`);
});
