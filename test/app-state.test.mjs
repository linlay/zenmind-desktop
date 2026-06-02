import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

const {
  createMainAppState
} = await import("../dist-electron/main/app-state.js");

test("main app state keeps current page context isolated per instance", () => {
  const firstState = createMainAppState();
  const secondState = createMainAppState();
  const snapshot = {
    pageKind: "webview",
    route: "/service/agent-webclient",
    surfaceId: "agent-webclient",
    webContentsId: 42,
    pageContext: {
      url: "https://example.test/",
      title: "Example"
    }
  };

  assert.equal(firstState.currentPageSnapshot, null);
  assert.equal(secondState.currentPageSnapshot, null);

  firstState.currentPageSnapshot = snapshot;

  assert.equal(firstState.currentPageSnapshot, snapshot);
  assert.equal(secondState.currentPageSnapshot, null);
});

test("main app state owns startup defaults for process lifecycle state", async () => {
  const state = createMainAppState();
  const otherState = createMainAppState();

  assert.equal(state.mainWindow, null);
  assert.equal(state.desktopPetWindow, null);
  assert.equal(state.isHandlingQuit, false);
  assert.equal(state.desktopSsoWebviewCompletionInFlight, false);
  assert.equal(state.shutdownCleanupPromise, null);
  assert.equal(state.shutdownCleanupComplete, false);
  assert.equal(state.mainWindowSidebarTranslucencyEnabled, true);
  assert.equal(state.desktopActionRendererRequests.size, 0);
  assert.equal(state.logStreamSubscriptions.size, 0);

  state.isHandlingQuit = true;
  state.desktopSsoWebviewCompletionInFlight = true;
  state.shutdownCleanupComplete = true;
  state.serviceMutationQueue = Promise.resolve();
  state.desktopActionRendererRequests.set("request-1", { resolve: () => {}, timeout: null });

  await assert.doesNotReject(state.serviceMutationQueue);
  assert.equal(otherState.isHandlingQuit, false);
  assert.equal(otherState.desktopSsoWebviewCompletionInFlight, false);
  assert.equal(otherState.shutdownCleanupComplete, false);
  assert.equal(otherState.desktopActionRendererRequests.size, 0);
});

test("main process stores window references in app state", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.doesNotMatch(mainProcess, /let mainWindow: BrowserWindow \| null = null;/);
  assert.doesNotMatch(mainProcess, /let desktopPetWindow: BrowserWindow \| null = null;/);
  assert.match(mainProcess, /createMainAppState\(\)/);
  assert.match(mainProcess, /appState\.mainWindow/);
  assert.match(mainProcess, /appState\.desktopPetWindow/);
});

test("main process stores mutable desktop runtime state in app state", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const appState = fs.readFileSync(path.join(projectRoot, "src", "main", "app-state.ts"), "utf8");
  const mainProcessContext = fs.readFileSync(path.join(projectRoot, "src", "main", "main-process-context.ts"), "utf8");

  assert.doesNotMatch(mainProcess, /^let /m);
  assert.match(mainProcess, /appState\.desktopPetSettings/);
  assert.match(mainProcess, /appState\.desktopPetLocalStatus/);
  assert.match(mainProcess, /appState\.desktopPetState/);
  assert.match(mainProcess, /appState\.assistantNavigationStatusClient/);
  assert.match(mainProcess, /appState\.desktopSsoWebviewCompletionInFlight/);
  assert.match(appState, /desktopActionRendererRequests:/);
  assert.match(appState, /logStreamSubscriptions:/);
  assert.match(mainProcessContext, /desktopActionRendererRequests: context\.state\.desktopActionRendererRequests/);
  assert.match(mainProcessContext, /logStreamSubscriptions: context\.state\.logStreamSubscriptions/);
});
