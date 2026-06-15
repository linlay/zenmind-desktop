import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isDesktopPetAssetPathInsideRoot,
  resolveDesktopPetAssetRequest
} = require("../dist-electron/main/copilot/pet-copilot/pet-asset-protocol.js");
const { getDesktopPetsDataRoot } = require("../dist-electron/main/user-paths.js");
const { DESKTOP_PET_USER_ASSET_PROTOCOL } = require("../dist-electron/shared/desktop-pet.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "userData") return path.join(root, "user-data");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

test("desktop pet asset protocol resolves only image files inside the pet root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pet-protocol-"));
  try {
    const app = createApp(root);
    const petRoot = path.join(getDesktopPetsDataRoot(app), "pony");
    fs.mkdirSync(petRoot, { recursive: true });
    const idlePath = path.join(petRoot, "pet-idle.png");
    fs.writeFileSync(idlePath, "fake png", "utf8");
    fs.writeFileSync(path.join(petRoot, "pet.json"), "{}", "utf8");

    assert.equal(
      resolveDesktopPetAssetRequest(app, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/pet-idle.png`),
      fs.realpathSync.native(idlePath)
    );
    assert.equal(resolveDesktopPetAssetRequest(app, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/pet.json`), "");
    assert.equal(resolveDesktopPetAssetRequest(app, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/../secret.png`), "");
    assert.equal(resolveDesktopPetAssetRequest(app, `file://${idlePath}`), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop pet asset path containment handles Windows and macOS path rules", () => {
  assert.equal(
    isDesktopPetAssetPathInsideRoot(
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\pets\\pony",
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\pets\\pony\\pet-idle.png",
      "win32"
    ),
    true
  );
  assert.equal(
    isDesktopPetAssetPathInsideRoot(
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\pets\\pony",
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\pets\\other\\pet-idle.png",
      "win32"
    ),
    false
  );
  assert.equal(
    isDesktopPetAssetPathInsideRoot(
      "/Users/lin/.zenmind/.desktop/data/pets/pony",
      "/Users/lin/.zenmind/.desktop/data/pets/pony/pet-idle.png",
      "darwin"
    ),
    true
  );
  assert.equal(
    isDesktopPetAssetPathInsideRoot(
      "/Users/lin/.zenmind/.desktop/data/pets/pony",
      "/Users/lin/.zenmind/.desktop/data/pets/other/pet-idle.png",
      "darwin"
    ),
    false
  );
});
