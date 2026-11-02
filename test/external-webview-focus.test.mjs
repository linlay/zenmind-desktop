import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/renderer/pages/external-webview/ExternalWebviewPage.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("ExternalWebviewPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ["releaseExternalWebviewFocus", "ExternalWebviewPane"].map((name) => {
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must execute from the production source`);
  return declaration.getText(parsed);
});
const script = ts.transpileModule(`${declarations.join("\n")}\nglobalThis.Pane = ExternalWebviewPane;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function findWebview(node) {
  if (!node?.props) return null;
  if (node?.type === "webview") return node;
  const children = node?.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findWebview(child);
    if (found) return found;
  }
  return null;
}

// Execute the actual pane with stable refs and layout-effect commit/cleanup.
// The guest models Windows native focus surviving an earlier DOM focus change.
function fixture(platform) {
  const hooks = [];
  let cursor = 0;
  let pendingEffects = [];
  let currentRef;
  let nativeFocused = false;
  const operations = [];
  const otherInput = { kind: "host-input" };
  const ownerDocument = { activeElement: otherInput };
  const webview = {
    ownerDocument,
    blur() {
      operations.push("guest.blur");
      nativeFocused = false;
      if (ownerDocument.activeElement === webview) ownerDocument.activeElement = null;
    },
    focus() { throw new Error("Releasing a guest must not claim focus"); },
    reload() { throw new Error("Focus release must preserve the mounted guest"); },
  };
  const element = (type, props) => ({ type, props });
  const context = vm.createContext({
    exports: {}, navigator: { userAgent: platform === "win32" ? "Windows NT 10.0" : "Macintosh; Intel Mac OS X" },
    createElement: element,
    require: (id) => { assert.equal(id, "react/jsx-runtime"); return { jsx: element, jsxs: element }; },
    useI18n: () => ({ t: (key) => key }),
    WebviewDebugOverlay: "debug-overlay", FileTextOutlined: "file-icon",
    useRef: (initial) => hooks[cursor++] ??= { current: initial },
    useState: (initial) => { const slot = cursor++; hooks[slot] ??= initial; return [hooks[slot], () => {}]; },
    useEffect: () => { cursor++; },
    useLayoutEffect: (effect, deps) => {
      const slot = cursor++;
      const previous = hooks[slot];
      if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        hooks[slot] = { deps, cleanup: effect() };
      });
    },
  });
  vm.runInContext(script, context);
  let props = {
    tab: { id: "site-tab", title: "Website", currentUrl: "https://example.test" },
    active: true, surfaceActive: true,
    onWebviewRefChange: () => {},
  };
  const render = (changes = {}) => {
    cursor = 0;
    pendingEffects = [];
    props = { ...props, ...changes };
    const node = findWebview(context.Pane(props));
    assert.ok(node);
    // Inline callback refs are cleared and assigned on an ordinary rerender too.
    currentRef?.(null);
    currentRef = node.props.ref;
    currentRef(webview);
    pendingEffects.forEach((commit) => commit());
    return node;
  };
  const focusGuest = (domFocused = true) => {
    nativeFocused = true;
    ownerDocument.activeElement = domFocused ? webview : otherInput;
  };
  const unmount = () => {
    // A cleanup reading ref.current here would miss the removed guest.
    currentRef(null);
    hooks.forEach((hook) => hook?.cleanup?.());
  };
  render();
  return { render, unmount, focusGuest, operations, ownerDocument, otherInput, webview, hasNativeFocus: () => nativeFocused };
}

for (const platform of ["win32", "darwin"]) {
  for (const change of [{ active: false }, { surfaceActive: false }]) {
    test(`${platform}: leaving a tab or hiding its surface releases only its guest (${JSON.stringify(change)})`, () => {
      const view = fixture(platform);
      assert.deepEqual(view.operations, []);
      view.focusGuest();
      const hiddenGuest = view.render(change);
      assert.equal(view.hasNativeFocus(), false);
      assert.deepEqual(view.operations, ["guest.blur"]);
      assert.equal(hiddenGuest.props.tabIndex, -1);
      const visibleGuest = view.render({ active: true, surfaceActive: true });
      assert.equal(visibleGuest.props.src, hiddenGuest.props.src);
      assert.equal(visibleGuest.props.tabIndex, 0);
      assert.deepEqual(view.operations, ["guest.blur"]);
    });
  }

  test(`${platform}: removing the pane releases the captured guest after its ref is cleared`, () => {
    const view = fixture(platform);
    view.focusGuest();
    view.unmount();
    assert.equal(view.hasNativeFocus(), false);
    assert.deepEqual(view.operations, ["guest.blur"]);
  });

  test(`${platform}: an unrelated focused input survives background guest hide and unmount`, () => {
    const view = fixture(platform);
    view.render({ surfaceActive: false });
    view.unmount();
    assert.equal(view.ownerDocument.activeElement, view.otherInput);
    assert.deepEqual(view.operations, platform === "win32" ? ["guest.blur", "guest.blur"] : []);
  });
}

test("Windows releases stale native guest focus even after the host reports another active element", () => {
  const view = fixture("win32");
  view.focusGuest(false);
  view.render({ surfaceActive: false });
  assert.equal(view.hasNativeFocus(), false);
  assert.equal(view.ownerDocument.activeElement, view.otherInput);
  assert.deepEqual(view.operations, ["guest.blur"]);
});

test("ordinary rerenders and ref callback churn do not blur an active guest", () => {
  const view = fixture("win32");
  view.focusGuest();
  view.render({ surfaceLabel: "Updated title" });
  assert.equal(view.hasNativeFocus(), true);
  assert.deepEqual(view.operations, []);
});
