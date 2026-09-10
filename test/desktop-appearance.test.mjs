import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: `export * from "./src/renderer/appearance/model";
      export * from "./src/renderer/appearance/controller";
      export * from "./src/renderer/appearance/skins";
      export * from "./src/renderer/appearance/browser";`,
    resolveDir: process.cwd()
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  loader: { ".svg": "dataurl" },
  define: {
    __DESKTOP_APP_BRAND__: JSON.stringify({
      storageNamespace: "appearance-test",
      protocols: { open: { scheme: "appearance-test" } },
      installer: { shutdownArg: "--shutdown" }
    })
  }
});
const {
  createAppearanceController, createAppearanceSnapshot, createDocumentAppearanceTarget,
  bootstrapAppearance, readCachedThemePreference, DEFAULT_DESKTOP_SKIN, DESKTOP_SKINS, findDesktopSkin
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let dark = options.dark ?? false;
  const writes = [], cache = [], applied = [], systemListeners = new Set();
  let releases = 0;
  let skinSettings = { skinId: "default", background: null, backgroundDataUrl: null };
  const skinWrites = [], skinCache = [];
  const controller = createAppearanceController({
    readCachedTheme: () => options.cached ?? "light",
    readCachedSkin: () => options.cachedSkin ?? "default",
    cacheSkin: (id) => skinCache.push(id),
    getDesktopSkin: options.readSkin ?? (async () => ({ ok: true, settings: skinSettings })),
    setDesktopSkin: async (id) => {
      skinWrites.push(id);
      if (options.writeSkin) return options.writeSkin(id);
      skinSettings = { ...skinSettings, skinId: id };
      return { ok: true, settings: skinSettings };
    },
    importDesktopBackground: options.importBackground ?? (async () => ({ ok: true, settings: skinSettings, cancelled: true })),
    resetDesktopBackground: options.resetBackground ?? (async () => ({ ok: true, settings: { ...skinSettings, background: null, backgroundDataUrl: null } })),
    cacheTheme: (theme) => cache.push(theme),
    systemUsesDarkColors: () => dark,
    subscribeSystemTheme: (listener) => {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    },
    getThemePreference: options.read ?? (async () => "light"),
    setNativeThemeSource: async (theme) => {
      writes.push(theme);
      return options.write ? options.write(theme) : { ok: true, themeSource: theme };
    },
    apply: (snapshot) => applied.push(snapshot),
    release: () => { releases++; }
  });
  return {
    controller, writes, cache, applied, systemListeners, skinWrites, skinCache,
    get releases() { return releases; },
    systemThemeChanged(value) {
      dark = value;
      systemListeners.forEach((listener) => listener());
    }
  };
}

test("bootstrap resolves cached system preference before React without applying a shell skin", (t) => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const dataset = {};
  globalThis.document = { documentElement: { dataset } };
  for (const [cached, dark, expected] of [
    ["system", true, "dark"], ["system", false, "light"],
    ["light", true, "light"], ["dark", false, "dark"], ["invalid", true, "light"]
  ]) {
    globalThis.window = {
      localStorage: { getItem: (key) => { assert.equal(key, "appearance-test.theme"); return cached; } },
      matchMedia: () => ({ matches: dark })
    };
    bootstrapAppearance();
    assert.equal(dataset.theme, expected);
    assert.equal(dataset.desktopSkin, undefined);
  }
  Object.defineProperty(globalThis.window, "localStorage", { get() { throw new Error("blocked"); } });
  assert.equal(readCachedThemePreference(), "light");
  assert.doesNotThrow(bootstrapAppearance);
});

test("a canonical preference replaces the cache and synchronizes native chrome once", async (t) => {
  const h = harness({ cached: "light", dark: true, read: async () => "system" });
  t.after(h.controller.start());
  await flush();
  assert.equal(h.controller.getSnapshot().themeMode, "system");
  assert.equal(h.controller.getSnapshot().resolvedTheme, "dark");
  assert.equal(h.controller.getSnapshot().skin, DEFAULT_DESKTOP_SKIN);
  assert.deepEqual(h.cache, ["system"]);
  assert.deepEqual(h.writes, ["system"]);
});

