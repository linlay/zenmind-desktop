import test from "node:test";
import assert from "node:assert/strict";
import { refreshMacSystemIntegration } from "../dist-electron/main/infrastructure/electron/mac-system-integration.js";
import { isMacApplicationCompatible } from "../dist-electron/main/infrastructure/electron/mac-application-registry.js";

const id = "cc.cutej.desktop";
const selectedPath = "/Applications/CuteJ.app";
const request = {
  platform: "darwin", isPackaged: true, bundleId: id,
  executablePath: `${selectedPath}/Contents/MacOS/CuteJ`, homePath: "/Users/test"
};

function application(path, version, extras = {}) {
  return { path, bundleId: id, version, runnable: true, shareExtensionPath: `${path}/Contents/PlugIns/DesktopShare.appex`, ...extras };
}

function fixture(applications, { rejected = [], errors = new Map(), fail = () => false } = {}) {
  const calls = [];
  const byPath = new Map(applications.map(app => [app.path, app]));
  const record = async (operation, path) => {
    calls.push([operation, path]);
    if (fail(operation, path)) throw new Error("fixture registration error");
  };
  return { calls, registry: {
    listApplicationPaths(bundleId) { assert.equal(bundleId, id); return [...byPath.keys(), ...errors.keys()]; },
    async inspectApplication(path) { if (errors.has(path)) throw errors.get(path); assert.ok(byPath.has(path), path); return byPath.get(path); },
    async signingRequirement(path) { assert.ok(byPath.has(path)); return "fixture publisher and bundle identity"; },
    async matchesSigningRequirement(path, requirement) { assert.equal(requirement, "fixture publisher and bundle identity"); return !rejected.includes(path); },
    registerApplication: path => record("register", path),
    unregisterApplication: path => record("unregister", path),
    registerShareExtension: path => record("register-share", path),
    unregisterShareExtension: path => record("unregister-share", path)
  } };
}

test("an overwrite and subsequent releases derive the single selected version from bundle metadata", async () => {
  for (const version of ["0.5.5", "0.5.10", "0.10.0", "2.0.0"]) {
    const old = application("/Users/test/Downloads/CuteJ.app", "0.4.52");
    const current = application(selectedPath, version);
    const { calls, registry } = fixture([current, old]);
    const result = await refreshMacSystemIntegration(request, registry);
    assert.equal(result.selectedVersion, version);
    assert.equal(result.selectedPath, selectedPath);
    assert.equal(result.shareRegistered, true);
    assert.deepEqual(result.unregisteredPaths, [old.path]);
    assert.equal(calls[0][0], "register", "a known-good handler is registered before any cleanup");
    assert.deepEqual(calls.at(-1), ["register-share", current.shareExtensionPath]);
    assert.ok(!calls.some(([op, path]) => op === "unregister" && path === current.path));
  }
});

test("launching an older copy keeps the numerically newest signed release registered", async () => {
  const older = application(selectedPath, "0.5.9");
  const newer = application("/Users/test/Applications/CuteJ.app", "0.5.10");
  const { calls, registry } = fixture([older, newer]);
  const result = await refreshMacSystemIntegration(request, registry);
  assert.equal(result.selectedPath, newer.path);
  assert.equal(result.selectedVersion, "0.5.10");
  assert.deepEqual(result.unregisteredPaths, [older.path]);
  assert.ok(calls.filter(([op]) => op === "register").every(([, path]) => path === newer.path));
});

test("a newer bundle requiring another OS or architecture never replaces the working installed release", async () => {
  const current = application(selectedPath, "0.5.5");
  const incompatible = application("/Users/test/Newer/CuteJ.app", "0.6.0", { runnable: false });
  const { registry } = fixture([current, incompatible]);
  const result = await refreshMacSystemIntegration(request, registry);
  assert.equal(result.selectedPath, current.path);
  assert.deepEqual(result.unregisteredPaths, [incompatible.path]);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersion: "15.0" }, ["arm64"], "14.7.1", ["arm64"]), false);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersion: "12.0" }, ["arm64"], "14.7.1", ["x64"]), false);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersion: "12.0" }, ["x64", "arm64"], "14.7.1", ["arm64"]), true);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersion: "14.7.1" }, ["arm64"], "14.7.1", ["arm64"]), true);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersionByArchitecture: { arm64: "15.0", x86_64: "12.0" } }, ["x64", "arm64"], "14.7.1", ["arm64"]), false);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersionByArchitecture: { arm64: "15.0", x86_64: "12.0" } }, ["x64", "arm64"], "14.7.1", ["x64", "arm64"]), true);
  assert.equal(isMacApplicationCompatible({ LSMinimumSystemVersion: "unknown" }, ["arm64"], "14.7.1", ["arm64"]), false);
});

test("same-version copies converge to Applications while a mounted installer never wins", async () => {
  const current = application(selectedPath, "0.5.5");
  const duplicate = application("/Users/test/Downloads/CuteJ copy.app", "0.5.5");
  const installer = application("/Volumes/CuteJ/CuteJ.app", "9.0.0");
  const trash = application("/Users/test/.Trash/CuteJ.app", "10.0.0");
  const { registry } = fixture([current, duplicate, installer, trash]);
  const result = await refreshMacSystemIntegration(request, registry);
  assert.equal(result.selectedPath, current.path);
  assert.deepEqual(result.unregisteredPaths, [duplicate.path, installer.path, trash.path]);
});

