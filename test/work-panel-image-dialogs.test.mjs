import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelResourceImage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("WorkPanelResourceImage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["isCurrentDraft", "requireAnnotationClear", "snapshotFromCanvas", "transform", "resizeImage", "changeResizeDimension", "applyImageResize", "openExternal"]);
const closures = new Map();
let sizeValidation;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "validResizeSize") sizeValidation = node.initializer.getText(ast);
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) closures.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
};
visit(ast);
assert.equal(closures.size, names.size, "exercise the production image operation handlers");
const code = ts.transpileModule([...closures].map(([name, expression]) => `globalThis.${name} = ${expression};`).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({ confirmation = true, annotations = [{ id: "original", requirement: "keep this draft" }] } = {}) {
  const current = { url: "blob:original", width: 400, height: 200, mimeType: "image/png" };
  const draft = { current, annotations, handleRequest: { ownerChatId: "chat", rendererGeneration: "generation", handleId: "handle" }, itemId: "image", sourceRevision: "revision", active: true, editing: true };
  const calls = { pixels: [], annotations: [], imageLoads: [], opens: [], draws: [], confirmations: 0 };
  const context = vm.createContext({
    useCallback: (callback) => callback,
    current, annotations, handleRequest: draft.handleRequest, dirty: true,
    imageDraftRef: { current: draft }, imageDraftRevisionRef: { current: 1 },
    rootRef: { current: { isConnected: true } },
    resizeBusy: false, resizeAspectLocked: true, resizeRequest: null,
    resizeWidth: 200, resizeHeight: 100, validResizeSize: true,
    confirm: async () => { calls.confirmations++; return typeof confirmation === "function" ? confirmation() : confirmation; },
    t: (key) => key,
    setResizeRequest: (update) => { context.resizeRequest = typeof update === "function" ? update(context.resizeRequest) : update; },
    setResizeBusy: (value) => { context.resizeBusy = value; },
    setAnnotations: (value) => { calls.annotations.push(value); },
    setError: () => undefined,
    replaceHistory: (value) => calls.pixels.push(value),
    canvasBlob: async () => ({ fixture: true }),
    loadImage: async (url) => { calls.imageLoads.push(url); return { url }; },
    URL: { createObjectURL: () => "blob:replacement" },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (...args) => calls.draws.push(args), translate() {}, rotate() {}, scale() {} }) }) },
    window: { electronAPI: { chatWorkPanel: { resourceImages: { openExternal: async (request) => { calls.opens.push(request); return { ok: true }; } } } } },
  });
  vm.runInContext(code, context);
  return { context, calls, draft };
}

test("opening and cancelling resize keeps pixels and annotations untouched", () => {
  const { context, calls, draft } = fixture();
  context.resizeImage();
  assert.equal(context.resizeRequest.draft, draft);
  assert.equal(context.resizeRequest.width, 400);
  assert.equal(context.resizeRequest.height, 200);
  context.setResizeRequest(null);
  assert.equal(calls.confirmations, 0);
  assert.equal(calls.pixels.length, 0);
  assert.equal(calls.annotations.length, 0);
});

test("resize form preserves original aspect ratio in both directions and allows unlocked dimensions", () => {
  const { context } = fixture();
  context.resizeImage();
  context.changeResizeDimension("width", 300);
  assert.equal(context.resizeRequest.height, 150);
  context.changeResizeDimension("height", 80);
  assert.equal(context.resizeRequest.width, 160);
  context.resizeAspectLocked = false;
  context.changeResizeDimension("width", 240);
  assert.equal(context.resizeRequest.height, 80);
  context.changeResizeDimension("height", null);
  assert.equal(context.resizeRequest.height, null);
});

test("declining annotation removal cancels rotate and resize before pixel work", async () => {
  for (const action of ["rotate", "resize"]) {
    const { context, calls } = fixture({ confirmation: false });
    if (action === "rotate") await context.transform("rotate");
    else { context.resizeImage(); await context.applyImageResize(); }
    assert.equal(calls.confirmations, 1);
    assert.equal(calls.imageLoads.length, 0);
    assert.equal(calls.pixels.length, 0);
    assert.equal(calls.annotations.length, 0);
  }
});

test("accepted resize replaces pixels once and clears the approved annotation draft at commit", async () => {
  const { context, calls } = fixture();
  context.resizeImage();
  await context.applyImageResize();
  assert.equal(calls.pixels.length, 1);
  assert.equal(calls.pixels[0].width, 200);
  assert.equal(calls.pixels[0].height, 100);
  assert.equal(calls.annotations.length, 1);
  assert.equal(calls.annotations[0].length, 0);
  assert.equal(context.resizeRequest, null);
  assert.equal(context.resizeBusy, false);
});

test("resize accepts boundary dimensions and rejects empty, nonfinite, oversized and over-budget sizes", () => {
  for (const [width, height, valid] of [[1, 1, true], [8192, 1, true], [8000, 5000, true], [0, 1, false], [1, 0, false], [8193, 1, false], [1, 8193, false], [8001, 5000, false], [NaN, 20, false], [20, Infinity, false]]) {
    assert.equal(vm.runInNewContext(sizeValidation, { resizeWidth: width, resizeHeight: height }), valid, `${width} x ${height}`);
  }
});

test("invalid dimensions or pixel budget do not request destructive confirmation", async () => {
  const { context, calls } = fixture();
  context.resizeImage();
  context.validResizeSize = false;
  await context.applyImageResize();
  assert.equal(calls.confirmations, 0);
  assert.equal(calls.pixels.length, 0);
  assert.equal(calls.annotations.length, 0);
});

test("approval cannot clear annotations added while its dialog was pending", async () => {
  let approve;
  const { context, calls, draft } = fixture({ confirmation: () => new Promise((resolve) => { approve = resolve; }) });
  const rotating = context.transform("rotate");
  context.imageDraftRef.current = { ...draft, annotations: [...draft.annotations, { id: "new" }] };
  approve(true);
  await rotating;
  assert.equal(calls.pixels.length, 0);
  assert.equal(calls.annotations.length, 0);
});

test("late image encoding cannot overwrite a replacement image or an unmounted editor", async () => {
  for (const unmount of [false, true]) {
    let finish;
    const { context, calls, draft } = fixture();
    context.canvasBlob = () => new Promise((resolve) => { finish = resolve; });
    const saving = context.snapshotFromCanvas({ width: 40, height: 20 }, "image/png", draft);
    if (unmount) context.rootRef.current = null;
    else context.imageDraftRef.current = { ...draft, current: { ...draft.current, url: "blob:newer" } };
    finish({ fixture: true });
    assert.equal(await saving, false);
    assert.equal(calls.pixels.length, 0);
    assert.equal(calls.annotations.length, 0);
  }
});

test("external open waits for approval and rejects a changed resource identity", async () => {
  let approve;
  const { context, calls, draft } = fixture({ confirmation: () => new Promise((resolve) => { approve = resolve; }) });
  const opening = context.openExternal("choose");
  assert.equal(calls.opens.length, 0);
  context.imageDraftRef.current = { ...draft, handleRequest: { ...draft.handleRequest, handleId: "new-handle" } };
  approve(true);
  await opening;
  assert.equal(calls.opens.length, 0);
  const accepted = fixture();
  await accepted.context.openExternal("default");
  assert.equal(accepted.calls.opens.length, 1);
  assert.equal(accepted.calls.opens[0].handleId, "handle");
});