for (const failure of ["reject", "invalid"]) {
  test(`a ${failure} canonical read preserves the cached theme without writing to Main`, async (t) => {
    const h = harness({ cached: "dark", read: async () => {
      if (failure === "reject") throw new Error("bridge unavailable");
      return "unknown-theme";
    } });
    t.after(h.controller.start());
    await flush();
    assert.equal(h.controller.getSnapshot().themeMode, "dark");
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.cache, []);
  });
}

test("a late startup read cannot replace a user's newer theme or write it back", async (t) => {
  const read = deferred();
  const h = harness({ read: () => read.promise });
  t.after(h.controller.start());
  await flush();
  const result = await h.controller.setThemeMode("dark");
  read.resolve("light");
  await flush();
  assert.equal(result.resolvedTheme, "dark");
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  assert.deepEqual(h.writes, ["dark"]);
  assert.deepEqual(h.cache, ["dark"]);
});

test("the newest canonical refresh wins when reads finish out of order", async (t) => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const h = harness({ read: () => ++reads === 1 ? first.promise : second.promise });
  t.after(h.controller.start());
  await flush();
  const refreshed = h.controller.refreshFromCanonical();
  await flush();
  second.resolve("dark");
  await refreshed;
  first.resolve("light");
  await flush();
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  assert.deepEqual(h.writes, ["dark"]);
});

test("rapid saves are serialized and an earlier completion never repaints the latest choice", async (t) => {
  const first = deferred(), second = deferred();
  const h = harness({ dark: true, read: async () => { throw new Error("offline"); },
    write: (theme) => theme === "dark" ? first.promise : second.promise });
  t.after(h.controller.start());
  await flush();
  const a = h.controller.setThemeMode("dark");
  const b = h.controller.setThemeMode("system");
  await flush();
  assert.deepEqual(h.writes, ["dark"]);
  assert.equal(h.controller.getSnapshot().themeMode, "system");
  const appliedCount = h.applied.length;
  first.resolve({ ok: true, themeSource: "dark" });
  await a;
  await flush();
  assert.equal(h.applied.length, appliedCount);
  assert.deepEqual(h.cache, []);
  assert.deepEqual(h.writes, ["dark", "system"]);
  second.resolve({ ok: true, themeSource: "system" });
  await b;
  assert.deepEqual(h.cache, ["system"]);
  assert.equal(h.controller.getSnapshot().resolvedTheme, "dark");
});

test("a failed latest save rolls back to the last successful save and later saves still work", async (t) => {
  const h = harness({ read: async () => { throw new Error("offline"); },
    write: async (theme) => ({ ok: theme !== "system", themeSource: theme }) });
  t.after(h.controller.start());
  await flush();
  const first = h.controller.setThemeMode("dark");
  const failed = h.controller.setThemeMode("system");
  await assert.rejects(failed, /could not be saved/);
  await first;
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  assert.equal(h.cache.at(-1), "dark");
  await h.controller.setThemeMode("light");
  assert.equal(h.controller.getSnapshot().themeMode, "light");
});

test("a refresh during a save waits for persistence instead of restoring the old profile", async (t) => {
  const save = deferred();
  let persisted = "light", reads = 0;
  const h = harness({ read: async () => { reads++; return persisted; }, write: async (theme) => {
    if (theme === "dark") await save.promise;
    persisted = theme;
    return { ok: true, themeSource: theme };
  } });
  t.after(h.controller.start());
  await flush();
  const changed = h.controller.setThemeMode("dark");
  const refreshed = h.controller.refreshFromCanonical();
  await flush();
  assert.equal(reads, 1);
  save.resolve();
  await changed;
  await refreshed;
  assert.equal(reads, 2);
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
});

