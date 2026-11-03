import test from "node:test";
import assert from "node:assert/strict";
import { refreshWindowsDocumentRegistration } from "../dist-electron/main/infrastructure/electron/windows-document-registration.js";

const request = {
  platform: "win32", isPackaged: true, appId: "cc.cutej.desktop", productName: "CuteJ",
  executablePath: "C:\\Program Files\\CuteJ\\CuteJ.exe"
};
const zenmind = {
  ...request, appId: "cc.zenmind.desktop", productName: "ZenMind",
  executablePath: "C:\\Program Files\\ZenMind\\ZenMind.exe"
};
const documentTypes = [
  { id: "Markdown", name: "Markdown Document", extensions: ["md", "markdown"] },
  { id: "HTML", name: "HTML Document", extensions: ["html", "htm"] }
];

// Registry keys and value names are case-insensitive; string data is preserved.
function valueKey(key, name) {
  return `${key.toLowerCase()}\0${name.toLowerCase()}`;
}

function registryValues(entries) {
  return new Map(entries.map(([key, name, value]) => [valueKey(key, name), value]));
}

function expectedEntries(options, typeIds = ["Markdown", "HTML"]) {
  return documentTypes.filter(type => typeIds.includes(type.id)).flatMap(type => {
    const progId = `${options.appId}.${type.id}`;
    const key = `Software\\Classes\\${progId}`;
    return [
      [key, "", `${options.productName} ${type.name}`],
      [`${key}\\Application`, "ApplicationName", options.productName],
      [`${key}\\DefaultIcon`, "", `"${options.executablePath}",0`],
      [`${key}\\shell\\open\\command`, "", `"${options.executablePath}" "%1"`],
      ...type.extensions.map(extension => [`Software\\Classes\\.${extension}\\OpenWithProgids`, progId, ""])
    ];
  });
}

function fixture(entries = [], { fail = () => {} } = {}) {
  const values = registryValues(entries);
  const calls = { opens: 0, reads: [], writes: [], notifications: 0, disposals: 0 };
  return {
    values, calls,
    openRegistry() {
      calls.opens++;
      let disposed = false;
      return {
        readString(key, name) {
          assert.equal(disposed, false, "a closed registry must not be reused");
          calls.reads.push([key, name]);
          fail("read", key, name);
          return values.get(valueKey(key, name));
        },
        writeString(key, name, value) {
          assert.equal(disposed, false, "a closed registry must not be reused");
          calls.writes.push([key, name, value]);
          fail("write", key, name);
          values.set(valueKey(key, name), value);
        },
        notifyAssociationsChanged() {
          assert.equal(disposed, false, "notification must happen before disposal");
          calls.notifications++;
          fail("notify");
        },
        dispose() {
          assert.equal(disposed, false, "each registry handle is disposed once");
          disposed = true;
          calls.disposals++;
        }
      };
    }
  };
}

for (const brand of [request, zenmind]) {
  test(`${brand.productName} preinstalled for an administrator is registered separately for the signed-in cloud user`, async () => {
    const administrator = fixture();
    await refreshWindowsDocumentRegistration(brand, administrator.openRegistry);
    const administratorValues = new Map(administrator.values);
    const user = fixture();

    const result = await refreshWindowsDocumentRegistration(brand, user.openRegistry);

    assert.deepEqual(result, { status: "registered", registeredTypes: ["Markdown", "HTML"], preservedTypes: [] });
    assert.deepEqual(user.values, registryValues(expectedEntries(brand)), "all four extensions have usable branded handlers");
    assert.deepEqual(administrator.values, administratorValues, "registration in another user hive stays intact");
    assert.equal(administrator.calls.opens, 1, "the interactive launch never reopens the administrator's hive");
    assert.equal(user.calls.opens, 1);
    assert.equal(user.calls.notifications, 1);
    assert.equal(user.calls.disposals, 1);
  });
}

