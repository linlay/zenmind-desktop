// Isolated Electron rendering/interaction check for the native image editor.
// Run from the repository root: node qa/work-panel-image-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const brand = {
  ...requireFromRepo(path.join(repo, "dist-electron/shared/brand.js")).APP_BRAND,
  storageNamespace: "image-editor-smoke",
  protocols: { open: { scheme: "image-editor-smoke" } },
  installer: { shutdownArg: "--stop" },
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-panel-image-smoke-"));
const output = path.join(root, "preview");
fs.mkdirSync(output, { recursive: true });

const imagePath = process.env.IMAGE_EDITOR_QA_IMAGE
  ?? path.join(repo, "..", "zenmind-env", "chats", "01ce74ef-0536-4a89-9dd1-4c25c9989c3e", "trae-annual-2025.png");
const base64 = fs.readFileSync(imagePath).toString("base64");

await build({
  entryPoints: [path.join(repo, "qa/work-panel-image-preview.tsx")],
  outfile: path.join(output, "preview.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(brand) },
});

fs.writeFileSync(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<link rel="stylesheet" href="./preview.css">
<script>window.__IMAGE_BASE64__ = ${JSON.stringify(base64)};</script>
<div id="root" style="position:fixed;inset:0"></div>
<script src="./preview.js"></script></html>`);

const runner = path.join(output, "run.cjs");
fs.writeFileSync(runner, `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
app.setPath("userData", ${JSON.stringify(root)});
app.disableHardwareAcceleration();
const errors = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 977, height: 1367, useContentSize: true, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2 && !/(Electron Security Warning|unsafe-eval|For more information and help|willReadFrequently)/.test(message)) errors.push(message);
    console.log("renderer:", message);
  });
  await win.loadFile(path.join(__dirname, "index.html"));
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timeout waiting for " + label);
  };
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name + ".png"), image.toPNG());
  };
  const drag = async (fromX, fromY, toX, toY) => {
    win.webContents.sendInputEvent({ type: "mouseMove", x: fromX, y: fromY });
    win.webContents.sendInputEvent({ type: "mouseDown", x: fromX, y: fromY, button: "left", clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(fromX + (toX - fromX) * step / 6), y: Math.round(fromY + (toY - fromY) * step / 6), button: "left", buttons: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: toX, y: toY, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  const toolbarClick = async (label) => {
    await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === " + JSON.stringify(label) + ")?.click()");
    await new Promise((resolve) => setTimeout(resolve, 250));
  };
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  await waitFor("(() => { const canvas = document.querySelector('.work-panel-image-fabric-host canvas'); const overlay = document.querySelector('.work-panel-image-canvas'); if (!canvas || !overlay || overlay.getBoundingClientRect().width <= 100) return false; const context = canvas.getContext('2d'); const data = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data; return data[3] > 0; })()", "fabric image");
  await shot("preview");

  const preview = await win.webContents.executeJavaScript(\`(() => {
    const overlay = document.querySelector('.work-panel-image-canvas');
    const rect = overlay.getBoundingClientRect();
    const host = document.querySelector('.work-panel-image-fabric-host');
    const canvas = host.querySelector('canvas');
    return {
      overlay: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      fabric: { width: canvas.width, height: canvas.height },
      fitZoom: document.querySelector('.work-panel-image-zoom-control input')?.value,
    };
  })()\`);
  console.log("preview:", JSON.stringify(preview));
  assert.ok(preview.overlay.width > 100, "image overlay should be laid out");
  assert.ok(preview.overlay.width < 977, "fit zoom should leave margins");

  // edit mode
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('编辑'))?.click()\`);
  await waitFor("Boolean(document.querySelector('.work-panel-image-editor-sidebar'))", "editor");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await shot("editing");

  // Basic adjustment stays above the AI divider; its shadow must not be clipped.
  await toolbarClick("调整");
  const adjustments = await win.webContents.executeJavaScript(\`(() => {
    const button = document.querySelector('button[aria-label="调整"]');
    const floating = document.querySelector('.work-panel-image-floating-controls');
    const panel = document.querySelector('.work-panel-image-adjustments');
    return {
      secondary: button.closest('.work-panel-image-editor-tool-group').classList.contains('is-secondary'),
      overflowX: getComputedStyle(floating).overflowX,
      overflowY: getComputedStyle(floating).overflowY,
      panelOverflowY: getComputedStyle(panel).overflowY,
    };
  })()\`);
  console.log("adjustments:", JSON.stringify(adjustments));
  await shot("adjustments");
  assert.equal(adjustments.secondary, false, "adjustment should be above the divider");
  assert.equal(adjustments.overflowX, "visible", "floating container should not clip horizontal shadows");
  assert.equal(adjustments.overflowY, "visible", "floating container should not clip vertical shadows");
  assert.equal(adjustments.panelOverflowY, "auto", "adjustment content should retain internal scrolling");
  await toolbarClick("调整");

  // crop tool + drag
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '裁剪')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const overlayRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  const startX = Math.round(overlayRect.x + overlayRect.width * 0.25);
  const startY = Math.round(overlayRect.y + overlayRect.height * 0.2);
  await drag(startX, startY, startX + 200, startY + 180);
  const crop = await win.webContents.executeJavaScript(\`(() => {
    const box = document.querySelector('.work-panel-image-crop-rect');
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, toolbar: Boolean(document.querySelector('.work-panel-image-crop-actions')), size: document.querySelector('.work-panel-image-crop-size')?.textContent?.trim() };
  })()\`);
  console.log("crop:", JSON.stringify(crop));
  assert.ok(crop && crop.width > 100 && crop.height > 80, "crop box should be drawn");
  assert.ok(crop.toolbar, "crop toolbar should be visible");
  // crop frame handles keep working
  const cropHandle = await win.webContents.executeJavaScript(\`(() => {
    const handle = document.querySelector('.work-panel-image-crop-rect > button.is-se');
    const rect = handle.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()\`);
  await drag(cropHandle.x, cropHandle.y, cropHandle.x + 30, cropHandle.y + 20);
  const cropResized = await win.webContents.executeJavaScript(\`(() => {
    const box = document.querySelector('.work-panel-image-crop-rect').getBoundingClientRect();
    return { width: box.width, height: box.height, size: document.querySelector('.work-panel-image-crop-size')?.textContent?.trim() };
  })()\`);
  console.log("crop resized:", JSON.stringify(cropResized));
  assert.ok(cropResized.width > crop.width + 15 && cropResized.height > crop.height + 10, "crop handles should resize the box");
  const [cropWidth, cropHeight] = (cropResized.size || "").split(" × ").map(Number);
  assert.ok(Number.isFinite(cropWidth) && Number.isFinite(cropHeight) && cropWidth > 0 && cropHeight > 0, "crop size should be shown as W × H");
  const scale = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width / 1125\`);
  assert.ok(Math.abs(cropWidth - cropResized.width / scale) <= 2 && Math.abs(cropHeight - cropResized.height / scale) <= 2, "crop size should be in image pixels");
  await shot("crop");

  // wheel zoom keeps the picture under the cursor
  const zoomBefore = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width\`);
  win.webContents.sendInputEvent({ type: "mouseWheel", x: 400, y: 500, deltaX: 0, deltaY: -120, wheelTicksY: -1, canScroll: false, button: "left" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const wheel = await win.webContents.executeJavaScript(\`({ delta: window.__wheelDelta, width: document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width })\`);
  console.log("zoom:", zoomBefore, "->", JSON.stringify(wheel));
  assert.notEqual(wheel.delta, 0, "wheel event should reach the editor");
  assert.ok(
    wheel.delta < 0 ? wheel.width > zoomBefore + 5 : wheel.width < zoomBefore - 5,
    "zoom direction should follow the wheel delta",
  );
  await shot("zoomed");

  // pan tool moves the image with the pointer
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '选择 / 平移')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const panRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  await drag(Math.round(panRect.x + panRect.width / 2), Math.round(panRect.y + panRect.height / 2), Math.round(panRect.x + panRect.width / 2 + 90), Math.round(panRect.y + panRect.height / 2 + 70));
  const panAfter = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  console.log("pan:", JSON.stringify({ left: panAfter.x - panRect.x, top: panAfter.y - panRect.y }));
  assert.ok(panAfter.x - panRect.x > 60 && panAfter.y - panRect.y > 40, "pan should follow the drag");

  assert.equal(await win.webContents.executeJavaScript(\`Boolean(document.querySelector('button[aria-label="0 条批注"]'))\`), false, "count button should be hidden outside annotation mode");
  await win.webContents.executeJavaScript(\`document.querySelector('button[aria-label="批注修改"]').click()\`);
  // annotation list opens independently, including its empty state
  await toolbarClick("0 条批注");
  assert.equal(await win.webContents.executeJavaScript(\`Boolean(document.querySelector('.work-panel-image-annotations'))\`), true, "count button should open the empty annotation list");
  await toolbarClick("0 条批注");
  assert.equal(await win.webContents.executeJavaScript(\`Boolean(document.querySelector('.work-panel-image-annotations'))\`), false, "count button should close the annotation list");

  // annotation mode locks every other image tool, including rotate and flip
  await new Promise((resolve) => setTimeout(resolve, 150));
  const annotationLock = await win.webContents.executeJavaScript(\`(() => {
    const tool = document.querySelector('button[aria-label="批注修改"]');
    const others = [...document.querySelectorAll('.work-panel-image-editor-sidebar button, .work-panel-image-toolbar button, .work-panel-image-zoom-float button')].filter((button) => button !== tool && !button.hasAttribute('aria-expanded'));
    return { active: tool.getAttribute('aria-pressed'), enabled: others.filter((button) => !button.disabled).map((button) => button.getAttribute('aria-label')), transforms: [...document.querySelectorAll('.work-panel-image-zoom-group button')].every((button) => button.disabled) };
  })()\`);
  assert.equal(annotationLock.active, "true", "annotation tool should be active");
  assert.deepEqual(annotationLock.enabled, [], "other image controls must be disabled in annotation mode");
  assert.equal(annotationLock.transforms, true, "rotate and flip must be disabled");
  const annotateRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  await drag(Math.round(annotateRect.x + annotateRect.width * 0.3), Math.round(annotateRect.y + annotateRect.height * 0.3), Math.round(annotateRect.x + annotateRect.width * 0.3 + 120), Math.round(annotateRect.y + annotateRect.height * 0.3 + 90));
  const annotations = await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-annotation').length\`);
  console.log("annotations:", annotations);
  assert.ok(annotations >= 1, "annotation should be created");
  const draftState = await win.webContents.executeJavaScript(\`(() => {
    const draft = document.querySelector('.work-panel-image-annotation-draft');
    const badge = document.querySelector('.work-panel-image-annotation > span').getBoundingClientRect();
    const panel = draft.getBoundingClientRect();
    const assertBadgeClear = panel.bottom <= badge.top || panel.top >= badge.bottom || panel.right <= badge.left || panel.left >= badge.right;
    const box = document.querySelector('.work-panel-image-annotation').getBoundingClientRect();
    return { badgeClear: assertBadgeClear, exists: Boolean(draft), above: draft.getBoundingClientRect().bottom <= box.top, list: Boolean(document.querySelector('.work-panel-image-annotations')), disabled: draft.querySelector('button[type="submit"]').disabled, iconButtons: [...draft.querySelectorAll('button')].every((button) => button.querySelector('.anticon') && !button.textContent.trim()), focused: document.activeElement === draft.querySelector('textarea') };
  })()\`);
  assert.ok(draftState.exists && draftState.above && draftState.focused, "draft input should focus above the selected box");
  assert.equal(draftState.badgeClear, true, "annotation input must not cover the number badge");
  assert.equal(draftState.list, false, "drawing must not open the annotation list");
  assert.equal(draftState.disabled, true, "empty annotation cannot be confirmed");
  assert.equal(draftState.iconButtons, true, "confirm and delete must use icons only");
  await shot("annotation-draft");
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-annotation-draft button[type="button"]').click()\`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-annotation, .work-panel-image-annotation-draft').length\`), 0, "delete must discard the draft and its box");
  await drag(Math.round(annotateRect.x + annotateRect.width * 0.3), Math.round(annotateRect.y + annotateRect.height * 0.3), Math.round(annotateRect.x + annotateRect.width * 0.3 + 120), Math.round(annotateRect.y + annotateRect.height * 0.3 + 90));
  await win.webContents.executeJavaScript(\`(() => {
    const input = document.querySelector('.work-panel-image-annotation-draft textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '将这个区域改为蓝色');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()\`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const draftKeyboard = await win.webContents.executeJavaScript(\`(() => {
    const draft = document.querySelector('.work-panel-image-annotation-draft');
    const input = draft.querySelector('textarea');
    const buttons = [...draft.querySelectorAll('button')];
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shiftEnter);
    const result = { rows: input.rows, sameRow: Math.abs(input.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) < 8, confirmFirst: buttons[0].type === 'submit', shiftPrevented: shiftEnter.defaultPrevented };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return result;
  })()\`);
  assert.equal(draftKeyboard.rows, 1, "annotation input should default to one row");
  assert.ok(draftKeyboard.sameRow && draftKeyboard.confirmFirst, "input and buttons should share one row with confirm before delete");
  assert.equal(draftKeyboard.shiftPrevented, false, "Shift+Enter should keep native newline behavior");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const confirmed = await win.webContents.executeJavaScript(\`({ draft: Boolean(document.querySelector('.work-panel-image-annotation-draft')), text: document.querySelector('.work-panel-image-annotation-row input')?.value, count: Boolean(document.querySelector('button[aria-label="1 条批注"]')) })\`);
  assert.equal(confirmed.draft, false, "confirm should close the inline draft");
  assert.ok(confirmed.count && confirmed.text.includes('将这个区域改为蓝色'), "only confirmed annotation should enter and open the list");
  await shot("annotate");
  await toolbarClick("1 条批注");
  assert.equal(await win.webContents.executeJavaScript(\`Boolean(document.querySelector('.work-panel-image-annotations'))\`), false, "annotation list should close without leaving annotation mode");
  await toolbarClick("1 条批注");
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-annotation-list > [role="listitem"]').length\`), 1, "count button should reopen the saved annotation list");
  await win.webContents.executeJavaScript(\`window.__originalConfirm = window.confirm; window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return false; }; document.querySelector('button[aria-label="批注修改"]').click()\`);
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelector('button[aria-label="批注修改"]').getAttribute('aria-pressed')\`), "true", "cancel should preserve annotation mode");
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-annotation-row').length\`), 1, "cancel should preserve annotations");
  await win.webContents.executeJavaScript(\`window.confirm = () => { window.__confirmCalls++; return true; }; document.querySelector('button[aria-label="批注修改"]').click()\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await win.webContents.executeJavaScript(\`window.__confirmCalls\`), 2, "leaving with annotations must ask for confirmation");
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-annotation, .work-panel-image-annotations, button[aria-expanded]').length\`), 0, "confirmed exit should clear annotations and hide count/list");
  await win.webContents.executeJavaScript(\`void (window.confirm = window.__originalConfirm)\`);
  const annotationExit = await win.webContents.executeJavaScript(\`({ pressed: document.querySelector('button[aria-label="批注修改"]').getAttribute('aria-pressed'), panDisabled: document.querySelector('button[aria-label="选择 / 平移"]').disabled, transformsDisabled: [...document.querySelectorAll('.work-panel-image-zoom-group button')].some((button) => button.disabled) })\`);
  assert.equal(annotationExit.pressed, "false", "clicking annotation again should exit the mode");
  assert.equal(annotationExit.panDisabled, false, "other tools should recover after leaving annotation mode");
  assert.equal(annotationExit.transformsDisabled, false, "rotate and flip should recover after leaving annotation mode");

  // selection mask still paints on the image-sized layer
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '选区')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const toolbarBefore = await win.webContents.executeJavaScript(\`({ toolbars: document.querySelectorAll('.work-panel-image-selection-toolbar').length, frames: document.querySelectorAll('.work-panel-image-selection-frame').length })\`);
  console.log("selection toolbar before drawing:", JSON.stringify(toolbarBefore));
  assert.equal(toolbarBefore.toolbars, 0, "selection toolbar should stay hidden until a box exists");
  assert.equal(toolbarBefore.frames, 0, "no selection frame should exist before drawing");
  const selectRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  await drag(Math.round(selectRect.x + selectRect.width * 0.25), Math.round(selectRect.y + selectRect.height * 0.4), Math.round(selectRect.x + selectRect.width * 0.6), Math.round(selectRect.y + selectRect.height * 0.7));
  const defaults = await win.webContents.executeJavaScript(\`(() => {
    const pressed = [...document.querySelectorAll('.work-panel-image-selection-toolbar button[aria-pressed="true"]')].map((button) => button.getAttribute('aria-label'));
    const color = document.querySelector('.work-panel-image-selection-color').value;
    return { pressed, color };
  })()\`);
  console.log("selection defaults:", JSON.stringify(defaults));
  assert.ok(defaults.pressed.includes('线') && defaults.pressed.includes('矩形'), "defaults should be line + rectangle");
  assert.equal(defaults.color, '#e60000', "default selection colour should be red");
  await shot("selection-default");

  // selection steps take part in undo/redo
  await toolbarClick("撤销");
  const undoneSelection = await win.webContents.executeJavaScript(\`({ frames: document.querySelectorAll('.work-panel-image-selection-frame').length, toolbars: document.querySelectorAll('.work-panel-image-selection-toolbar').length })\`);
  console.log("undo selection:", JSON.stringify(undoneSelection));
  assert.equal(undoneSelection.frames, 0, "undo should remove the new selection box");
  assert.equal(undoneSelection.toolbars, 0, "undo should hide the toolbar again");
  await toolbarClick("重做");
  const redoneSelection = await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-selection-frame').length\`);
  console.log("redo selection frames:", redoneSelection);
  assert.equal(redoneSelection, 1, "redo should restore the selection box");
  const saveAfterSelection = await win.webContents.executeJavaScript(\`document.querySelector('button[aria-label="保存"]')?.disabled\`);
  console.log("save disabled after selection steps:", saveAfterSelection);
  assert.equal(saveAfterSelection, true, "selection steps must not mark the bitmap dirty");
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '填充')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const maskAlpha = await win.webContents.executeJavaScript(\`(() => {
    const canvas = document.querySelector('.work-panel-image-selection-layer');
    const context = canvas.getContext('2d');
    const data = context.getImageData(Math.floor(canvas.width * 0.4), Math.floor(canvas.height * 0.55), 1, 1).data;
    return data[3];
  })()\`);
  console.log("selection alpha:", maskAlpha);
  assert.ok(maskAlpha > 0, "selection mask should be painted");

  // switching the shape converts the active selection in place
  const sampleShape = () => win.webContents.executeJavaScript(\`(() => {
    const canvas = document.querySelector('.work-panel-image-selection-layer');
    const context = canvas.getContext('2d');
    const corner = context.getImageData(Math.floor(canvas.width * 0.25) + 3, Math.floor(canvas.height * 0.4) + 3, 1, 1).data[3];
    const center = context.getImageData(Math.floor(canvas.width * 0.42), Math.floor(canvas.height * 0.55), 1, 1).data[3];
    const pressed = [...document.querySelectorAll('.work-panel-image-selection-toolbar button[aria-pressed="true"]')].map((button) => button.getAttribute('aria-label'));
    return { corner, center, pressed };
  })()\`);
  const rectShape = await sampleShape();
  console.log("rect selection:", JSON.stringify(rectShape));
  assert.ok(rectShape.corner > 0 && rectShape.center > 0, "rectangle selection should cover the corner");
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '椭圆')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const ellipseShape = await sampleShape();
  console.log("ellipse selection:", JSON.stringify(ellipseShape));
  assert.equal(ellipseShape.corner, 0, "switching to ellipse should clear the rectangle corner");
  assert.ok(ellipseShape.center > 0, "ellipse should still cover the centre");
  assert.ok(ellipseShape.pressed.includes('椭圆'), "ellipse shape button should be active");
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '矩形')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rectAgain = await sampleShape();
  assert.ok(rectAgain.corner > 0, "switching back to rectangle should restore the corner");

  // toolbar is anchored to the selection frame's bottom-right
  const toolbar = await win.webContents.executeJavaScript(\`(() => {
    const frame = document.querySelector('.work-panel-image-selection-frame.is-active')?.getBoundingClientRect();
    const bar = document.querySelector('.work-panel-image-selection-toolbar')?.getBoundingClientRect();
    if (!frame || !bar) return null;
    return { frame: frame.toJSON(), bar: bar.toJSON() };
  })()\`);
  assert.ok(toolbar, "selection toolbar should be rendered");
  assert.ok(toolbar.bar.top >= toolbar.frame.bottom + 4, "selection toolbar should sit outside the box, below it");
  assert.ok(Math.abs(toolbar.bar.right - toolbar.frame.right) <= 2, "selection toolbar should align with the box's right edge");

  const opaqueCount = () => win.webContents.executeJavaScript(\`(() => {
    const display = document.querySelector('.work-panel-image-selection-layer');
    const data = display.getContext('2d').getImageData(0, 0, display.width, display.height).data;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) opaque += 1;
    return opaque;
  })()\`);
  const fillCount = await opaqueCount();
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '线')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const lineCount = await opaqueCount();
  console.log("opaque pixels fill/line:", fillCount, lineCount);
  assert.ok(lineCount > 0 && lineCount < fillCount / 2, "line style should only paint the outline");

  // only rectangle/ellipse shapes and a palette are offered
  const toolbarParts = await win.webContents.executeJavaScript(\`(() => {
    const labels = [...document.querySelectorAll('.work-panel-image-selection-toolbar button')].map((button) => button.getAttribute('aria-label'));
    const dot = document.querySelector('.work-panel-image-selection-toolbar .work-panel-image-selection-dot');
    const palette = document.querySelector('.work-panel-image-selection-palette');
    const color = document.querySelector('.work-panel-image-selection-color');
    return {
      shapes: labels.filter((label) => label === '矩形' || label === '椭圆').length,
      lasso: labels.includes('套索'),
      brush: labels.includes('画笔'),
      palette: document.querySelectorAll('.work-panel-image-selection-palette-color').length,
      dot: dot ? dot.getBoundingClientRect().width : 0,
      sameRow: Boolean(palette && color) && Math.abs(palette.getBoundingClientRect().top - color.getBoundingClientRect().top) < 10 && palette.getBoundingClientRect().left > color.getBoundingClientRect().right,
    };
  })()\`);
  console.log("toolbar parts:", JSON.stringify(toolbarParts));
  assert.equal(toolbarParts.shapes, 2, "only rectangle and ellipse shapes should remain");
  assert.ok(!toolbarParts.lasso && !toolbarParts.brush, "lasso and brush should be gone");
  assert.equal(toolbarParts.palette, 20, "palette should offer 20 colours");
  assert.ok(toolbarParts.dot > 0, "line style should show a size dot instead of a slider");
  assert.ok(toolbarParts.sameRow, "colour swatch and palette should share one row");

  // wheel tunes the line width instead of zooming while line style is active
  const zoomBeforeWheel = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width\`);
  win.webContents.sendInputEvent({ type: "mouseWheel", x: 400, y: 500, deltaX: 0, deltaY: -120, wheelTicksY: -1, canScroll: false, button: "left" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const wheelLine = await win.webContents.executeJavaScript(\`({ dot: document.querySelector('.work-panel-image-selection-toolbar .work-panel-image-selection-dot')?.getBoundingClientRect().width, zoomWidth: document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width, delta: window.__wheelDelta })\`);
  console.log("line wheel:", JSON.stringify(wheelLine), "dot before:", toolbarParts.dot);
  assert.notEqual(wheelLine.dot, toolbarParts.dot, "wheel should resize the line dot");
  assert.ok(Math.abs(wheelLine.zoomWidth - zoomBeforeWheel) < 1, "wheel in line mode should not zoom");

  // Cmd/Ctrl+wheel still zooms without touching the width
  win.webContents.sendInputEvent({ type: "mouseWheel", x: 400, y: 500, deltaX: 0, deltaY: -120, wheelTicksY: -1, canScroll: false, button: "left", modifiers: ["control"] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ctrlWheel = await win.webContents.executeJavaScript(\`({ dot: document.querySelector('.work-panel-image-selection-toolbar .work-panel-image-selection-dot')?.getBoundingClientRect().width, zoomWidth: document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width })\`);
  console.log("ctrl wheel:", JSON.stringify(ctrlWheel));
  assert.equal(ctrlWheel.dot, wheelLine.dot, "ctrl+wheel should leave the line width alone");
  assert.ok(Math.abs(ctrlWheel.zoomWidth - wheelLine.zoomWidth) > 1, "ctrl+wheel should zoom");
  await shot("selection-line");

  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '填充')?.click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const tint = await win.webContents.executeJavaScript(\`(() => {
    const input = document.querySelector('.work-panel-image-selection-color');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '#ff0000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return Boolean(input);
  })()\`);
  assert.ok(tint, "colour input should exist");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const tinted = await win.webContents.executeJavaScript(\`(() => {
    const display = document.querySelector('.work-panel-image-selection-layer');
    const context = display.getContext('2d');
    const pixel = context.getImageData(Math.floor(display.width * 0.42), Math.floor(display.height * 0.55), 1, 1).data;
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  })()\`);
  console.log("tinted pixel:", JSON.stringify(tinted));
  assert.ok(tinted.a > 0 && tinted.r > 200 && tinted.g < 60 && tinted.b < 60, "colour picker should tint the selection");
  await shot("selection");

  // a second selection box can be added; only the active one exposes handles and the toolbar
  const overlayRect2 = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  await drag(Math.round(overlayRect2.x + overlayRect2.width * 0.1), Math.round(overlayRect2.y + overlayRect2.height * 0.1), Math.round(overlayRect2.x + overlayRect2.width * 0.22), Math.round(overlayRect2.y + overlayRect2.height * 0.22));
  const multiple = await win.webContents.executeJavaScript(\`(() => {
    const frames = [...document.querySelectorAll('.work-panel-image-selection-frame')];
    const active = document.querySelector('.work-panel-image-selection-frame.is-active');
    return {
      frames: frames.length,
      activeHandles: active ? active.querySelectorAll(':scope > button').length : 0,
      inactiveHandles: frames.filter((frame) => frame !== active).reduce((sum, frame) => sum + frame.querySelectorAll(':scope > button').length, 0),
      toolbarInActive: Boolean(active?.querySelector('.work-panel-image-selection-toolbar')),
      toolbars: document.querySelectorAll('.work-panel-image-selection-toolbar').length,
    };
  })()\`);
  console.log("multiple selections:", JSON.stringify(multiple));
  assert.equal(multiple.frames, 2, "a second selection box should be created");
  assert.equal(multiple.activeHandles, 8, "the active box should expose 8 handles");
  assert.equal(multiple.inactiveHandles, 0, "inactive boxes should not expose handles");
  assert.equal(multiple.toolbars, 1, "only the active box should host the toolbar");
  assert.ok(multiple.toolbarInActive, "the toolbar should belong to the active box");
  await shot("selections-multiple");

  // each box keeps its own style/colour and the toolbar follows the active box
  await win.webContents.executeJavaScript(\`[...document.querySelectorAll('.work-panel-image-selection-toolbar button')].find((button) => button.getAttribute('aria-label') === '线')?.click()\`);
  await win.webContents.executeJavaScript(\`(() => {
    const input = document.querySelector('.work-panel-image-selection-color');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '#0066ff');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const overlayThird = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  const clickX = Math.round(overlayThird.x + overlayThird.width * 0.42);
  const clickY = Math.round(overlayThird.y + overlayThird.height * 0.55);
  await click(clickX, clickY);
  const perBox = await win.webContents.executeJavaScript(\`(() => {
    const pressed = [...document.querySelectorAll('.work-panel-image-selection-toolbar button[aria-pressed="true"]')].map((button) => button.getAttribute('aria-label'));
    const color = document.querySelector('.work-panel-image-selection-color').value;
    const canvas = document.querySelector('.work-panel-image-selection-layer');
    const context = canvas.getContext('2d');
    const first = context.getImageData(Math.floor(canvas.width * 0.42), Math.floor(canvas.height * 0.55), 1, 1).data;
    const second = context.getImageData(Math.floor(canvas.width * 0.16), Math.floor(canvas.height * 0.16), 1, 1).data;
    return { pressed, color, firstAlpha: first[3], firstRed: first[0], secondAlpha: second[3] };
  })()\`);
  console.log("per-box state:", JSON.stringify(perBox));
  assert.ok(perBox.pressed.includes('填充'), "first box should still be fill style");
  assert.equal(perBox.color, '#ff0000', "toolbar should show the first box's colour");
  assert.ok(perBox.firstAlpha > 0 && perBox.firstRed > 200, "first box keeps its red fill");
  assert.equal(perBox.secondAlpha, 0, "second box switched to line style stays an outline");
  await shot("selection-per-box");

  // re-activate the second box so the next Delete removes it
  await click(Math.round(overlayThird.x + overlayThird.width * 0.16), Math.round(overlayThird.y + overlayThird.height * 0.16));

  const pixelsWithTwo = await opaqueCount();
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-resource-image')?.focus()\`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterFirstDelete = await win.webContents.executeJavaScript(\`({ frames: document.querySelectorAll('.work-panel-image-selection-frame').length, opaque: (() => { const display = document.querySelector('.work-panel-image-selection-layer'); const data = display.getContext('2d').getImageData(0, 0, display.width, display.height).data; let count = 0; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count += 1; return count; })() })\`);
  console.log("after first delete:", JSON.stringify({ frames: afterFirstDelete.frames, opaque: afterFirstDelete.opaque, before: pixelsWithTwo }));
  assert.equal(afterFirstDelete.frames, 1, "Delete should remove only the active box");
  assert.ok(afterFirstDelete.opaque > 0 && afterFirstDelete.opaque < pixelsWithTwo, "the remaining box should stay selected");
  await toolbarClick("撤销");
  const undoneDelete = await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-selection-frame').length\`);
  assert.equal(undoneDelete, 2, "undo should restore the deleted box");
  await toolbarClick("重做");
  const redoneDelete = await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-selection-frame').length\`);
  assert.equal(redoneDelete, 1, "redo should delete the box again");

  // selection frame is resizable and follows the mask
  const frameBefore = await win.webContents.executeJavaScript(\`(() => {
    const frame = document.querySelector('.work-panel-image-selection-frame.is-active');
    const handle = frame?.querySelector(':scope > button.is-se');
    return { frame: frame?.getBoundingClientRect().toJSON(), handle: handle?.getBoundingClientRect().toJSON(), handles: frame ? frame.querySelectorAll(':scope > button').length : 0, active: frame?.classList.contains('is-active') };
  })()\`);
  assert.ok(frameBefore.active, "selection frame should be editable after drawing");
  assert.equal(frameBefore.handles, 8, "selection frame should expose 8 handles");
  const filledCount = await opaqueCount();
  const handleX = Math.round(frameBefore.handle.x + frameBefore.handle.width / 2);
  const handleY = Math.round(frameBefore.handle.y + frameBefore.handle.height / 2);
  await drag(handleX, handleY, handleX + 40, handleY + 30);
  const frameAfter = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-selection-frame').getBoundingClientRect().toJSON()\`);
  const resizedCount = await opaqueCount();
  console.log("frame resize:", JSON.stringify({ w: frameBefore.frame.width, h: frameBefore.frame.height, aw: frameAfter.width, ah: frameAfter.height, filled: filledCount, resized: resizedCount }));
  assert.ok(frameAfter.width > frameBefore.frame.width + 25 && frameAfter.height > frameBefore.frame.height + 15, "dragging a handle should resize the selection frame");
  assert.ok(resizedCount > filledCount, "resizing should repaint the selection mask");

  // resizing is undoable
  await toolbarClick("撤销");
  const undoneResize = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-selection-frame.is-active')?.getBoundingClientRect().toJSON()\`);
  console.log("undo resize:", JSON.stringify({ width: undoneResize?.width, height: undoneResize?.height }));
  assert.ok(
    Math.abs(undoneResize.width - frameBefore.frame.width) <= 2 && Math.abs(undoneResize.height - frameBefore.frame.height) <= 2,
    "undo should restore the selection bounds",
  );
  await toolbarClick("重做");
  const redoneResize = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-selection-frame.is-active')?.getBoundingClientRect().toJSON()\`);
  assert.ok(Math.abs(redoneResize.width - frameAfter.width) <= 2 && Math.abs(redoneResize.height - frameAfter.height) <= 2, "redo should reapply the resize");

  // near the bottom edge the toolbar flips above the box
  const overlayBottomRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  await drag(Math.round(overlayBottomRect.x + overlayBottomRect.width * 0.1), Math.round(overlayBottomRect.y + overlayBottomRect.height * 0.82), Math.round(overlayBottomRect.x + overlayBottomRect.width * 0.3), Math.round(overlayBottomRect.y + overlayBottomRect.height * 0.95));
  const flipped = await win.webContents.executeJavaScript(\`(() => {
    const frame = document.querySelector('.work-panel-image-selection-frame.is-active')?.getBoundingClientRect();
    const bar = document.querySelector('.work-panel-image-selection-toolbar')?.getBoundingClientRect();
    return { frames: document.querySelectorAll('.work-panel-image-selection-frame').length, frame: frame ? frame.toJSON() : null, bar: bar ? bar.toJSON() : null };
  })()\`);
  console.log("flipped toolbar:", JSON.stringify({ frames: flipped.frames, above: flipped.bar && flipped.frame ? flipped.bar.bottom <= flipped.frame.top + 1 : null }));
  assert.equal(flipped.frames, 2, "bottom selection should be added");
  assert.ok(flipped.bar && flipped.frame && flipped.bar.bottom <= flipped.frame.top + 1, "toolbar should flip above the box near the bottom edge");
  // remove it so the remaining flow still starts from one box
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-resource-image')?.focus()\`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 普通选区保留时，擦除必须使用独立区域，入口不能自动请求 AI。
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-zoom-reset').click()\`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const selectionBeforeErase = await opaqueCount();
  assert.ok(selectionBeforeErase > 0, "ordinary selection should exist before entering erase mode");
  const requestsBeforeErase = await win.webContents.executeJavaScript(\`window.fixture.aiRequests.length\`);
  await toolbarClick("擦除对象");
  await waitFor("Boolean(document.querySelector('.work-panel-image-erase-toolbar'))", "erase toolbar");
  const eraseButton = (label) => "[...document.querySelectorAll('.work-panel-image-erase-toolbar button')].find((button) => button.textContent.trim() === " + JSON.stringify(label) + ")";
  const eraseClick = async (label) => {
    assert.equal(await win.webContents.executeJavaScript("Boolean(" + eraseButton(label) + ")"), true, "erase toolbar should contain " + label);
    await win.webContents.executeJavaScript(eraseButton(label) + ".click()");
    await new Promise((resolve) => setTimeout(resolve, 250));
  };
  const eraseDisabled = () => win.webContents.executeJavaScript(eraseButton("擦除") + ".disabled");
  const eraseSnapshot = () => win.webContents.executeJavaScript(\`(() => {
    const canvas = document.querySelector('.work-panel-image-erase-layer');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) opaque += 1;
    return { width: canvas.width, height: canvas.height, opaque, pixels: canvas.toDataURL() };
  })()\`);
  const eraseEntry = await win.webContents.executeJavaScript(\`(() => {
    const bar = document.querySelector('.work-panel-image-erase-toolbar');
    const layer = document.querySelector('.work-panel-image-erase-layer');
    return {
      labels: [...bar.querySelectorAll('button')].map((button) => button.textContent.trim()),
      brush: [...bar.querySelectorAll('button')].find((button) => button.textContent.trim() === '笔触')?.getAttribute('aria-pressed'),
      range: Boolean(bar.querySelector('input[type="range"]')),
      visible: getComputedStyle(layer).visibility,
    };
  })()\`);
  assert.deepEqual(eraseEntry.labels, ["笔触", "矩形", "擦除", "清空", "取消"], "erase mode should offer its own controls");
  assert.equal(eraseEntry.brush, "true", "brush should be active initially");
  assert.equal(eraseEntry.range, false, "brush size must not show a range input");
  assert.equal(eraseEntry.visible, "visible", "independent erase canvas should be visible");
  assert.equal(await eraseDisabled(), true, "ordinary selection must not enable erase confirmation");
  await eraseClick("擦除");
  assert.equal(await win.webContents.executeJavaScript(\`window.fixture.aiRequests.length\`), requestsBeforeErase, "entering erase or clicking disabled confirmation must not invoke AI");
  const eraseEmpty = await eraseSnapshot();
  assert.equal(eraseEmpty.opaque, 0, "ordinary selection must not paint the erase layer");

  // 笔触大小使用原图像素；单击形成圆点，连续拖动形成不间断笔迹。
  const brushBeforeWheel = await win.webContents.executeJavaScript(\`(() => {
    const icon = document.querySelector('.work-panel-image-erase-brush-icon circle');
    return { radius: Number(icon.getAttribute('r')), imageWidth: document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width };
  })()\`);
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -320, bubbles: true, cancelable: true }))\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const brushAfterWheel = await win.webContents.executeJavaScript(\`(() => {
    const icon = document.querySelector('.work-panel-image-erase-brush-icon circle');
    return { radius: Number(icon.getAttribute('r')), title: icon.closest('button').title, imageWidth: document.querySelector('.work-panel-image-canvas').getBoundingClientRect().width };
  })()\`);
  assert.equal(brushAfterWheel.title, "笔触大小: 64px", "wheel should update brush size");
  assert.equal(brushAfterWheel.radius, brushBeforeWheel.radius * 2, "brush dot should grow with brush size");
  assert.equal(brushAfterWheel.imageWidth, brushBeforeWheel.imageWidth, "brush wheel must not zoom the image");
  const eraseRect = await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-image-canvas').getBoundingClientRect().toJSON()\`);
  const erasePoint = (x, y) => ({ x: Math.round(eraseRect.x + eraseRect.width * x), y: Math.round(eraseRect.y + eraseRect.height * y) });
  const dotPoint = erasePoint(0.8, 0.4);
  const strokeStart = erasePoint(0.75, 0.53);
  const strokeEnd = erasePoint(0.9, 0.6);
  const rectangleStart = erasePoint(0.76, 0.72);
  const rectangleEnd = erasePoint(0.9, 0.8);
  await click(dotPoint.x, dotPoint.y);
  const eraseDot = await eraseSnapshot();
  assert.ok(eraseDot.opaque > 2500 && eraseDot.opaque < 4000, "single click should paint a 64px circular dot in image coordinates");
  assert.equal(await eraseDisabled(), false, "a single brush dot should enable confirmation");
  await toolbarClick("撤销");
  assert.equal((await eraseSnapshot()).opaque, 0, "undo should remove only the erase dot");
  assert.equal(await eraseDisabled(), true, "undoing the last erase region should disable confirmation");
  assert.equal(await opaqueCount(), selectionBeforeErase, "erase undo must preserve ordinary selection pixels");
  await toolbarClick("重做");
  assert.deepEqual(await eraseSnapshot(), eraseDot, "redo should restore the exact dot");
  await drag(strokeStart.x, strokeStart.y, strokeEnd.x, strokeEnd.y);
  const eraseStroke = await eraseSnapshot();
  assert.ok(eraseStroke.opaque > eraseDot.opaque, "continuous brush drag should add to the dot");

  // 矩形叠加到笔触上；撤销、重做及清空都只改变擦除历史。
  await eraseClick("矩形");
  assert.equal(await win.webContents.executeJavaScript(eraseButton("矩形") + ".getAttribute('aria-pressed')"), "true", "rectangle should become active");
  await drag(rectangleStart.x, rectangleStart.y, rectangleEnd.x, rectangleEnd.y);
  const eraseCombined = await eraseSnapshot();
  assert.ok(eraseCombined.opaque > eraseStroke.opaque, "rectangle should add to existing brush regions");
  await toolbarClick("撤销");
  assert.deepEqual(await eraseSnapshot(), eraseStroke, "undo rectangle should preserve both brush regions");
  await toolbarClick("重做");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "redo should restore rectangle and brush regions");
  // 再次点击入口退出，重新进入仍保留区域；创建另一区域后重选旧矩形。
  await toolbarClick("擦除对象");
  assert.equal(await win.webContents.executeJavaScript("Boolean(document.querySelector('.work-panel-image-erase-toolbar'))"), false, "second entry click should exit erase mode");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.work-panel-image-canvas').classList.contains('is-pannable')"), true, "exiting erase should return to pan");
  await toolbarClick("擦除对象");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "reentering erase should preserve regions");
  const secondStart = erasePoint(0.56, 0.72);
  const secondEnd = erasePoint(0.66, 0.8);
  await drag(secondStart.x, secondStart.y, secondEnd.x, secondEnd.y);
  const twoRectangles = await eraseSnapshot();
  await click(Math.round((rectangleStart.x + rectangleEnd.x) / 2), Math.round((rectangleStart.y + rectangleEnd.y) / 2));
  const oldFrame = await win.webContents.executeJavaScript(\`(() => {
    const frame = document.querySelector('.work-panel-image-erase-frame');
    const rect = frame.getBoundingClientRect();
    const handles = frame.querySelectorAll('button');
    const handle = frame.querySelector('button.is-se').getBoundingClientRect();
    return { active: frame.classList.contains('is-active'), handles: handles.length, width: rect.width, height: rect.height, x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2) };
  })()\`);
  assert.equal(oldFrame.active, true, "click should reselect an earlier rectangle");
  assert.equal(oldFrame.handles, 8, "selected rectangle should show eight resize handles");
  assert.deepEqual(await eraseSnapshot(), twoRectangles, "reselection alone must not alter the mask");
  await drag(oldFrame.x, oldFrame.y, oldFrame.x + 20, oldFrame.y + 16);
  const resizedFrame = await win.webContents.executeJavaScript("document.querySelector('.work-panel-image-erase-frame').getBoundingClientRect().toJSON()");
  assert.ok(resizedFrame.width > oldFrame.width + 15 && resizedFrame.height > oldFrame.height + 10, "earlier rectangle handles should resize its bounds");
  const resizedMask = await eraseSnapshot();
  assert.ok(resizedMask.opaque > twoRectangles.opaque, "resizing should update the erase mask");
  await toolbarClick("撤销");
  assert.deepEqual(await eraseSnapshot(), twoRectangles, "one undo should revert the entire resize drag");
  await toolbarClick("重做");
  assert.deepEqual(await eraseSnapshot(), resizedMask, "redo should restore resized mask");
  await shot("erase-rectangle-resized");
  await toolbarClick("撤销");
  await toolbarClick("撤销");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "undo resize then second rectangle should restore the initial mask");
  await eraseClick("清空");
  assert.equal((await eraseSnapshot()).opaque, 0, "clear should remove every erase region");
  assert.equal(await eraseDisabled(), true, "clear should disable confirmation despite ordinary selection");
  assert.equal(await opaqueCount(), selectionBeforeErase, "clear erase regions must not clear ordinary selections");
  await toolbarClick("撤销");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "undo clear should restore all erase regions");
  await toolbarClick("重做");
  assert.equal((await eraseSnapshot()).opaque, 0, "redo clear should empty the erase layer again");
  await toolbarClick("撤销");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "undo clear again should prepare the same mask for submission");
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelector('button[aria-label="保存"]').disabled\`), true, "erase region history must not mark the bitmap dirty");
  assert.equal(await win.webContents.executeJavaScript(\`window.fixture.aiRequests.length\`), requestsBeforeErase, "drawing, clear and history must not submit AI automatically");

  // 拦截请求并解码真实 PNG 掩码，逐点核对普通选区、笔触、矩形及背景。
  await win.webContents.executeJavaScript(\`window.fixture.aiResponse = { ok: false, message: '擦除回归模拟失败' }\`);
  await eraseClick("擦除");
  await waitFor("window.fixture.aiRequests.length === " + (requestsBeforeErase + 1) + " && Boolean(document.querySelector('.work-panel-image-erase-toolbar')) && !document.querySelector('.work-panel-image-erase-toolbar .is-ai-action').disabled", "failed erase request recovery");
  const maskCheck = await win.webContents.executeJavaScript(\`(async () => {
    const request = window.fixture.aiRequests[\${requestsBeforeErase}];
    const decode = async (base64) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      return image;
    };
    const [mask, source, original] = await Promise.all([decode(request.maskDataBase64), decode(request.sourceDataBase64), decode(window.__IMAGE_BASE64__)]);
    const canvas = document.createElement('canvas');
    canvas.width = mask.naturalWidth;
    canvas.height = mask.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(mask, 0, 0);
    const pixel = (x, y) => Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    const fromScreen = (point) => ({ x: (point.x - \${eraseRect.x}) * canvas.width / \${eraseRect.width}, y: (point.y - \${eraseRect.y}) * canvas.height / \${eraseRect.height} });
    const dot = fromScreen(\${JSON.stringify(dotPoint)});
    const start = fromScreen(\${JSON.stringify(strokeStart)});
    const end = fromScreen(\${JSON.stringify(strokeEnd)});
    return {
      operation: request.operation,
      requestSize: [request.width, request.height],
      maskSize: [mask.naturalWidth, mask.naturalHeight],
      sourceSize: [source.naturalWidth, source.naturalHeight],
      originalSize: [original.naturalWidth, original.naturalHeight],
      ordinarySelection: pixel(canvas.width * 0.42, canvas.height * 0.55),
      dot: pixel(dot.x, dot.y),
      dotInside: pixel(dot.x + 24, dot.y),
      dotOutside: pixel(dot.x + 40, dot.y),
      stroke: [0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) => pixel(start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction)),
      rectangle: pixel(canvas.width * 0.83, canvas.height * 0.76),
      background: pixel(canvas.width * 0.95, canvas.height * 0.9),
    };
  })()\`);
  assert.equal(maskCheck.operation, "removeObject", "confirmation should request object removal");
  for (const size of [maskCheck.requestSize, maskCheck.maskSize, maskCheck.sourceSize, [eraseEmpty.width, eraseEmpty.height]]) {
    assert.deepEqual(size, maskCheck.originalSize, "request, source, mask and erase canvas must use original image dimensions");
  }
  const black = [0, 0, 0, 255];
  const white = [255, 255, 255, 255];
  assert.deepEqual(maskCheck.ordinarySelection, black, "ordinary selection must remain black in AI mask");
  assert.deepEqual(maskCheck.dot, white, "single-click brush dot should be white");
  assert.deepEqual(maskCheck.dotInside, white, "brush radius should use original image pixels");
  assert.deepEqual(maskCheck.dotOutside, black, "pixels outside the brush radius should stay black");
  for (const pixel of maskCheck.stroke) assert.deepEqual(pixel, white, "dragged brush path must remain continuously white");
  assert.deepEqual(maskCheck.rectangle, white, "rectangle should be white alongside brush regions");
  assert.deepEqual(maskCheck.background, black, "unpainted background should remain opaque black");
  assert.deepEqual(await eraseSnapshot(), eraseCombined, "failed AI request should preserve all erase regions for retry");
  assert.equal(await opaqueCount(), selectionBeforeErase, "failed erase should preserve ordinary selections");
  assert.equal(await win.webContents.executeJavaScript(\`document.body.textContent.includes('擦除回归模拟失败')\`), true, "failed response should display its reason");
  await shot("erase-failed-regions");

  // 取消擦除并返回选区，后续原有删除回归继续使用同一个普通选区。
  await eraseClick("取消");
  assert.equal(await win.webContents.executeJavaScript(\`Boolean(document.querySelector('.work-panel-image-erase-toolbar'))\`), false, "cancel should leave erase mode");
  await toolbarClick("选区");
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.work-panel-image-selection-frame').length\`), 1, "returning to selection should restore the existing frame");
  assert.equal(await opaqueCount(), selectionBeforeErase, "cancel must preserve ordinary selection pixels");
  assert.equal(await win.webContents.executeJavaScript(\`window.fixture.aiRequests.length\`), requestsBeforeErase + 1, "only explicit erase confirmation should invoke AI");

  // Delete removes the selection
  await win.webContents.executeJavaScript(\`document.querySelector('.work-panel-resource-image')?.focus()\`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const cleared = await win.webContents.executeJavaScript(\`({ active: Boolean(document.querySelector('.work-panel-image-selection-frame')), opaque: (() => { const display = document.querySelector('.work-panel-image-selection-layer'); const data = display.getContext('2d').getImageData(0, 0, display.width, display.height).data; let count = 0; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count += 1; return count; })() })\`);
  console.log("after delete:", JSON.stringify(cleared));
  assert.ok(!cleared.active && cleared.opaque === 0, "Delete should remove the selection");
  await shot("selection-cleared");

  assert.deepEqual(errors, [], "renderer should not log errors");
  app.exit(0);
});
setTimeout(() => { console.error("SMOKE_TIMEOUT"); process.exit(1); }, 90000);
`);

const electron = path.join(repo, "node_modules/.bin/electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", runner], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => {
  console.log("screenshots:", output);
  process.exit(code ?? 0);
});