test("system changes only repaint system mode and never persist a resolved light/dark value", async (t) => {
  const h = harness({ cached: "system", read: async () => "system" });
  t.after(h.controller.start());
  await flush();
  h.systemThemeChanged(true);
  assert.equal(h.controller.getSnapshot().resolvedTheme, "dark");
  h.systemThemeChanged(false);
  assert.equal(h.controller.getSnapshot().resolvedTheme, "light");
  assert.deepEqual(h.writes, ["system"]);
  await h.controller.setThemeMode("dark");
  const count = h.applied.length;
  h.systemThemeChanged(true);
  h.systemThemeChanged(false);
  assert.equal(h.applied.length, count);
  assert.equal(h.controller.getSnapshot().resolvedTheme, "dark");
});

test("StrictMode cleanup removes listeners and ignores reads from an earlier mount", async () => {
  const first = deferred();
  let reads = 0;
  const h = harness({ read: () => ++reads === 1 ? first.promise : Promise.resolve("dark") });
  const stopFirst = h.controller.start();
  await flush();
  stopFirst();
  assert.equal(h.systemListeners.size, 0);
  const stopSecond = h.controller.start();
  await flush();
  first.resolve("light");
  await flush();
  assert.equal(h.systemListeners.size, 1);
  assert.deepEqual(h.writes, ["dark"]);
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  stopSecond();
  assert.equal(h.systemListeners.size, 0);
  assert.equal(h.releases, 2);
});

test("skin tokens are scoped to the document and removed on variant changes and unmount", () => {
  const styles = new Map([["--accent", { value: "original", priority: "important" }]]);
  const root = {
    dataset: { desktopBackground: "previous", desktopBackgroundSource: "previous-source" },
    style: {
      getPropertyValue: (key) => styles.get(key)?.value ?? "",
      getPropertyPriority: (key) => styles.get(key)?.priority ?? "",
      setProperty: (key, value, priority = "") => styles.set(key, { value, priority }),
      removeProperty: (key) => styles.delete(key)
    }
  };
  const target = createDocumentAppearanceTarget(root);
  target.apply(createAppearanceSnapshot("light", false));
  assert.equal(root.dataset.desktopSkin, "default");
  assert.equal(root.dataset.desktopBackground, "none");
  assert.equal(root.dataset.desktopBackgroundSource, "none");
  assert.equal(styles.get("--accent").value, "original");
  const skin = { id: "fixture", backgrounds: {
    light: { imageUrl: "fixture-light.svg", position: "center" },
    dark: { imageUrl: "fixture-dark.svg", position: "center" }
  }, tokens: {
    light: { "--accent": "red", "--ink": "black" }, dark: { "--ink": "white" }
  } };
  target.apply(createAppearanceSnapshot("light", false, skin));
  assert.equal(root.dataset.desktopBackground, "image");
  assert.equal(root.dataset.desktopBackgroundSource, "skin");
  assert.equal(styles.get("--accent").value, "red");
  target.apply(createAppearanceSnapshot("light", false, skin, {
    skinId: "mist", background: null, backgroundDataUrl: "data:image/png;base64,fixture"
  }));
  assert.equal(root.dataset.desktopBackgroundSource, "custom");
  target.apply(createAppearanceSnapshot("dark", false, skin));
  assert.equal(root.dataset.desktopBackgroundSource, "skin");
  assert.deepEqual(styles.get("--accent"), { value: "original", priority: "important" });
  assert.equal(styles.get("--ink").value, "white");
  target.release();
  assert.equal(root.dataset.desktopSkin, undefined);
  assert.equal(root.dataset.desktopBackground, "previous");
  assert.equal(root.dataset.desktopBackgroundSource, "previous-source");
  assert.equal(styles.has("--ink"), false);
  assert.equal(root.dataset.theme, "dark");
});

