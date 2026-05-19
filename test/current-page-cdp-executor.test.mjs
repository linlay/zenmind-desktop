import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require.resolve("electron");

class FakeDebugger {
  attached = false;
  sent = [];

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  detach() {
    this.attached = false;
  }

  async sendCommand(method, params) {
    this.sent.push({ method, params });
    if (method !== "Runtime.evaluate") {
      return { result: { value: null } };
    }
    const expression = String(params?.expression || "");
    if (expression.includes("primary-selector")) {
      return { result: { value: { ok: true, selector: "primary-selector" } } };
    }
    if (expression.includes("alias-selector")) {
      return { result: { value: { ok: true, selector: "alias-selector" } } };
    }
    return {
      result: {
        value: {
          url: "https://example.test/",
          title: "Example",
          selectedText: "",
          metaDescription: "Meta",
          headings: ["One"],
          bodyText: "Body",
          forms: [{ selector: "#form" }],
          fields: [{ selector: "#hidden-css", type: "textarea", value: "x".repeat(5000) }],
          links: [{ selector: "#link", text: "Link", href: "https://example.test/link" }],
          images: [{ selector: "#image", src: "https://example.test/image.png" }]
        }
      }
    };
  }
}

function loadExecutor(fakeDebugger) {
  delete require.cache[require.resolve("../dist-electron/main/current-page-cdp-executor.js")];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      webContents: {
        fromId: () => ({
          debugger: fakeDebugger,
          isDestroyed: () => false
        })
      }
    }
  };
  return require("../dist-electron/main/current-page-cdp-executor.js");
}

function snapshot() {
  return {
    route: "/custom-sidebar/test",
    pageKey: "webview:test",
    pageKind: "webview",
    webContentsId: 42,
    pageContext: {
      url: "https://example.test/",
      title: "Example",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: ""
    }
  };
}

test("current page CDP interact accepts elementSelector as a selector alias", async () => {
  const fakeDebugger = new FakeDebugger();
  const { executeCurrentPageCdpAction } = loadExecutor(fakeDebugger);

  const response = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.interact",
    args: {
      elementSelector: "#alias-selector",
      action: "click"
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.outcome.selector, "alias-selector");
  assert.match(fakeDebugger.sent[0].params.expression, /#alias-selector/);
});

test("current page CDP interact prefers selector over elementSelector", async () => {
  const fakeDebugger = new FakeDebugger();
  const { executeCurrentPageCdpAction } = loadExecutor(fakeDebugger);

  const response = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.interact",
    args: {
      selector: "#primary-selector",
      elementSelector: "#alias-selector",
      action: "click"
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.outcome.selector, "primary-selector");
  assert.match(fakeDebugger.sent[0].params.expression, /#primary-selector/);
  assert.doesNotMatch(fakeDebugger.sent[0].params.expression, /#alias-selector/);
});

test("current page CDP interact still rejects missing selector or invalid action", async () => {
  const fakeDebugger = new FakeDebugger();
  const { executeCurrentPageCdpAction } = loadExecutor(fakeDebugger);

  const missingSelector = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.interact",
    args: {
      action: "click"
    }
  });
  assert.equal(missingSelector.ok, false);
  assert.equal(missingSelector.error.code, "invalid_args");

  const invalidAction = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.interact",
    args: {
      elementSelector: "#alias-selector",
      action: "hover"
    }
  });
  assert.equal(invalidAction.ok, false);
  assert.equal(invalidAction.error.code, "invalid_args");
});

test("current page CDP readCurrent defaults to lightweight data and expands explicit includes", async () => {
  const fakeDebugger = new FakeDebugger();
  const { executeCurrentPageCdpAction } = loadExecutor(fakeDebugger);

  const defaultResponse = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.readCurrent",
    args: {}
  });

  assert.equal(defaultResponse.ok, true);
  assert.deepEqual(Object.keys(defaultResponse.result.data).sort(), [
    "bodyText",
    "headings",
    "metaDescription",
    "selectedText",
    "title",
    "url"
  ]);

  const linksResponse = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.readCurrent",
    args: { include: ["links"] }
  });
  assert.equal(linksResponse.ok, true);
  assert.equal(Array.isArray(linksResponse.result.data.links), true);
  assert.equal(linksResponse.result.data.forms, undefined);
  assert.equal(linksResponse.result.data.fields, undefined);

  const formsResponse = await executeCurrentPageCdpAction(snapshot(), {
    action: "desktop.page.readCurrent",
    args: { include: ["forms"] }
  });
  assert.equal(formsResponse.ok, true);
  assert.equal(Array.isArray(formsResponse.result.data.forms), true);
  assert.equal(Array.isArray(formsResponse.result.data.fields), true);
  assert.equal(formsResponse.result.data.links, undefined);
  assert.ok(String(formsResponse.result.data.fields[0].value).length < 5001);
});
