import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const compiledModule = new URL("../dist-electron/main/infrastructure/electron/windows-document-registration.js", import.meta.url);
const moduleRequire = createRequire(compiledModule);
const source = fs.readFileSync(compiledModule, "utf8");
const request = {
  platform: "win32", isPackaged: true, appId: "cc.cutej.desktop", productName: "CuteJ",
  executablePath: "C:\\企业 应用\\O'Brien $desk\\CuteJ.exe"
};

function nativeFixture({ readStatus, writeStatus = 0, openStatus = 0 } = {}) {
  const currentUser = { user: "interactive-cloud-user" };
  const values = new Map(), created = [], closed = [], notifications = [];
  const slot = (key, name) => `${key}\0${name}`;
  const functions = {
    RegOpenCurrentUser(access, result) {
      assert.equal(access, 0x20019);
      if (!openStatus) result[0] = currentUser;
      return openStatus;
    },
    RegGetValueW(root, key, name, flags, type, data, size) {
      assert.equal(root, currentUser);
      assert.equal(flags, 0x3, "accept only REG_NONE / REG_SZ");
      if (readStatus) return readStatus;
      const value = values.get(slot(key, name));
      if (!value) return 2;
      const bytes = value.type === 0 ? Buffer.alloc(0) : Buffer.from(`${value.text}\0`, "utf16le");
      assert.ok(bytes.length <= size[0]);
      assert.ok(size[0] <= 65_536, "registry reads remain bounded");
      type[0] = value.type;
      size[0] = bytes.length;
      bytes.copy(data);
      return 0;
    },
    RegCreateKeyExW(root, key, reserved, className, options, access, security, result, disposition) {
      assert.equal(root, currentUser);
      assert.equal(access, 0x2, "request only KEY_SET_VALUE for writes");
      assert.deepEqual([reserved, className, options, security, disposition], [0, null, 0, null, null]);
      result[0] = { key };
      created.push(result[0]);
      return 0;
    },
    RegSetValueExW(handle, name, reserved, type, data, size) {
      assert.equal(reserved, 0);
      assert.equal(type, 1);
      assert.equal(size, data.length, "Win32 lengths count UTF-16 bytes, including the terminator");
      assert.equal(data.readUInt16LE(size - 2), 0);
      if (writeStatus) return writeStatus;
      values.set(slot(handle.key, name), { type, text: data.toString("utf16le", 0, size - 2) });
      return 0;
    },
    RegCloseKey(handle) { closed.push(handle); return 0; },
    SHChangeNotify(...args) { notifications.push(args); }
  };
  const koffi = {
    load(library) {
      assert.ok(["advapi32.dll", "shell32.dll"].includes(library));
      return { func(signature) {
        const name = signature.match(/\b(\w+)\(/u)[1];
        assert.match(signature, /__stdcall/u);
        assert.ok(functions[name], `unexpected native operation: ${name}`);
        return functions[name];
      } };
    }
  };
  const context = { exports: {}, Buffer, require: name => name === "koffi" ? koffi : moduleRequire(name) };
  vm.runInNewContext(source, context, { filename: compiledModule.pathname });
  return { run: () => context.exports.refreshWindowsDocumentRegistration(request), values, slot, currentUser, created, closed, notifications };
}

test("native Windows registration uses the current user's handle and writes literal UTF-16 paths", async () => {
  const fixture = nativeFixture();
  assert.equal((await fixture.run()).status, "registered");
  assert.equal(fixture.values.get(fixture.slot("Software\\Classes\\cc.cutej.desktop.Markdown\\shell\\open\\command", "")).text,
    `"${request.executablePath}" "%1"`);
  assert.deepEqual(fixture.notifications, [[0x08000000, 0, null, null]]);
  assert.equal(fixture.created.length, 12);
  assert.deepEqual(fixture.closed, [...fixture.created, fixture.currentUser]);
  assert.equal((await fixture.run()).status, "unchanged");
  assert.equal(fixture.created.length, 12);
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.closed.at(-1), fixture.currentUser);
});

test("native REG_NONE candidate values are accepted without rewriting the registry", async () => {
  const fixture = nativeFixture();
  await fixture.run();
  for (const [key, value] of fixture.values) {
    if (key.includes("\\OpenWithProgids\0")) fixture.values.set(key, { ...value, type: 0 });
  }
  assert.equal((await fixture.run()).status, "unchanged");
  assert.equal(fixture.created.length, 12);
  assert.equal(fixture.notifications.length, 1);
});

test("native registry errors never become missing values and all opened handles are released", async () => {
  for (const readStatus of [5, 234, 1630]) {
    const fixture = nativeFixture({ readStatus });
    await assert.rejects(fixture.run(), new RegExp(`read value failed \\(${readStatus}\\)`, "u"));
    assert.equal(fixture.created.length, 0);
    assert.deepEqual(fixture.closed, [fixture.currentUser]);
    assert.deepEqual(fixture.notifications, []);
  }
  const writeFailure = nativeFixture({ writeStatus: 5 });
  await assert.rejects(writeFailure.run(), /write value failed \(5\)/u);
  assert.deepEqual(writeFailure.closed, [...writeFailure.created, writeFailure.currentUser]);
  assert.deepEqual(writeFailure.notifications, []);
  const openFailure = nativeFixture({ openStatus: 5 });
  await assert.rejects(openFailure.run(), /open current user failed \(5\)/u);
  assert.deepEqual(openFailure.closed, []);
});