test("bundled skins preview immediately, persist independently and reject unknown IDs", async (t) => {
  const h = harness();
  await assert.rejects(h.controller.setSkinId("mist"), /not active/);
  t.after(h.controller.start());
  await flush();
  const writes = [...h.writes], cached = [...h.cache];
  const save = h.controller.setSkinId("mist");
  assert.equal(h.controller.getSnapshot().skin, findDesktopSkin("mist"));
  assert.equal(h.controller.getSnapshot().skinSaving, true);
  await save;
  assert.equal(h.controller.getSnapshot().skinSaving, false);
  assert.deepEqual(h.skinWrites, ["mist"]);
  assert.equal(h.skinCache.at(-1), "mist");
  assert.throws(() => h.controller.setSkinId("https://example.test/skin.css"), /Unknown/);
  assert.deepEqual(h.writes, writes);
  assert.deepEqual(h.cache, cached);
  await h.controller.setSkinId("default");
  assert.equal(h.controller.getSnapshot().skin, DEFAULT_DESKTOP_SKIN);
  assert.deepEqual(DESKTOP_SKINS.map((skin) => skin.id), ["default", "mist"]);
});

test("skin selection survives a late canonical read and an in-flight theme rollback", async (t) => {
  const read = deferred(), save = deferred();
  const h = harness({ read: () => read.promise, write: (theme) =>
    theme === "light" ? save.promise : Promise.resolve({ ok: true, themeSource: theme }) });
  t.after(h.controller.start());
  await flush();
  h.controller.setSkinId("mist");
  read.resolve("dark");
  await flush();
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  const pending = h.controller.setThemeMode("light");
  const rejected = assert.rejects(pending, /offline/);
  h.controller.setSkinId("default");
  save.reject(new Error("offline"));
  await rejected;
  assert.equal(h.controller.getSnapshot().themeMode, "dark");
  assert.equal(h.controller.getSnapshot().skin.id, "default");
});

test("system resolution switches the selected skin variant without changing its identity", async (t) => {
  const h = harness({ cached: "system", read: async () => "system" });
  t.after(h.controller.start());
  await flush();
  await h.controller.setSkinId("mist");
  const selected = h.controller.getSnapshot();
  const before = selected.skin.backgrounds[selected.resolvedTheme].imageUrl;
  h.systemThemeChanged(true);
  const after = h.controller.getSnapshot();
  assert.equal(after.skin, selected.skin);
  assert.equal(after.themeMode, "system");
  assert.notEqual(after.skin.backgrounds[after.resolvedTheme].imageUrl, before);
  assert.deepEqual(h.writes, ["system"]);
});

const asset = { id: "a".repeat(32), name: "wallpaper.png", width: 1, height: 1 };
const skinResult = (skinId, background = null, backgroundDataUrl = null) => ({ ok: true, settings: { skinId, background, backgroundDataUrl } });

test("canonical skin overrides startup cache and restores an imported wallpaper", async (t) => {
  const h = harness({ cachedSkin: "default", readSkin: async () => skinResult("mist", asset, "data:image/png;base64,fixture") });
  t.after(h.controller.start());
  await flush();
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  assert.equal(h.controller.getSnapshot().background.imageUrl, "data:image/png;base64,fixture");
  await h.controller.setThemeMode("dark");
  assert.equal(h.controller.getSnapshot().background.imageUrl, "data:image/png;base64,fixture");
  assert.equal(h.controller.getSnapshot().skinLoadState, "ready");
});

test("unavailable wallpaper retains metadata and falls back to bundled background", async (t) => {
  const h = harness({ readSkin: async () => skinResult("mist", asset) });
  t.after(h.controller.start());
  await flush();
  assert.equal(h.controller.getSnapshot().skinSettings.background, asset);
  assert.equal(h.controller.getSnapshot().background, findDesktopSkin("mist").backgrounds.light);
  assert.equal(h.controller.getSnapshot().skinLoadState, "ready");
});

