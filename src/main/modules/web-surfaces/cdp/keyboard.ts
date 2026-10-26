import type { SurfacePressKey } from "./observation-params";

type Send = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
type KeyDefinition = { key: string; code: string; keyCode: number; text?: string };

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8.
const SHIFT = 8;
const CONTROL = 2;
const META = 4;

const keys: Record<Exclude<SurfacePressKey, "Shift+Tab" | "ControlOrMeta+A">, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function selectAllModifier() {
  // Select-all uses Command on macOS and Control on Windows (and Linux test hosts).
  if (isMac) return META;
  if (isWindows) return CONTROL;
  return CONTROL;
}

async function dispatchKey(send: Send, definition: KeyDefinition, modifiers: number, timeoutMs: number, commands?: string[]) {
  const text = modifiers & (CONTROL | META) ? undefined : definition.text;
  const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers };
  await send("Input.dispatchKeyEvent", {
    ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}),
  }, timeoutMs);
  // Always release the key that was pressed, even when the page reacts slowly.
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, Math.max(timeoutMs, 1000));
}

/** Presses one allowed key on whatever currently owns focus in the guest. Never repeats a press. */
export async function pressSurfaceKey(send: Send, combo: SurfacePressKey, timeoutMs: number) {
  if (combo === "Shift+Tab") return dispatchKey(send, keys.Tab, SHIFT, timeoutMs);
  if (combo === "ControlOrMeta+A") {
    // The editing command makes select-all independent of the platform's menu accelerator.
    return dispatchKey(send, { key: "a", code: "KeyA", keyCode: 65 }, selectAllModifier(), timeoutMs, ["selectAll"]);
  }
  return dispatchKey(send, keys[combo], 0, timeoutMs);
}

/** Types text one character at a time so pages receive real key events, unlike fill. */
export async function typeSurfaceText(send: Send, text: string, check: () => Promise<void>, remainingMs: () => number) {
  for (const character of text) {
    await check();
    if (character === "\n" || character === "\r") {
      await dispatchKey(send, keys.Enter, 0, remainingMs());
      continue;
    }
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, unmodifiedText: character }, remainingMs());
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: character }, Math.max(remainingMs(), 1000));
  }
}