test("a complete registration is idempotent, including empty OpenWithProgids values", async () => {
  const user = fixture();
  await refreshWindowsDocumentRegistration(request, user.openRegistry);
  const snapshot = new Map(user.values);
  const writes = user.calls.writes.length;

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "unchanged", registeredTypes: [], preservedTypes: [] });
  assert.deepEqual(user.values, snapshot);
  assert.equal(user.calls.writes.length, writes);
  assert.equal(user.calls.notifications, 1, "an unchanged launch does not refresh Explorer again");
  assert.equal(user.calls.opens, 2);
  assert.equal(user.calls.disposals, 2);
});

test("a cloud profile reset is repaired on the next launch without retaining a stale registration cache", async () => {
  const user = fixture();
  await refreshWindowsDocumentRegistration(request, user.openRegistry);
  user.values.clear();

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "registered", registeredTypes: ["Markdown", "HTML"], preservedTypes: [] });
  assert.deepEqual(user.values, registryValues(expectedEntries(request)));
  assert.equal(user.calls.notifications, 2);
  assert.equal(user.calls.disposals, 2);
});

test("an existing handler for this executable gains only its missing icon and extension candidate", async () => {
  const entries = expectedEntries(request);
  const missing = entries.filter(([key]) => key === `Software\\Classes\\${request.appId}.Markdown\\DefaultIcon`
    || key === "Software\\Classes\\.markdown\\OpenWithProgids");
  const missingKeys = new Set(missing.map(([key, name]) => valueKey(key, name)));
  const user = fixture(entries.filter(([key, name]) => !missingKeys.has(valueKey(key, name))));

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "registered", registeredTypes: ["Markdown"], preservedTypes: [] });
  assert.deepEqual(registryValues(user.calls.writes), registryValues(missing));
  assert.deepEqual(user.values, registryValues(entries));
  assert.equal(user.calls.notifications, 1);
  assert.equal(user.calls.disposals, 1);
});

test("Windows command paths differing only in letter case already identify the same installation", async () => {
  const entries = expectedEntries(request).map(([key, name, value]) => [key, name,
    key.endsWith("\\shell\\open\\command") ? value.toLowerCase() : value]);
  const user = fixture(entries);

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "unchanged", registeredTypes: [], preservedTypes: [] });
  assert.deepEqual(user.values, registryValues(entries));
  assert.deepEqual(user.calls.writes, []);
  assert.equal(user.calls.notifications, 0);
  assert.equal(user.calls.disposals, 1);
});

test("registration preserves defaults, UserChoice, unrelated candidates and the other brand", async () => {
  const protectedEntries = [
    ["Software\\Classes\\.md", "", "ExistingEditor.Markdown"],
    ["Software\\Classes\\.html", "", "ExistingBrowser.HTML"],
    ["Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice", "ProgId", "ExistingEditor.Markdown"],
    ["Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice", "Hash", "existing-choice-hash"],
    ["Software\\Classes\\.md\\OpenWithProgids", "ExistingEditor.Markdown", ""],
    ["Software\\Classes\\.txt", "", "txtfile"],
    ...expectedEntries(zenmind)
  ];
  const user = fixture(protectedEntries);

  await refreshWindowsDocumentRegistration(request, user.openRegistry);
  const otherBrandResult = await refreshWindowsDocumentRegistration(zenmind, user.openRegistry);

  assert.deepEqual(user.values, registryValues([...protectedEntries, ...expectedEntries(request)]));
  assert.deepEqual(registryValues(user.calls.writes), registryValues(expectedEntries(request)));
  assert.deepEqual(otherBrandResult, { status: "unchanged", registeredTypes: [], preservedTypes: [] });
  assert.equal(user.calls.notifications, 1);
  assert.equal(user.calls.disposals, 2);
});

