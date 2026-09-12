import type { BrowserWindow, Rectangle } from "electron";

export type WindowLayer = "normal" | "desktop";
type Attachment = { dispose(): void; focus(): void; verify(): void; getBounds?(): Rectangle; setBounds?(bounds: Rectangle): void };

/** Only native handles obtained from host-owned windows enter this adapter. */
export function attachDesktopLayer(window: BrowserWindow, platform = process.platform): Attachment {
  const handle = window.getNativeWindowHandle().readBigUInt64LE();
  if (platform === "darwin") {
    const koffi = require("koffi") as typeof import("koffi");
    const objc = koffi.load("/usr/lib/libobjc.A.dylib");
    const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
    const selector = objc.func("void *sel_registerName(const char *name)");
    const object = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
    const integer = objc.func("objc_msgSend", "long", ["void *", "void *"]);
    const setInteger = objc.func("objc_msgSend", "void", ["void *", "void *", "long"]);
    const levelForKey = cg.func("int CGWindowLevelForKey(int key)");
    const nativeWindow = object(handle, selector("window"));
    // A normal, editable NSWindow above desktop icons, below ordinary applications.
    // Electron's type:'desktop' deliberately disables keyboard/mouse interaction.
    const level = levelForKey(18) + 1; // kCGDesktopIconWindowLevelKey
    const oldBehavior = Number(integer(nativeWindow, selector("collectionBehavior")));
    setInteger(nativeWindow, selector("setLevel:"), level);
    // canJoinAllSpaces | stationary | ignoresCycle: stay when Show Desktop is used.
    setInteger(nativeWindow, selector("setCollectionBehavior:"), 1 | 16 | 64);
    return {
      focus() { window.focus(); },
      verify() {
        if (Number(integer(nativeWindow, selector("level"))) !== level) throw new Error("desktop window level was changed by the system");
      },
      dispose() {
        if (!window.isDestroyed()) {
          setInteger(nativeWindow, selector("setLevel:"), 0);
          setInteger(nativeWindow, selector("setCollectionBehavior:"), oldBehavior);
        }
      }
    };
  }
  if (platform === "win32") return attachWindowsDesktop(window, handle);
  throw new Error("desktop window layer is unsupported on this platform");
}

function attachWindowsDesktop(window: BrowserWindow, handle: bigint): Attachment {
  const koffi = require("koffi") as typeof import("koffi");
  const user = koffi.load("user32.dll");
  const kernel = koffi.load("kernel32.dll");
  const find = user.func("void * __stdcall FindWindowExW(void *parent, void *after, str16 className, str16 title)");
  const parent = user.func("void * __stdcall GetParent(void *window)");
  const setParent = user.func("void * __stdcall SetParent(void *window, void *parent)");
  const getStyle = user.func("intptr_t __stdcall GetWindowLongPtrW(void *window, int index)");
  const setStyle = user.func("intptr_t __stdcall SetWindowLongPtrW(void *window, int index, intptr_t value)");
  const isWindow = user.func("int __stdcall IsWindow(void *window)");
  const setPosition = user.func("int __stdcall SetWindowPos(void *window, void *after, int x, int y, int width, int height, uint32 flags)");
  const setError = kernel.func("void __stdcall SetLastError(uint32 error)");
  const getError = kernel.func("uint32 __stdcall GetLastError()");
  // Attach alongside Explorer's icon view, not its wallpaper surface (which cannot
  // receive input through the icon view). No undocumented shell messages are sent.
  let host: bigint | null = null;
  let next: bigint | null = null;
  while ((next = find(null, next, null, null))) {
    if (find(next, null, "SHELLDLL_DefView", null)) { host = next; break; }
  }
  if (!host) throw new Error("desktop layer unavailable: Explorer desktop host was not found");
  const { screen } = require("electron") as typeof import("electron");
  const originalBounds = window.getBounds();
  const originalPhysical = screen.dipToScreenRect(window, originalBounds);
  const originalParent = parent(handle);
  const originalStyle = BigInt(getStyle(handle, -16));
  setError(0);
  setStyle(handle, -16, (originalStyle & ~0x80000000n) | 0x40000000n); // WS_POPUP -> WS_CHILD
  if (getError()) throw new Error("desktop window style could not be applied");
  setError(0);
  setParent(handle, host);
  const error = getError();
  if (error) {
    setStyle(handle, -16, originalStyle);
    throw new Error(`desktop attachment failed (${error}); check desktop availability and DPI compatibility`);
  }
  // Preserve the actual native rectangle while converting screen to parent space.
  const rectType = koffi.struct({ left: "long", top: "long", right: "long", bottom: "long" });
  const getRect = user.func("GetWindowRect", "int", ["void *", koffi.out(koffi.pointer(rectType))]);
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  getRect(host, rect);
  const physical = originalPhysical;
  if (!setPosition(handle, 0n, physical.x - rect.left, physical.y - rect.top, physical.width, physical.height, 0x0030)) {
    setParent(handle, originalParent); setStyle(handle, -16, originalStyle);
    throw new Error("desktop window positioning failed");
  }
  return {
    focus() { window.webContents.focus(); },
    getBounds() {
      const native = { left: 0, top: 0, right: 0, bottom: 0 };
      if (!getRect(handle, native)) throw new Error("cannot read desktop window rectangle");
      return screen.screenToDipRect(window, { x: native.left, y: native.top, width: native.right - native.left, height: native.bottom - native.top });
    },
    setBounds(bounds) {
      const physical = screen.dipToScreenRect(window, bounds);
      if (!getRect(host, rect) || !setPosition(handle, 0n, physical.x - rect.left, physical.y - rect.top, physical.width, physical.height, 0x0010)) {
        throw new Error("cannot move desktop window");
      }
    },
    verify() {
      if (!isWindow(host) || parent(handle) !== host) throw new Error("desktop host was lost; recreate the window after Explorer is available");
    },
    dispose() {
      if (!window.isDestroyed()) {
        setParent(handle, originalParent); setStyle(handle, -16, originalStyle);
      }
    }
  };
}
