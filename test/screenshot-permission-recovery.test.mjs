import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main/modules/assistant/copilot/screenshot-permission-recovery.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const bundleId = "cc.cutej.desktop";
const executable = "/Applications/CuteJ.app/Contents/MacOS/CuteJ";
const request = { platform: "darwin", userSelectedRegion: true, getMainWindow: () => null };

function setup({ status = "denied", response = 0, actualBundleId = bundleId, executablePath = executable,
  resetError, nativeError, nativeGranted = false, grantAfterRequest = false, statusAfterChoice,
  deferredChoice = false } = {}) {
  const calls = [];
  const diagnostics = [];
  const dialogs = [];
  let resolveChoice;
  const showMessageBox = async (options, owner) => {
    calls.push("dialog");
    dialogs.push({ options, owner });
    const result = deferredChoice ? await new Promise(resolve => { resolveChoice = resolve; }) : { response };
    if (statusAfterChoice) status = statusAfterChoice;
    return result;
  };
  const dependencies = {
    getStatus: () => status,
    getExecutablePath: () => executablePath,
    readBundleId: async (plistPath) => { calls.push(["read", plistPath]); return actualBundleId; },
    resetScreenCapture: async (targetBundleId) => {
      calls.push(["reset", targetBundleId]);
      if (resetError) throw resetError;
    },
    requestScreenCapture: () => {
      calls.push("native request");
      if (nativeError) throw nativeError;
      if (grantAfterRequest) status = "granted";
      return nativeGranted;
    },
    openSettings: async () => { calls.push("settings"); },
    showMessageBox
  };
  const execFile = () => assert.fail("use the captured native command adapter");
  execFile[promisify.custom] = async (program, args) => {
    calls.push(["command", program, args]);
    if (program === "/usr/bin/plutil") return { stdout: `${actualBundleId}\n`, stderr: "" };
    if (program === "/usr/bin/tccutil") {
      if (resetError) throw resetError;
      return { stdout: "reset", stderr: "" };
    }
    assert.fail(`Unexpected native program: ${program}`);
  };
  const electron = {
    app: { getPath: (name) => { assert.equal(name, "exe"); return executablePath; } },
    systemPreferences: { getMediaAccessStatus: () => status },
    dialog: { showMessageBox: (ownerOrOptions, options) => showMessageBox(options ?? ownerOrOptions, options ? ownerOrOptions : null) },
    shell: { openExternal: async (url) => { calls.push(["settings", url]); } }
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", "console", compiled)(module, module.exports, (id) => {
    if (id === "node:child_process") return { execFile };
    if (id === "node:path") return path;
    if (id === "node:util") return { promisify };
    if (id === "electron") return electron;
    if (id.endsWith("/brand")) return { APP_ID: bundleId, PRODUCT_NAME: "Test" };
    if (id.endsWith("/main-i18n")) return { t: (key) => key };
    if (id === "koffi") return { load: (library) => {
      calls.push(["native library", library]);
      return { func: (signature) => {
        assert.equal(signature, "bool CGRequestScreenCaptureAccess(void)");
        return dependencies.requestScreenCapture;
      } };
    } };
    assert.fail(`Unexpected import: ${id}`);
  }, { warn: (...args) => diagnostics.push(args) });
  return {
    ...module.exports, calls, diagnostics, dialogs,
    recover: module.exports.createScreenshotPermissionRecovery(dependencies),
    finishChoice: (selected) => resolveChoice({ response: selected })
  };
}

for (const status of ["granted", "restricted", "not-determined", "unknown"]) {
  test(`macOS ${status} access does not reset or prompt for historical permission recovery`, async () => {
    const h = setup({ status });
    assert.equal(await h.recover(request), null);
    assert.deepEqual(h.calls, []);
  });
}

test("Windows and requests without a completed user selection cannot open permission UI", async () => {
  const h = setup();
  assert.equal(await h.recover({ ...request, platform: "win32" }), null);
  assert.equal(await h.recover({ ...request, userSelectedRegion: false }), null);
  assert.deepEqual(h.calls, []);
});

