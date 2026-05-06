import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BrowserUseController } = require("../dist-electron/main/assistant/browser-use.js");

function makeFakeWebContents({
  id = 101,
  url = "https://example.com/",
  title = "Example",
  runtimeValues = [],
  commandResults = {}
} = {}) {
  const calls = [];
  const debuggerApi = {
    attached: false,
    isAttached() {
      return this.attached;
    },
    attach() {
      this.attached = true;
      calls.push(["attach"]);
    },
    detach() {
      this.attached = false;
      calls.push(["detach"]);
    },
    async sendCommand(method, params = {}) {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") {
        const value = runtimeValues.shift();
        if (value instanceof Error) {
          throw value;
        }
        return { result: { value } };
      }
      if (method === "Accessibility.getFullAXTree") {
        return commandResults.accessibility ?? { nodes: [] };
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return commandResults.domSnapshot ?? { documents: [], strings: [] };
      }
      if (method === "Page.captureScreenshot") {
        return commandResults.screenshot ?? { data: "" };
      }
      return commandResults[method] ?? {};
    }
  };
  return {
    calls,
    contents: {
      id,
      isDestroyed: () => false,
      focus() {
        calls.push(["focus"]);
      },
      getURL: () => url,
      getTitle: () => title,
      debugger: debuggerApi
    }
  };
}

test("BrowserUseController snapshotPage creates stable refs for controls and fields", async () => {
  const { contents } = makeFakeWebContents({
    runtimeValues: [
      {
        ok: true,
        action: "observe",
        url: "https://www.baidu.com/",
        title: "百度一下",
        bodyText: "百度首页",
        elements: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#su\",\"text\":\"百度一下\"}",
            kind: "button",
            text: "百度一下",
            tagName: "BUTTON",
            role: "button",
            ariaLabel: "",
            x: 520,
            y: 42,
            width: 120,
            height: 44,
            interactive: true,
            unsafe: false
          }
        ],
        fields: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#kw\",\"label\":\"搜索框\"}",
            label: "搜索框",
            tagName: "INPUT",
            type: "search",
            role: "textbox",
            value: "",
            placeholder: "",
            required: false,
            checked: false,
            options: [],
            x: 200,
            y: 42,
            width: 420,
            height: 44
          }
        ]
      },
      {
        url: "https://www.baidu.com/",
        title: "百度一下",
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: "百度首页"
      }
    ]
  });
  const controller = new BrowserUseController({
    resolveWebContents: () => contents
  });

  const snapshot = await controller.snapshotPage(101);

  assert.match(snapshot.snapshotId, /^snap_/);
  assert.equal(snapshot.elements[0].ref, "@e1");
  assert.equal(snapshot.fields[0].ref, "@f1");
  assert.equal(snapshot.elements[0].selector, "#su");
  assert.equal(snapshot.fields[0].selector, "#kw");
});

test("BrowserUseController retries transient Runtime context errors before reading page", async () => {
  const fake = makeFakeWebContents({
    runtimeValues: [
      new Error("Cannot find default execution context"),
      new Error("Execution context was destroyed."),
      {
        url: "https://www.google.com/",
        title: "Google",
        selectedText: "",
        metaDescription: "",
        headings: ["Google"],
        bodyText: "Google Search"
      }
    ]
  });
  const controller = new BrowserUseController({
    resolveWebContents: () => fake.contents
  });

  const pageContext = await controller.readPageContext(101);

  assert.equal(pageContext.url, "https://www.google.com/");
  assert.equal(pageContext.title, "Google");
  assert.equal(
    fake.calls.filter((call) => call[0] === "Runtime.evaluate").length,
    3
  );
});

test("BrowserUseController refuses stale refs after page signature changes", async () => {
  let currentUrl = "https://example.com/first";
  const fake = makeFakeWebContents({
    get url() {
      return currentUrl;
    },
    runtimeValues: [
      {
        ok: true,
        action: "observe",
        url: currentUrl,
        title: "First",
        bodyText: "First page",
        elements: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#next\",\"text\":\"下一步\"}",
            kind: "button",
            text: "下一步",
            tagName: "BUTTON",
            role: "button",
            ariaLabel: "",
            x: 50,
            y: 50,
            width: 80,
            height: 30,
            interactive: true,
            unsafe: false
          }
        ],
        fields: []
      },
      {
        url: currentUrl,
        title: "First",
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: "First page"
      }
    ]
  });
  fake.contents.getURL = () => currentUrl;
  const controller = new BrowserUseController({
    resolveWebContents: () => fake.contents
  });
  const snapshot = await controller.snapshotPage(101);
  currentUrl = "https://example.com/second";

  const result = await controller.click(101, { elementRef: snapshot.elements[0].ref });

  assert.equal(result.ok, false);
  assert.equal(result.error, "stale_ref");
  assert.equal(fake.calls.some((call) => call[0] === "Input.dispatchMouseEvent"), false);
});

test("BrowserUseController reports actionability failures before dispatching input", async () => {
  const fake = makeFakeWebContents({
    runtimeValues: [
      {
        ok: true,
        action: "observe",
        url: "https://example.com/",
        title: "Example",
        bodyText: "Example",
        elements: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#covered\",\"text\":\"启动\"}",
            kind: "button",
            text: "启动",
            tagName: "BUTTON",
            role: "button",
            ariaLabel: "",
            x: 50,
            y: 50,
            width: 80,
            height: 30,
            interactive: true,
            unsafe: false
          }
        ],
        fields: []
      },
      {
        url: "https://example.com/",
        title: "Example",
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: "Example"
      },
      {
        ok: false,
        reason: "covered",
        reasons: ["元素中心点被 .modal 遮挡"],
        rect: { x: 10, y: 10, width: 80, height: 30 }
      }
    ]
  });
  const controller = new BrowserUseController({
    resolveWebContents: () => fake.contents
  });
  const snapshot = await controller.snapshotPage(101);

  const result = await controller.click(101, { elementRef: snapshot.elements[0].ref });

  assert.equal(result.ok, false);
  assert.equal(result.error, "element_not_actionable");
  assert.match(result.message, /遮挡|不可操作/);
  assert.equal(fake.calls.some((call) => call[0] === "Input.dispatchMouseEvent"), false);
});