test("another brand, developer identity, publisher, invalid version, or inaccessible bundle is preserved", async () => {
  const current = application(selectedPath, "0.5.5");
  const other = application("/Applications/ZenMind.app", "0.1.0", { bundleId: "cc.zenmind.desktop" });
  const developer = application("/Users/test/Developer/CuteJ.app", "0.1.0", { bundleId: `${id}.dev` });
  const publisher = application("/Users/test/Other Publisher/CuteJ.app", "0.1.0");
  const malformed = application("/Users/test/Malformed/CuteJ.app", "unknown");
  const pre = application("/Users/test/Preview/CuteJ.app", "0.6.0-beta.1");
  const denied = "/Users/test/Protected/CuteJ.app";
  const broken = "/Users/test/Broken/CuteJ.app";
  const { registry } = fixture([current, other, developer, publisher, malformed, pre], {
    rejected: [publisher.path], errors: new Map([
      [denied, Object.assign(new Error("permission denied"), { code: "EACCES", path: denied })],
      [broken, Object.assign(new Error("executable missing"), { code: "ENOENT", path: `${broken}/Contents/MacOS/CuteJ` })]
    ])
  });
  const result = await refreshMacSystemIntegration(request, registry);
  assert.deepEqual(result.unregisteredPaths, []);
  assert.deepEqual(result.failures.map(f => f.path), [denied, broken]);
});

test("a vanished registration is removed while an overwrite at the same path is force refreshed", async () => {
  const current = application(selectedPath, "0.5.5");
  const missing = "/Users/test/Old/CuteJ.app";
  const { calls, registry } = fixture([current], { errors: new Map([
    [missing, Object.assign(new Error("bundle missing"), { code: "ENOENT", path: missing })]
  ]) });
  const result = await refreshMacSystemIntegration(request, registry);
  assert.deepEqual(result.unregisteredPaths, [missing]);
  assert.deepEqual(calls.filter(([op]) => op === "register").map(([, path]) => path), [selectedPath, selectedPath]);
});

test("failed selected-app registration leaves all existing handlers and extensions intact", async () => {
  const { calls, registry } = fixture([
    application(selectedPath, "0.5.5"), application("/Users/test/Old/CuteJ.app", "0.4.52")
  ], { fail: operation => operation === "register" });
  await assert.rejects(refreshMacSystemIntegration(request, registry), /fixture registration error/u);
  assert.deepEqual(calls, [["register", selectedPath]]);
});

test("individual cleanup failures are reported without discarding the selected handlers", async () => {
  const old = application("/Users/test/Old/CuteJ.app", "0.4.52");
  const { calls, registry } = fixture([application(selectedPath, "0.5.5"), old], {
    fail: operation => ["unregister", "unregister-share"].includes(operation)
  });
  const result = await refreshMacSystemIntegration(request, registry);
  assert.equal(result.selectedPath, selectedPath);
  assert.equal(result.shareRegistered, true);
  assert.deepEqual(result.failures.map(f => f.operation), ["unregister-share", "unregister"]);
  assert.deepEqual(calls.at(-2), ["register", selectedPath]);
});

test("a missing or failed newest sharing extension preserves all previous working entries", async () => {
  const old = application(selectedPath, "0.5.5");
  const nextPath = "/Users/test/Applications/CuteJ.app";
  for (const missing of [true, false]) {
    const next = application(nextPath, "0.5.6", missing ? { shareExtensionPath: undefined } : {});
    const { calls, registry } = fixture([old, next], { fail: operation => !missing && operation === "register-share" });
    const result = await refreshMacSystemIntegration(request, registry);
    assert.equal(result.selectedPath, nextPath);
    assert.equal(result.shareRegistered, false);
    assert.deepEqual(result.unregisteredPaths, []);
    assert.ok(!calls.some(([op]) => op.startsWith("unregister")));
    assert.deepEqual(result.failures, [{ path: nextPath, operation: missing ? "missing-share-extension" : "register-share" }]);
  }
});

test("an app without its matching sharing extension reports the missing release input", async () => {
  const { registry } = fixture([application(selectedPath, "0.5.5", { shareExtensionPath: undefined })]);
  const result = await refreshMacSystemIntegration(request, registry);
  assert.equal(result.shareRegistered, false);
  assert.deepEqual(result.failures, [{ path: selectedPath, operation: "missing-share-extension" }]);
});

test("Windows, Linux, unpackaged runs, development shells and installer launches never touch macOS registration", async () => {
  const forbidden = new Proxy({}, { get() { assert.fail("macOS registry must remain unloaded"); } });
  for (const overrides of [
    { platform: "win32" }, { platform: "linux" }, { isPackaged: false }, { bundleId: `${id}.dev` },
    { executablePath: "/Volumes/CuteJ/CuteJ.app/Contents/MacOS/CuteJ" },
    { executablePath: "/private/var/folders/test/AppTranslocation/random/d/CuteJ.app/Contents/MacOS/CuteJ" },
    { executablePath: "/Users/test/.Trash/CuteJ.app/Contents/MacOS/CuteJ" }
  ]) assert.equal((await refreshMacSystemIntegration({ ...request, ...overrides }, forbidden)).selectedPath, undefined);
  const { calls, registry } = fixture([application(selectedPath, "0.5.5", { bundleId: `${id}.dev` })]);
  assert.equal((await refreshMacSystemIntegration(request, registry)).selectedPath, undefined);
  assert.deepEqual(calls, []);
});
