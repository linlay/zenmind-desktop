import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/renderer/copilot/pet-copilot/desktopPetHitTest.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { createDesktopPetAlphaMask, desktopPetMaskContainsPoint, pointIntersectsDesktopPetImage } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const require = createRequire(import.meta.url);
const { applyDesktopPetMouseInteractivity } = require("../dist-electron/main/modules/pet/window.js");

function createMask(frameCount = 2) {
  const width = 12 * frameCount;
  const pixels = new Uint8ClampedArray(width * 10 * 4);
  pixels[(4 * width + 3) * 4 + 3] = 255;
  if (frameCount > 1) pixels[(4 * width + 12 + 8) * 4 + 3] = 255;
  pixels[(8 * width + 8) * 4 + 3] = 12; // Faint shadow, not the character.
  return createDesktopPetAlphaMask(pixels, width, 10, frameCount);
}

test("pet hit testing passes clicks through transparent padding and faint shadows", () => {
  const mask = createMask();
  assert.equal(desktopPetMaskContainsPoint(mask, 3, 4, 0), true);
  assert.equal(desktopPetMaskContainsPoint(mask, 4, 4, 0), true);
  assert.equal(desktopPetMaskContainsPoint(mask, 5, 4, 0), false);
  assert.equal(desktopPetMaskContainsPoint(mask, 8, 8, 0), false);
  assert.equal(desktopPetMaskContainsPoint(mask, 0, 0, 0), false);
});

test("pet hit testing uses the displayed animation frame, including its final hold", () => {
  const mask = createMask();
  assert.equal(desktopPetMaskContainsPoint(mask, 3, 4, 1), false);
  assert.equal(desktopPetMaskContainsPoint(mask, 8, 4, 1), true);
  assert.equal(desktopPetMaskContainsPoint(mask, 8, 4, 2), true);
  assert.equal(desktopPetMaskContainsPoint(mask, 3, 4, 2), false);
});

test("mirrored pets keep their hit area on the visible character", () => {
  const mask = createMask();
  assert.equal(desktopPetMaskContainsPoint(mask, 3, 4, 0, true), false);
  assert.equal(desktopPetMaskContainsPoint(mask, 8, 4, 0, true), true);
});

test("hit tolerance does not wrap around atlas rows or into adjacent frames", () => {
  const pixels = new Uint8ClampedArray(24 * 10 * 4);
  pixels[(4 * 24 + 12) * 4 + 3] = 255;
  const mask = createDesktopPetAlphaMask(pixels, 24, 10, 2);
  for (const [x, y] of [[11, 4], [-1, 4], [12, 4], [3, -1], [3, 10]]) {
    assert.equal(desktopPetMaskContainsPoint(mask, x, y, 0), false);
  }
});

test("rendered hit testing maps scaled image coordinates and ignores hidden images", (t) => {
  const originalStyle = globalThis.getComputedStyle;
  const originalMatrix = globalThis.DOMMatrixReadOnly;
  globalThis.getComputedStyle = () => ({ transform: "none", backgroundPositionX: "-24px" });
  globalThis.DOMMatrixReadOnly = class { a = 1; };
  t.after(() => {
    if (originalStyle) globalThis.getComputedStyle = originalStyle;
    else delete globalThis.getComputedStyle;
    if (originalMatrix) globalThis.DOMMatrixReadOnly = originalMatrix;
    else delete globalThis.DOMMatrixReadOnly;
  });
  const element = {
    offsetWidth: 24,
    getBoundingClientRect: () => ({ left: 100, right: 124, top: 200, bottom: 220, width: 24, height: 20 })
  };
  const mask = createMask();
  assert.equal(pointIntersectsDesktopPetImage(element, mask, 116, 208), true);
  assert.equal(pointIntersectsDesktopPetImage(element, mask, 106, 208), false);
  assert.equal(pointIntersectsDesktopPetImage(element, null, 100, 200), true);
  assert.equal(pointIntersectsDesktopPetImage(element, null, 99, 200), false);
  element.getBoundingClientRect = () => ({ left: 100, right: 100, top: 200, bottom: 200, width: 0, height: 0 });
  assert.equal(pointIntersectsDesktopPetImage(element, mask, 100, 200), false);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} forwards movement while transparent areas pass clicks through`, () => {
    const calls = [];
    const window = { setIgnoreMouseEvents: (...args) => calls.push(args) };
    applyDesktopPetMouseInteractivity(window, platform, false);
    applyDesktopPetMouseInteractivity(window, platform, true);
    applyDesktopPetMouseInteractivity(window, platform, false);
    assert.deepEqual(calls, [
      [true, { forward: true }],
      [false, { forward: true }],
      [true, { forward: true }]
    ]);
  });
}