test("failed skin read never writes the cache back and can be retried", async (t) => {
  let fail = true;
  const h = harness({ cachedSkin: "mist", readSkin: async () => fail ? { ok: false, error: "storageFailed" } : skinResult("default") });
  t.after(h.controller.start());
  await flush();
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  assert.equal(h.controller.getSnapshot().skinLoadState, "error");
  assert.deepEqual(h.skinWrites, []);
  assert.deepEqual(h.skinCache, []);
  fail = false;
  await h.controller.refreshFromCanonical();
  assert.equal(h.controller.getSnapshot().skin.id, "default");
  assert.equal(h.controller.getSnapshot().skinLoadState, "ready");
});

test("late skin reads cannot replace a newer selection", async (t) => {
  const read = deferred();
  const h = harness({ readSkin: () => read.promise });
  t.after(h.controller.start());
  await flush();
  await h.controller.setSkinId("mist");
  read.resolve(skinResult("default"));
  await flush();
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
});

test("rapid skin saves stay ordered and latest failure rolls back to the confirmed skin", async (t) => {
  const first = deferred();
  const h = harness({ writeSkin: (id) => id === "mist" ? first.promise : Promise.resolve({ ok: false, error: "storageFailed" }) });
  t.after(h.controller.start());
  await flush();
  const a = h.controller.setSkinId("mist");
  const b = h.controller.setSkinId("default");
  const failed = assert.rejects(b, /storageFailed/);
  await flush();
  assert.deepEqual(h.skinWrites, ["mist"]);
  first.resolve(skinResult("mist"));
  await a;
  await failed;
  assert.deepEqual(h.skinWrites, ["mist", "default"]);
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  assert.equal(h.controller.getSnapshot().skinSaving, false);
});

test("import then skin selection preserves the new image without flashing the old skin", async (t) => {
  const imported = deferred();
  const h = harness({ importBackground: () => imported.promise,
    writeSkin: async (id) => skinResult(id, asset, "data:image/png;base64,new") });
  t.after(h.controller.start());
  await flush();
  const a = h.controller.importBackground();
  const b = h.controller.setSkinId("mist");
  const count = h.applied.length;
  imported.resolve(skinResult("default", asset, "data:image/png;base64,new"));
  await a; await b;
  assert.equal(h.controller.getSnapshot().background.imageUrl, "data:image/png;base64,new");
  assert(h.applied.slice(count).every((snapshot) => snapshot.skin.id === "mist"));
});

test("cancelled and failed imports retain the old image; reset removes only the custom override", async (t) => {
  let mode = "cancel";
  const current = skinResult("mist", asset, "data:image/png;base64,old");
  const h = harness({ readSkin: async () => current,
    importBackground: async () => mode === "cancel" ? { ...current, cancelled: true } : { ok: false, error: "invalidImage" },
    resetBackground: async () => skinResult("mist") });
  t.after(h.controller.start()); await flush();
  assert.equal(await h.controller.importBackground(), true);
  mode = "fail";
  await assert.rejects(h.controller.importBackground(), /invalidImage/);
  assert.equal(h.controller.getSnapshot().background.imageUrl, "data:image/png;base64,old");
  await h.controller.resetBackground();
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  assert.equal(h.controller.getSnapshot().skinSettings.background, null);
  assert.equal(h.controller.getSnapshot().background, findDesktopSkin("mist").backgrounds.light);
});

test("refresh waits for a skin save and remount ignores the old generation's completion", async () => {
  const pending = deferred();
  let saved = skinResult("default");
  const h = harness({ readSkin: async () => saved, writeSkin: async () => { await pending.promise; saved = skinResult("mist"); return saved; } });
  const stop = h.controller.start(); await flush();
  const save = h.controller.setSkinId("mist"); await flush();
  stop();
  const stopAgain = h.controller.start();
  const refresh = h.controller.refreshFromCanonical();
  pending.resolve(); await save; await refresh;
  assert.equal(h.controller.getSnapshot().skin.id, "mist");
  assert.equal(h.controller.getSnapshot().skinSaving, false);
  stopAgain();
});