test("a conflicting Markdown installation is preserved as a whole while missing HTML handlers are added", async () => {
  const selectedInstallation = { ...request, executablePath: "D:\\User Selected\\CuteJ.exe" };
  const existingMarkdown = expectedEntries(selectedInstallation, ["Markdown"])
    .filter(([key]) => key !== "Software\\Classes\\.markdown\\OpenWithProgids");
  const user = fixture(existingMarkdown);

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "registered", registeredTypes: ["HTML"], preservedTypes: ["Markdown"] });
  assert.deepEqual(user.values, registryValues([...existingMarkdown, ...expectedEntries(request, ["HTML"])]));
  assert.deepEqual(registryValues(user.calls.writes), registryValues(expectedEntries(request, ["HTML"])));
  assert.equal(user.calls.notifications, 1);
  assert.equal(user.calls.disposals, 1);
});

test("an installation already owning both document types is left unchanged", async () => {
  const existing = expectedEntries({ ...request, executablePath: "D:\\Another Install\\CuteJ.exe" });
  const user = fixture(existing);

  const result = await refreshWindowsDocumentRegistration(request, user.openRegistry);

  assert.deepEqual(result, { status: "unchanged", registeredTypes: [], preservedTypes: ["Markdown", "HTML"] });
  assert.deepEqual(user.values, registryValues(existing));
  assert.deepEqual(user.calls.writes, []);
  assert.equal(user.calls.notifications, 0);
  assert.equal(user.calls.disposals, 1);
});

test("Chinese, spaces, apostrophes and dollar signs remain literal in executable commands and icons", async () => {
  const options = { ...request, executablePath: "C:\\企业 应用\\O'Brien $desk\\CuteJ.exe" };
  const user = fixture();

  await refreshWindowsDocumentRegistration(options, user.openRegistry);

  assert.deepEqual(user.values, registryValues(expectedEntries(options)));
  assert.equal(user.values.get(valueKey(`Software\\Classes\\${request.appId}.Markdown\\shell\\open\\command`, "")),
    '"C:\\企业 应用\\O\'Brien $desk\\CuteJ.exe" "%1"');
  assert.equal(user.calls.disposals, 1);
});

test("macOS, Linux, unpackaged apps and development identities never open the Windows registry", async () => {
  const forbidden = () => assert.fail("the Windows adapter must remain unopened");
  for (const overrides of [
    { platform: "darwin" }, { platform: "linux" }, { isPackaged: false },
    { appId: "cc.cutej.desktop.dev" }, { appId: "cc.zenmind.desktop.dev" }
  ]) {
    assert.deepEqual(await refreshWindowsDocumentRegistration({ ...request, ...overrides }, forbidden),
      { status: "skipped", registeredTypes: [], preservedTypes: [] });
  }
});

test("registry read or write permission failures propagate without notification and dispose the handle", async () => {
  for (const operation of ["read", "write"]) {
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    let attempts = 0;
    const user = fixture([], { fail(current) {
      if (current === operation && ++attempts === 3) throw denied;
    } });

    await assert.rejects(refreshWindowsDocumentRegistration(request, user.openRegistry), error => error === denied);

    assert.equal(user.calls.notifications, 0, `${operation} failure must not announce a completed registration`);
    assert.equal(user.calls.disposals, 1);
    await refreshWindowsDocumentRegistration(request, user.openRegistry);
    assert.deepEqual(user.values, registryValues(expectedEntries(request)), "a later launch can complete any partial writes");
    assert.equal(user.calls.notifications, 1);
    assert.equal(user.calls.disposals, 2);
  }
});

test("notification failures still release the registry and remain observable to the caller", async () => {
  const failed = new Error("shell notification failed");
  const user = fixture([], { fail(operation) { if (operation === "notify") throw failed; } });

  await assert.rejects(refreshWindowsDocumentRegistration(request, user.openRegistry), error => error === failed);

  assert.equal(user.calls.notifications, 1);
  assert.equal(user.calls.disposals, 1);
});

test("failure to open the current user registry propagates without pretending registration succeeded", async () => {
  const denied = Object.assign(new Error("cannot open current user registry"), { code: "EACCES" });
  await assert.rejects(refreshWindowsDocumentRegistration(request, () => { throw denied; }), error => error === denied);
});
