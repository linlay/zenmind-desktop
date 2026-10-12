import { ipcRenderer } from "electron";
import type { DesktopHistoryGestureProgress } from "../shared/contracts/desktop-api";
import { DESKTOP_HISTORY_GESTURE_CHANNEL, DESKTOP_HISTORY_GESTURE_IDLE_MS, DESKTOP_HISTORY_GESTURE_THRESHOLD } from "../shared/desktop-history-gesture";

function keepsHorizontalScroll(event: WheelEvent) {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (node.matches("input,textarea,select,canvas,[contenteditable],[role=slider],[role=dialog]")) return true;
    const style = window.getComputedStyle(node);
    if (node.scrollWidth > node.clientWidth + 1 &&
        (node === document.scrollingElement || /^(auto|scroll|overlay)$/.test(style.overflowX))) return true;
  }
  return false;
}

export function createDesktopHistoryWheelHandler(
  sendSample: (progress: DesktopHistoryGestureProgress | null) => void,
) {
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let horizontal = 0;
  let vertical = 0;
  let samples = 0;
  let blocked = false;
  let consumed = false;
  let previewing = false;
  return (event: WheelEvent, now = performance.now()) => {
    // Pixel scrolling is the macOS two-finger trackpad path. Ignore wheel notches,
    // modified scrolling/pinching and synthetic page events. Do not filter on
    // cancelable: a sequence may have only its first sample cancelable, or no
    // cancelable samples with a passive listener. Both still carry valid input.
    if (!event.isTrusted || event.deltaMode !== 0 || event.ctrlKey || event.metaKey ||
        event.altKey || event.shiftKey ||
        !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return;
    if (now - lastSampleAt > DESKTOP_HISTORY_GESTURE_IDLE_MS) {
      horizontal = 0;
      vertical = 0;
      samples = 0;
      consumed = false;
      previewing = false;
      blocked = keepsHorizontalScroll(event);
    }
    lastSampleAt = now;
    horizontal += event.deltaX;
    vertical += Math.abs(event.deltaY);
    samples += 1;
    if (vertical >= 8 && vertical > Math.abs(horizontal)) blocked = true;
    if (blocked || Math.abs(horizontal) < 1 || Math.abs(horizontal) < vertical * 1.7) {
      if (previewing && !consumed) {
        previewing = false;
        sendSample(null);
      }
      return;
    }
    const committed = !consumed && samples >= 2 && Math.abs(horizontal) >= DESKTOP_HISTORY_GESTURE_THRESHOLD;
    if (committed) consumed = true;
    previewing = true;
    // Samples keep a window-wide gesture alive across host/guest route switches.
    sendSample({
      direction: horizontal < 0 ? "back" : "forward",
      progress: Math.min(1, Math.abs(horizontal) / DESKTOP_HISTORY_GESTURE_THRESHOLD),
      committed,
    });
  };
}

export function installDesktopHistoryGesture() {
  if (process.platform !== "darwin" || !process.isMainFrame) return;
  window.addEventListener("wheel", createDesktopHistoryWheelHandler(
    (direction) => ipcRenderer.send(DESKTOP_HISTORY_GESTURE_CHANNEL, direction),
  ), { capture: true, passive: true });
}
