import type { BrowserWindow } from "electron";

type NativePointer = bigint | null;
type Frame = { x: number; y: number; width: number; height: number };
type NativeWindow = Pick<BrowserWindow, "getNativeWindowHandle" | "getWindowButtonPosition" | "setWindowButtonPosition" |
  "isDestroyed" | "isFullScreen" | "isResizable"> &
  Pick<NodeJS.EventEmitter, "on" | "off" | "once">;
let nativeLayout: ((handle: Buffer, gap: number, centerX: number) => number | undefined) | undefined;

function getNativeLayout() {
  if (nativeLayout) return nativeLayout;
  const koffi = require("koffi") as typeof import("koffi");
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  const selector = objc.func("void *sel_registerName(const char *name)");
  const object = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const button = objc.func("objc_msgSend", "void *", ["void *", "void *", "ulong"]);
  const point = koffi.struct({ x: "double", y: "double" });
  const rect = koffi.struct({ x: "double", y: "double", width: "double", height: "double" });
  const setOrigin = objc.func("objc_msgSend", "void", ["void *", "void *", point]);
  let getFrame: (view: NativePointer) => Frame;
  if (process.arch === "arm64") {
    const frame = objc.func("objc_msgSend", rect, ["void *", "void *"]);
    getFrame = (view) => frame(view, selector("frame"));
  } else if (process.arch === "x64") {
    // Intel returns a 32-byte NSRect through a hidden output pointer. Calling
    // ordinary objc_msgSend here would corrupt the call; arm64 has no _stret.
    const frame = objc.func("objc_msgSend_stret", "void", [koffi.out(koffi.pointer(rect)), "void *", "void *"]);
    getFrame = (view) => {
      const result: Frame = { x: 0, y: 0, width: 0, height: 0 };
      frame(result, view, selector("frame"));
      return result;
    };
  } else {
    throw new Error(`Unsupported macOS window architecture: ${process.arch}`);
  }
  const selectors = { window: selector("window"), button: selector("standardWindowButton:"),
    parent: selector("superview"), origin: selector("setFrameOrigin:") };

  nativeLayout = (handle, gap, centerX) => {
    // Borrow fresh pointers on every layout; AppKit may recreate titlebar views.
    const window = object(handle.readBigUInt64LE(), selectors.window);
    if (!window) return;
    const buttons: NativePointer[] = [0, 1, 2].map((kind) => button(window, selectors.button, kind));
    if (buttons.some((value) => !value)) return;
    const parents = buttons.map((value) => object(value, selectors.parent));
    if (!parents[0] || parents.some((value) => value !== parents[0])) return;
    const frames = buttons.map(getFrame);
    if (frames.some((frame) => !Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)) return;
    const width = frames.reduce((sum, frame) => sum + frame.width, 0) + gap * 2;
    const left = centerX - width / 2;
    let x = left;
    if (x < 0 || x + width > getFrame(parents[0]).width) return;
    for (const [index, value] of buttons.entries()) {
      const frame = frames[index];
      // Preserve native sizes, vertical inset, targets, actions and hover UI.
      if (frame.x !== x) setOrigin(value, selectors.origin, { x, y: frame.y });
      x += frame.width + gap;
    }
    return left;
  };
  return nativeLayout;
}

/** Main-process only: accepts a host-owned window, never a renderer pointer. */
export function attachMacTrafficLightLayout(window: NativeWindow, options: {
  platform: NodeJS.Platform;
  gap: number;
  centerX: number;
  onError(error: unknown): void;
}): () => void {
  // Windows keeps renderer-owned controls and must never load AppKit bindings.
  if (options.platform !== "darwin") return () => {};
  const { nativeTheme } = require("electron") as typeof import("electron");
  let disposed = false;
  let reportedError = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  function apply() {
    // Electron reports isResizable() false during native fullscreen transitions,
    // including the interval before isFullScreen() reflects the new state.
    if (disposed || window.isDestroyed() || window.isFullScreen() || !window.isResizable()) return;
    try {
      const layout = getNativeLayout();
      const left = layout(window.getNativeWindowHandle(), options.gap, options.centerX);
      const position = window.getWindowButtonPosition();
      // Electron's theme redraw restores its configured margin. Keep that
      // margin aligned with our measured group, preserving its vertical inset.
      if (left !== undefined && position && position.x !== left) {
        window.setWindowButtonPosition({ x: left, y: position.y });
        layout(window.getNativeWindowHandle(), options.gap, options.centerX);
      }
    } catch (error) {
      // A cosmetic failure leaves the system controls usable at native spacing.
      if (!reportedError) options.onError(error);
      reportedError = true;
    }
  }
  function cancelPending() {
    if (pending) clearTimeout(pending);
    pending = undefined;
  }
  function refresh() {
    apply();
    if (disposed || pending || window.isDestroyed() || window.isFullScreen() || !window.isResizable()) return;
    // Electron posts native theme redraws after the JS event. Allow that AppKit
    // pass to finish before correcting its configured left margin once more.
    pending = setTimeout(() => { pending = undefined; apply(); }, 32);
  }
  const events = ["ready-to-show", "show", "resize", "restore", "maximize", "unmaximize", "focus",
    "enter-full-screen", "leave-full-screen"] as const;
  for (const event of events) window.on(event, refresh);
  nativeTheme.on("updated", refresh);
  function dispose() {
    disposed = true;
    cancelPending();
    for (const event of events) window.off(event, refresh);
    nativeTheme.off("updated", refresh);
    window.off("closed", dispose);
  }
  window.once("closed", dispose);
  refresh();
  return dispose;
}
