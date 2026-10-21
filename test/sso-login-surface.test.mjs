import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
      import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { createTranslator } from "./src/shared/i18n";
      import { RendererI18nContext, defaultRendererI18nContextValue } from "./src/renderer/i18n/i18n-context";
      import { DesktopSsoLoginFailure } from "./src/renderer/identity/DesktopSsoLoginSurface";
      export * from "./src/renderer/identity/login-surface";
      export function renderFailure(failure, locale) {
        return renderToStaticMarkup(createElement(RendererI18nContext.Provider,
          { value: { ...defaultRendererI18nContextValue, locale, t: createTranslator(locale) } },
          createElement(DesktopSsoLoginFailure, { failure, onRetry() {}, onCancel() {} })));
      }
    `
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  loader: { ".css": "empty" },
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  define: {
    __DESKTOP_APP_BRAND__: JSON.stringify({
      id: "sso-test", packageName: "sso-test", storageNamespace: "sso-test", productName: "SSO Test", appId: "sso-test", description: "SSO Test",
      protocols: { open: { scheme: "sso-test" } },
      paths: { runtimeRootDirName: ".sso-test", desktopDataSubdir: ".desktop", programDataDirName: "SSO Test" },
      installer: { shutdownArg: "--shutdown" },
      desktopPet: { id: "test", displayName: "Test", description: "Test", preview: "", states: {} },
      i18n: { "zh-CN": {}, "en-US": {} }
    })
  }
});
const { createDesktopSsoLoginLoadController, classifyDesktopSsoLoginLoadFailure, DESKTOP_SSO_LOGIN_PAGE_TIMEOUT_MS, renderFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

class LoginGuest extends EventTarget {
  url = "https://identity.example.test/login?state=sensitive-state&code=sensitive-code";
  listeners = new Map();

  getURL() { return this.url; }
  addEventListener(name, listener) {
    super.addEventListener(name, listener);
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) {
    super.removeEventListener(name, listener);
    this.listeners.get(name)?.delete(listener);
  }
  event(name, properties = {}) { return Object.assign(new Event(name), properties); }
  emit(name, properties = {}) { this.dispatchEvent(this.event(name, properties)); }
  listener(name) { return [...this.listeners.get(name)][0]; }
}

function harness(t) {
  const updates = [];
  const controller = createDesktopSsoLoginLoadController(state => updates.push(state));
  t.after(() => controller.detach());
  const guest = new LoginGuest();
  controller.bindGuest(guest);
  return { controller, guest, updates };
}

// Both desktop targets use Electron's same WebviewTag event contract. These
// fixtures verify that contract; they do not claim native Windows acceptance.
for (const platform of ["darwin", "win32"]) {
  test(`${platform}: only a main-document failure interrupts the login page`, (t) => {
    const { controller, guest } = harness(t);
    guest.emit("did-fail-load", { isMainFrame: false, errorCode: -105 });
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
    guest.emit("did-fail-load", { errorCode: -105 });
    assert.equal(controller.getState().status, "loading");
    guest.emit("dom-ready");
    assert.equal(controller.getState().status, "ready");
    guest.emit("did-fail-load", { isMainFrame: false, errorCode: -105 });
    assert.equal(controller.getState().status, "ready");
    guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
    assert.equal(controller.getState().status, "loading");
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -105 });
    assert.deepEqual(controller.getState().failure, { reason: "dns", code: -105 });
    guest.url = "chrome-error://chromewebdata/";
    guest.emit("did-start-loading");
    guest.emit("dom-ready");
    guest.emit("did-stop-loading");
    guest.emit("did-finish-load");
    assert.equal(controller.getState().status, "failed");
    assert.deepEqual(controller.getState().failure, { reason: "dns", code: -105 });
  });

  test(`${platform}: subframe and same-document navigation cannot cover a usable login form`, (t) => {
    const { controller, guest } = harness(t);
    guest.emit("dom-ready");
    assert.equal(controller.getState().status, "ready");
    guest.emit("did-start-loading");
    guest.emit("did-start-navigation", { isMainFrame: false, isInPlace: false });
    guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: true });
    assert.equal(controller.getState().status, "ready");
    guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
    assert.equal(controller.getState().status, "loading");
    guest.emit("dom-ready");
    assert.equal(controller.getState().status, "ready");
  });

  test(`${platform}: retry retires the old guest before replacing it and ignores its queued events`, (t) => {
    const { controller, guest } = harness(t);
    const lateFailure = guest.listener("did-fail-load");
    const lateStop = guest.listener("did-stop-loading");
    const lateCrash = guest.listener("render-process-gone");
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -105 });
    controller.retry();
    assert.deepEqual(controller.getState(), { attempt: 1, status: "loading", failure: null });
    assert.equal([...guest.listeners.values()].every(listeners => listeners.size === 0), true);
    const replacement = new LoginGuest();
    controller.bindGuest(replacement);
    lateFailure(guest.event("did-fail-load", { isMainFrame: true, errorCode: -130 }));
    lateStop(guest.event("did-stop-loading"));
    assert.equal(controller.getState().status, "loading");
    replacement.emit("did-finish-load");
    assert.deepEqual(controller.getState(), { attempt: 1, status: "ready", failure: null });
    lateCrash(guest.event("render-process-gone"));
    assert.equal(controller.getState().status, "ready");
  });

  test(`${platform}: a terminated renderer is recoverable and unmount rejects late updates`, (t) => {
    const { controller, guest, updates } = harness(t);
    guest.emit("did-finish-load");
    guest.emit("render-process-gone", { reason: "crashed", exitCode: 1 });
    assert.deepEqual(controller.getState().failure, { reason: "process", code: null });
    guest.emit("did-stop-loading");
    assert.equal(controller.getState().status, "failed");
    controller.retry();
    const replacement = new LoginGuest();
    controller.bindGuest(replacement);
    replacement.emit("did-stop-loading");
    assert.equal(controller.getState().status, "ready");
    const queuedFailure = replacement.listener("did-fail-load");
    controller.detach();
    const updateCount = updates.length;
    queuedFailure(replacement.event("did-fail-load", { isMainFrame: true, errorCode: -105 }));
    assert.equal(updates.length, updateCount);
  });

  test(`${platform}: Chromium error-document completion is a failure even without did-fail-load`, (t) => {
    const { controller, guest } = harness(t);
    guest.url = "about:blank";
    guest.emit("did-stop-loading");
    assert.equal(controller.getState().status, "loading");
    guest.url = "chrome-error://chromewebdata/";
    guest.emit("did-stop-loading");
    assert.deepEqual(controller.getState().failure, { reason: "unknown", code: null });
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -105 });
    assert.deepEqual(controller.getState().failure, { reason: "dns", code: -105 });
  });

  test(`${platform}: a main-document load has a 30 second deadline`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { controller } = harness(t);
    assert.equal(DESKTOP_SSO_LOGIN_PAGE_TIMEOUT_MS, 30_000);
    t.mock.timers.tick(29_999);
    assert.equal(controller.getState().status, "loading");
    t.mock.timers.tick(1);
    assert.deepEqual(controller.getState().failure, { reason: "timeout", code: null });
  });

  test(`${platform}: page readiness, failure and unmount cancel the load deadline`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, guest, updates } = harness(t);
    t.mock.timers.tick(29_999);
    guest.emit("dom-ready");
    t.mock.timers.tick(30_000);
    assert.equal(controller.getState().status, "ready");
    guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
    t.mock.timers.tick(29_999);
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -105 });
    t.mock.timers.tick(30_000);
    assert.deepEqual(controller.getState().failure, { reason: "dns", code: -105 });
    controller.retry();
    controller.bindGuest(new LoginGuest());
    t.mock.timers.tick(29_999);
    controller.detach();
    const updateCount = updates.length;
    t.mock.timers.tick(30_000);
    assert.equal(updates.length, updateCount);
    assert.equal(controller.getState().status, "loading");
  });

  test(`${platform}: retry gets a new deadline and queued timers cannot affect a new page or guest`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const schedule = globalThis.setTimeout;
    const queuedCallbacks = [];
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
      queuedCallbacks.push(callback);
      return schedule(callback, delay);
    });
    const { controller, guest } = harness(t);
    const firstTimer = queuedCallbacks.at(-1);
    guest.emit("dom-ready");
    guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
    const navigationTimer = queuedCallbacks.at(-1);
    firstTimer();
    assert.equal(controller.getState().status, "loading");
    t.mock.timers.tick(29_999);
    controller.retry();
    controller.bindGuest(new LoginGuest());
    navigationTimer();
    assert.equal(controller.getState().status, "loading");
    t.mock.timers.tick(1);
    assert.equal(controller.getState().status, "loading");
    t.mock.timers.tick(29_999);
    assert.deepEqual(controller.getState().failure, { reason: "timeout", code: null });
    assert.equal(controller.getState().attempt, 1);
  });
}

test("login failures keep only safe numeric codes, never sensitive URL or description fields", (t) => {
  const { controller, guest } = harness(t);
  const event = guest.event("did-fail-load", { isMainFrame: true, errorCode: -105 });
  for (const field of ["validatedURL", "errorDescription"]) {
    Object.defineProperty(event, field, { get: () => assert.fail(`The login error must not read ${field}`) });
  }
  guest.dispatchEvent(event);
  const snapshot = controller.getState();
  assert.deepEqual(snapshot.failure, { reason: "dns", code: -105 });
  for (const locale of ["zh-CN", "en-US"]) {
    const html = renderFailure(snapshot.failure, locale);
    assert.match(html, /role="alert"/u);
    assert.match(html, /-105/u);
    assert.match(html, locale === "zh-CN" ? /域名|DNS/u : /domain|DNS/u);
    assert.match(html, locale === "zh-CN" ? /取消登录/u : /Cancel login/u);
    assert.match(html, locale === "zh-CN" ? /重试/u : /Retry/u);
    assert.doesNotMatch(html, /sensitive-state|sensitive-code|identity\.example\.test|https?:\/\//u);
  }
});

test("safe Chromium error categories distinguish DNS, offline, proxy, timeout and certificate failures", () => {
  for (const [code, reason] of [[-105, "dns"], [-137, "dns"], [-106, "offline"], [-111, "proxy"], [-130, "proxy"], [-131, "proxy"], [-7, "timeout"], [-118, "timeout"], [-102, "connection"], [-202, "certificate"], [-999, "unknown"]]) {
    assert.deepEqual(classifyDesktopSsoLoginLoadFailure(code), { reason, code });
  }
  for (const invalidCode of [undefined, null, "https://identity.example.test?code=secret", NaN, Infinity, -1.5]) {
    assert.deepEqual(classifyDesktopSsoLoginLoadFailure(invalidCode), { reason: "unknown", code: null });
  }
});
