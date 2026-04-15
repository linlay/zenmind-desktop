import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInvalidElectronInstallationMessage,
  validateElectronBinaryPath
} from "../scripts/lib/electron-installation.mjs";

test("darwin accepts Electron.app executable paths", () => {
  const result = validateElectronBinaryPath(
    "darwin",
    "/tmp/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  );

  assert.equal(result.ok, true);
});

test("darwin rejects linux electron dist binary paths", () => {
  const result = validateElectronBinaryPath(
    "darwin",
    "/tmp/project/node_modules/electron/dist/electron"
  );

  assert.equal(result.ok, false);
});

test("darwin rejects windows electron executable paths", () => {
  const result = validateElectronBinaryPath(
    "darwin",
    "C:\\project\\node_modules\\electron\\dist\\electron.exe"
  );

  assert.equal(result.ok, false);
});

test("linux accepts dist/electron paths", () => {
  const result = validateElectronBinaryPath(
    "linux",
    "/tmp/project/node_modules/electron/dist/electron"
  );

  assert.equal(result.ok, true);
});

test("linux rejects Electron.app executable paths", () => {
  const result = validateElectronBinaryPath(
    "linux",
    "/tmp/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  );

  assert.equal(result.ok, false);
});

test("win32 accepts electron.exe paths", () => {
  const result = validateElectronBinaryPath(
    "win32",
    "C:\\project\\node_modules\\electron\\dist\\electron.exe"
  );

  assert.equal(result.ok, true);
});

test("invalid installation message includes reinstall guidance", () => {
  const message = buildInvalidElectronInstallationMessage({
    platform: "darwin",
    arch: "arm64",
    electronBinaryPath: "/tmp/project/node_modules/electron/dist/electron"
  });

  assert.match(message, /System: darwin arm64/);
  assert.match(message, /Resolved Electron binary: \/tmp\/project\/node_modules\/electron\/dist\/electron/);
  assert.match(message, /different operating system/);
  assert.match(message, /Delete node_modules/);
  assert.match(message, /Run npm install on this machine/);
});
