import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { BRAND_ID } = await import("../dist-electron/shared/brand.js");
const trayInstances = [];

class FakeTray extends EventEmitter {
  tooltip = "";
  contextMenu = null;
  destroyed = false;

  constructor(icon) {
    super();
    this.icon = icon;
    trayInstances.push(this);
  }

  setToolTip(value) {
    this.tooltip = value;
  }

  setContextMenu(menu) {
    this.contextMenu = menu;
  }

  popUpContextMenu(menu) {
    this.contextMenu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

const fakeElectron = {
  Menu: {
    buildFromTemplate(template) {
      return { template };
    }
  },
  Tray: FakeTray,
  nativeImage: {
    createFromPath() {
      return {
        isEmpty: () => false,
        resize: () => ({})
      };
    },
    createEmpty() {
      return {
        resize: () => ({})
      };
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return fakeElectron;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let AppTrayController;
let getAppTrayIconCandidatePaths;
let getWindowsDevelopmentAppIconPath;
try {
  ({
    AppTrayController,
    getAppTrayIconCandidatePaths,
    getWindowsDevelopmentAppIconPath
  } = require("../dist-electron/main/modules/shell/tray.js"));
} finally {
  Module._load = originalLoad;
}

test("Windows development uses the generated app ICO for its main window and transparent art for its tray", () => {
  const options = {
    platform: "win32",
    isPackaged: false,
    mainDir: "C:\\app\\dist-electron",
    resourcesPath: "C:\\app\\resources"
  };

  assert.equal(
    getWindowsDevelopmentAppIconPath(options),
    `C:\\app\\build\\brands\\${BRAND_ID}\\icons\\icon.ico`
  );
  assert.deepEqual(getAppTrayIconCandidatePaths(options).slice(0, 2), [
    `C:\\app\\build\\brands\\${BRAND_ID}\\brand-assets\\tray-icon.png`,
    `C:\\app\\build\\brands\\${BRAND_ID}\\icons\\icon.ico`
  ]);
  assert.equal(getWindowsDevelopmentAppIconPath({ ...options, isPackaged: true }), undefined);
  assert.equal(getWindowsDevelopmentAppIconPath({ ...options, platform: "darwin" }), undefined);
});

test("Windows tray exposes app activation and an explicit quit action", () => {
  const calls = [];
  const controller = new AppTrayController({
    platform: "win32",
    isPackaged: false,
    appName: "ZenMind",
    t: (key) => key,
    mainDir: "C:\\app\\dist-electron\\main",
    resourcesPath: "C:\\app\\resources",
    getDesktopPetEnabled: () => false,
    isDesktopPetSupported: () => false,
    openAssistantChat: () => calls.push("chat"),
    showMainWindow: () => calls.push("show"),
    openSettings: () => calls.push("settings"),
    showDesktopPet: () => calls.push("show-pet"),
    hideDesktopPet: () => calls.push("hide-pet"),
    quitWithoutConfirmation: () => calls.push("quit")
  });

  const tray = controller.create();
  assert.equal(trayInstances.length, 1);
  assert.equal(tray.tooltip, "ZenMind");
  assert.equal(tray.contextMenu.template.at(-1).label, "tray.quit");

  tray.emit("click");
  tray.contextMenu.template.at(-1).click();

  assert.deepEqual(calls, ["show", "quit"]);
  controller.destroy();
  assert.equal(tray.destroyed, true);
});
