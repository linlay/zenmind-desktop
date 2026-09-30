import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const typescript = require("typescript");
const hookPath = path.resolve("src/renderer/app-shell/conversation-share/useConversationShareDialog.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHookHarness(electronAPI) {
  const previousWindow = globalThis.window;
  const hooks = [];
  let cursor = 0;
  let disposed = false;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (update) => {
        const current = hooks[index].value;
        hooks[index].value = typeof update === "function" ? update(current) : update;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous && deps?.every((value, offset) => Object.is(value, previous.deps?.[offset]))) return;
      previous?.cleanup?.();
      hooks[index] = { deps, cleanup: effect() };
    },
  };
  globalThis.window = {
    electronAPI,
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  const source = fs.readFileSync(hookPath, "utf8");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "react") return react;
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  const render = () => {
    cursor = 0;
    return module.exports.useConversationShareDialog({ chatId: "chat-1" }, (key) => key);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const hook of hooks) hook?.cleanup?.();
    globalThis.window = previousWindow;
  };
  return { render, state: () => hooks[0].value, cleanup };
}

test("share choice stays open during creation and closes only after copying succeeds", async () => {
  const creation = deferred();
  const copying = deferred();
  const harness = createHookHarness({
    assistant: { shareChat: () => creation.promise },
    clipboard: { writeText: () => copying.promise },
  });
  try {
    const operation = harness.render().run("copy");
    assert.equal(harness.render().state.phase, "choice");
    assert.equal(harness.render().state.workingAction, "copy");
    creation.resolve({ ok: true, record: { url: "https://example.test/share/1" }, warning: "" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.render().state.phase, "choice");
    assert.equal(harness.render().state.workingAction, "copy");
    copying.resolve({ ok: true });
    await operation;
    assert.equal(harness.render().state.phase, "done");
  } finally {
    harness.cleanup();
  }
});

test("failed copy keeps the choice open and retries without creating a second link", async () => {
  let createCount = 0;
  let copyCount = 0;
  const harness = createHookHarness({
    assistant: { shareChat: async () => {
      createCount += 1;
      return { ok: true, record: { url: "https://example.test/share/1" }, warning: "" };
    } },
    clipboard: { writeText: async () => {
      copyCount += 1;
      return { ok: copyCount > 1 };
    } },
  });
  try {
    await harness.render().run("copy");
    assert.equal(harness.render().state.phase, "choice");
    assert.equal(harness.render().state.feedback.kind, "error");
    assert.equal(harness.render().state.workingAction, null);
    await harness.render().run("copy");
    assert.equal(harness.render().state.phase, "done");
    assert.equal(createCount, 1);
    assert.equal(copyCount, 2);
  } finally {
    harness.cleanup();
  }
});

test("creation failure keeps the choice open until a browser action succeeds", async () => {
  let createCount = 0;
  let openedUrl = "";
  const harness = createHookHarness({
    assistant: { shareChat: async () => {
      createCount += 1;
      return createCount === 1
        ? { ok: false, message: "create failed" }
        : { ok: true, record: { url: "https://example.test/share/1" }, warning: "" };
    } },
    shell: { openExternal: async (url) => {
      openedUrl = url;
      return { ok: true };
    } },
  });
  try {
    await harness.render().run("browser");
    assert.equal(harness.render().state.phase, "choice");
    assert.equal(harness.render().state.feedback.message, "create failed");
    await harness.render().run("browser");
    assert.equal(harness.render().state.phase, "done");
    assert.equal(createCount, 2);
    assert.equal(openedUrl, "https://example.test/share/1");
  } finally {
    harness.cleanup();
  }
});

test("QR opens separately after creation, browser failure stays open, and late results are ignored", async () => {
  const browser = deferred();
  let createCount = 0;
  const harness = createHookHarness({
    assistant: { shareChat: async () => {
      createCount += 1;
      return { ok: true, record: { url: "https://example.test/share/1" }, warning: "" };
    } },
    shell: { openExternal: () => browser.promise },
  });
  try {
    const browserOperation = harness.render().run("browser");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.render().state.phase, "choice");
    browser.resolve({ ok: false });
    await browserOperation;
    assert.equal(harness.render().state.phase, "choice");
    assert.equal(harness.render().state.feedback.kind, "error");
    await harness.render().run("qr");
    assert.equal(harness.render().state.phase, "qr");
    assert.equal(createCount, 1);
  } finally {
    harness.cleanup();
  }

  const creation = deferred();
  const closedHarness = createHookHarness({ assistant: { shareChat: () => creation.promise } });
  try {
    const operation = closedHarness.render().run("qr");
    closedHarness.cleanup();
    creation.resolve({ ok: true, record: { url: "https://example.test/share/2" }, warning: "" });
    await operation;
    assert.equal(closedHarness.state().phase, "choice");
  } finally {
    closedHarness.cleanup();
  }
});
