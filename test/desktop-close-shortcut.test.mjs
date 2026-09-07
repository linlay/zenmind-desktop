import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/renderer/services/desktopCloseShortcutRegistry.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { registerDesktopCloseShortcutHandler, dispatchDesktopCloseShortcut } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("a handled close consumes the command even when a guard refuses to remove the tab", (t) => {
  const calls = [];
  t.after(registerDesktopCloseShortcutHandler(() => { calls.push("inactive"); return false; }));
  t.after(registerDesktopCloseShortcutHandler(() => { calls.push("guarded"); return true; }));
  t.after(registerDesktopCloseShortcutHandler(() => { calls.push("wrong layer"); return true; }));
  dispatchDesktopCloseShortcut({ guestId: null, fallbackToWindowClose: true });
  assert.deepEqual(calls, ["inactive", "guarded"]);
});

test("only an unhandled main renderer close may fall back to closing the window", (t) => {
  const previousWindow = globalThis.window;
  let closed = 0;
  globalThis.window = { electronAPI: { desktopShell: { requestWindowClose: () => { closed++; } } } };
  t.after(() => { globalThis.window = previousWindow; });
  dispatchDesktopCloseShortcut({ guestId: 42, fallbackToWindowClose: true });
  dispatchDesktopCloseShortcut({ guestId: null, website: { surfaceId: "site:a", registrationId: "old" }, fallbackToWindowClose: true });
  dispatchDesktopCloseShortcut({ guestId: null });
  assert.equal(closed, 0);
  dispatchDesktopCloseShortcut({ guestId: null, fallbackToWindowClose: true });
  assert.equal(closed, 1);
});

test("unmounted hosts stop receiving subsequent close commands", () => {
  let calls = 0;
  const dispose = registerDesktopCloseShortcutHandler(() => { calls++; return true; });
  dispatchDesktopCloseShortcut({ guestId: 42 });
  dispose();
  dispatchDesktopCloseShortcut({ guestId: 42 });
  assert.equal(calls, 1);
});
