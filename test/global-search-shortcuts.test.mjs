import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isWorkPanelCloseShortcut,
  resolveGlobalSearchCommandShortcut,
} = require("../dist-electron/main/platform-adapter.js");

function keyDown(key, overrides = {}) {
  return {
    type: "keyDown",
    key,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

test("global search command shortcuts map macOS Command actions and Option agent slots", () => {
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("n", { meta: true })),
    { kind: "action", actionId: "newChat" },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("A", { meta: true })),
    { kind: "action", actionId: "agents" },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("s", { meta: true })),
    { kind: "action", actionId: "skills" },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("m", { meta: true })),
    { kind: "action", actionId: "mcpConnectors" },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("2", { meta: true })),
    { kind: "attention", slot: 2 },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("£", { alt: true, code: "Digit3" })),
    { kind: "agent", slot: 3 },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("0", { meta: true })),
    { kind: "attention", slot: 10 },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("darwin", keyDown("º", { alt: true, code: "Digit0" })),
    { kind: "agent", slot: 10 },
  );
});

test("global search agent slots use physical digit codes for macOS Option characters", () => {
  const optionCharacters = ["¡", "™", "£", "¢", "∞", "§", "¶", "•", "ª", "º"];
  for (const [index, key] of optionCharacters.entries()) {
    const digit = String((index + 1) % 10);
    const slot = index === 9 ? 10 : index + 1;
    assert.deepEqual(
      resolveGlobalSearchCommandShortcut("darwin", keyDown(key, { alt: true, code: `Digit${digit}` })),
      { kind: "agent", slot },
    );
  }
});

test("global search command shortcuts map Windows Ctrl actions and Alt agent slots", () => {
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("win32", keyDown("1", { control: true })),
    { kind: "attention", slot: 1 },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("win32", keyDown("2", { alt: true })),
    { kind: "agent", slot: 2 },
  );
  assert.deepEqual(
    resolveGlobalSearchCommandShortcut("win32", keyDown("m", { control: true })),
    { kind: "action", actionId: "mcpConnectors" },
  );
});

test("global search command shortcuts reject unsupported or inexact combinations", () => {
  assert.equal(resolveGlobalSearchCommandShortcut("linux", keyDown("n", { control: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("darwin", keyDown("-", { meta: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("darwin", keyDown("n", { meta: true, shift: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("darwin", keyDown("n", { meta: true, control: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("darwin", keyDown("2", { meta: true, alt: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("win32", keyDown("a", { control: true, meta: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("win32", keyDown("a", { control: true, isAutoRepeat: true })), null);
  assert.equal(resolveGlobalSearchCommandShortcut("win32", { ...keyDown("a", { control: true }), type: "keyUp" }), null);
});

test("WorkPanel close shortcut uses exact platform modifiers and keyDown only", () => {
  assert.equal(isWorkPanelCloseShortcut("darwin", keyDown("w", { meta: true })), true);
  assert.equal(isWorkPanelCloseShortcut("win32", keyDown("W", { control: true })), true);
  assert.equal(isWorkPanelCloseShortcut("linux", keyDown("w", { control: true })), false);
  assert.equal(isWorkPanelCloseShortcut("darwin", keyDown("w", { meta: true, shift: true })), false);
  assert.equal(isWorkPanelCloseShortcut("win32", keyDown("w", { control: true, alt: true })), false);
  assert.equal(isWorkPanelCloseShortcut("darwin", keyDown("w", { meta: true, isAutoRepeat: true })), false);
  assert.equal(
    isWorkPanelCloseShortcut("win32", { ...keyDown("w", { control: true }), type: "keyUp" }),
    false,
  );
});