for (const actualBundleId of [bundleId, `${bundleId}.dev`]) {
  test(`confirmed recovery resets only the executable's ${actualBundleId} ScreenCapture decision`, async () => {
    const h = setup({ actualBundleId });
    assert.deepEqual(await h.recover(request), { granted: false, message: "screenshot.recoveryPendingMac" });
    assert.deepEqual(h.calls, [
      ["read", "/Applications/CuteJ.app/Contents/Info.plist"], "dialog",
      ["reset", actualBundleId], "native request", "settings"
    ]);
    assert.deepEqual(h.dialogs[0].options.buttons, ["screenshot.reauthorizeMac", "common.cancel"]);
    assert.equal(h.dialogs[0].options.defaultId, 1);
    assert.equal(h.dialogs[0].options.cancelId, 1);
  });
}

test("canceling the recovery dialog leaves every permission and setting unchanged", async () => {
  const h = setup({ response: 1 });
  assert.deepEqual(await h.recover(request), { granted: false });
  assert.deepEqual(h.calls, [["read", "/Applications/CuteJ.app/Contents/Info.plist"], "dialog"]);
});

for (const actualBundleId of ["cc.zenmind.desktop", "com.apple.Terminal", "cc.cutej.desktop.helper", `${bundleId}; reset All`]) {
  test(`permission recovery refuses an executable with unrelated bundle ID ${actualBundleId}`, async () => {
    const h = setup({ actualBundleId });
    assert.equal((await h.recover(request)).message, "screenshot.recoveryFailedMac");
    assert.deepEqual(h.calls, [["read", "/Applications/CuteJ.app/Contents/Info.plist"]]);
  });
}

test("an executable outside a macOS app bundle cannot select a reset target", async () => {
  const h = setup({ executablePath: "/usr/local/bin/node" });
  assert.equal((await h.recover(request)).message, "screenshot.recoveryFailedMac");
  assert.deepEqual(h.calls, []);
});

for (const statusAfterChoice of ["granted", "restricted"]) {
  test(`a ${statusAfterChoice} permission change during confirmation prevents reset`, async () => {
    const h = setup({ statusAfterChoice });
    assert.deepEqual(await h.recover(request), { granted: statusAfterChoice === "granted" });
    assert.deepEqual(h.calls, [["read", "/Applications/CuteJ.app/Contents/Info.plist"], "dialog"]);
  });
}

test("a native request return value cannot substitute for the system's actual grant", async () => {
  const h = setup({ nativeGranted: true });
  assert.deepEqual(await h.recover(request), { granted: false, message: "screenshot.recoveryPendingMac" });
  const granted = setup({ grantAfterRequest: true });
  assert.deepEqual(await granted.recover(request), { granted: true });
});

test("reset failure does not request access or pretend the screenshot can proceed", async () => {
  const h = setup({ resetError: new Error("reset rejected") });
  assert.equal((await h.recover(request)).message, "screenshot.recoveryFailedMac");
  assert.equal(h.calls.includes("native request"), false);
  assert.equal(h.calls.includes("settings"), false);
});

test("native API failure still opens system settings after a confirmed targeted reset", async () => {
  const h = setup({ nativeError: new Error("native API unavailable") });
  assert.equal((await h.recover(request)).message, "screenshot.recoveryFailedMac");
  assert.deepEqual(h.calls.slice(-3), [["reset", bundleId], "native request", "settings"]);
});

test("concurrent screenshot failures share one native recovery dialog and one targeted reset", async () => {
  const h = setup({ deferredChoice: true });
  const first = h.recover(request);
  const second = h.recover(request);
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.equal(h.dialogs.length, 1);
  h.finishChoice(0);
  await Promise.all([first, second]);
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === "reset").length, 1);
});

test("the native adapter uses exact plutil/tccutil arguments and loads CoreGraphics only after confirmation", async () => {
  const h = setup({ actualBundleId: `${bundleId}.dev` });
  assert.deepEqual(h.calls, [], "module initialization must not load native libraries or request permissions");
  await h.recoverScreenshotPermission(request);
  assert.deepEqual(h.calls[0], ["command", "/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", "/Applications/CuteJ.app/Contents/Info.plist"
  ]]);
  assert.deepEqual(h.calls[2], ["command", "/usr/bin/tccutil", ["reset", "ScreenCapture", `${bundleId}.dev`]]);
  assert.deepEqual(h.calls[3], ["native library", "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"]);
  assert.deepEqual(h.calls.at(-1), ["settings", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
});
