import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";

export interface LibrarySelectionGesture {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  toggle?: boolean;
}
interface SelectionBox { left: number; top: number; width: number; height: number }
interface MarqueeSession {
  root: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  originX: number;
  originY: number;
  base: string[];
  additive: boolean;
  moved: boolean;
}
function primaryModifier(gesture: LibrarySelectionGesture, platform: string) {
  if (platform === "darwin") return !!gesture.metaKey;
  if (platform === "win32") return !!gesture.ctrlKey;
  return !!gesture.ctrlKey;
}
function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function useLibrarySelection(options: {
  keys: string[];
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  platform: string;
  scope: string;
  enabled: boolean;
}) {
  const latest = useRef(options); latest.current = options;
  const anchor = useRef<string | null>(null);
  const session = useRef<MarqueeSession | null>(null);
  const animation = useRef<number | null>(null);
  const [box, setBox] = useState<SelectionBox | null>(null);
  const [selecting, setSelecting] = useState(false);

  function updateSelected(keys: string[]) {
    latest.current.setSelected(previous => sameKeys(previous, keys) ? previous : keys);
  }
  function point(key: string) { anchor.current = key; }
  function clearAnchor() { anchor.current = null; }
  function select(key: string, gesture: LibrarySelectionGesture) {
    const { keys, selected, platform } = latest.current;
    const index = keys.indexOf(key), from = keys.indexOf(anchor.current ?? selected[0] ?? "");
    if (index < 0) return;
    const additive = primaryModifier(gesture, platform);
    if (gesture.shiftKey && from >= 0) {
      const range = keys.slice(Math.min(index, from), Math.max(index, from) + 1);
      updateSelected(additive || gesture.toggle ? [...new Set([...selected, ...range])] : range);
    } else {
      point(key);
      updateSelected(additive || gesture.toggle ? selected.includes(key) ? selected.filter(value => value !== key) : [...selected, key] : [key]);
    }
  }
  function releaseCapture(current: MarqueeSession) {
    if (current.root.hasPointerCapture(current.pointerId)) current.root.releasePointerCapture(current.pointerId);
  }
  function finish(cancel = false, render = true) {
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    releaseCapture(current);
    if (!render) return;
    if (cancel) updateSelected(current.base.filter(key => latest.current.keys.includes(key)));
    else if (!current.moved && !current.additive) { updateSelected([]); clearAnchor(); }
    else if (current.moved && !current.additive) clearAnchor();
    setSelecting(false); setBox(null);
  }
  function paint(scroll = true) {
    const current = session.current;
    if (!current?.moved) return;
    const root = current.root, bounds = root.getBoundingClientRect();
    const leftEdge = bounds.left + root.clientLeft, topEdge = bounds.top + root.clientTop;
    const rightEdge = leftEdge + root.clientWidth, bottomEdge = topEdge + root.clientHeight;
    if (scroll) {
      const edge = 28;
      if (current.clientY < topEdge + edge) root.scrollTop -= Math.min(16, (topEdge + edge - current.clientY) / 2);
      else if (current.clientY > bottomEdge - edge) root.scrollTop += Math.min(16, (current.clientY - bottomEdge + edge) / 2);
    }
    const x = Math.max(leftEdge, Math.min(current.clientX, rightEdge)) - leftEdge + root.scrollLeft;
    const y = Math.max(topEdge, Math.min(current.clientY, bottomEdge)) - topEdge + root.scrollTop;
    const left = Math.min(current.originX, x), right = Math.max(current.originX, x);
    const top = Math.min(current.originY, y), bottom = Math.max(current.originY, y);
    const hits: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>("[data-library-key]")) {
      const rect = element.getBoundingClientRect();
      const itemLeft = rect.left - leftEdge + root.scrollLeft, itemTop = rect.top - topEdge + root.scrollTop;
      if (itemLeft < right && itemLeft + rect.width > left && itemTop < bottom && itemTop + rect.height > top) hits.push(element.dataset.libraryKey!);
    }
    updateSelected(current.additive ? [...new Set([...current.base, ...hits])] : hits);
    const screenLeft = Math.max(leftEdge, leftEdge + left - root.scrollLeft), screenTop = Math.max(topEdge, topEdge + top - root.scrollTop);
    const next = { left: screenLeft, top: screenTop, width: Math.max(0, Math.min(rightEdge, leftEdge + right - root.scrollLeft) - screenLeft), height: Math.max(0, Math.min(bottomEdge, topEdge + bottom - root.scrollTop) - screenTop) };
    setBox(previous => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height ? previous : next);
  }
  function tick() {
    animation.current = null;
    if (!session.current?.moved) return;
    paint(); animation.current = requestAnimationFrame(tick);
  }
  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (!latest.current.enabled || event.pointerType !== "mouse" || event.button !== 0 || session.current) return;
    const root = event.currentTarget, bounds = root.getBoundingClientRect();
    // Files keep their native drag-to-folder gesture; controls and scrollbar also keep their own behavior.
    if ((event.target as Element).closest(".library-file,.library-folder-card,button,input,a,[role=button]")) return;
    if (event.clientX >= bounds.left + root.clientLeft + root.clientWidth || event.clientY >= bounds.top + root.clientTop + root.clientHeight) return;
    event.preventDefault(); root.focus({ preventScroll: true });
    session.current = {
      root, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY,
      originX: event.clientX - bounds.left - root.clientLeft + root.scrollLeft, originY: event.clientY - bounds.top - root.clientTop + root.scrollTop,
      base: [...latest.current.selected], additive: primaryModifier(event, latest.current.platform) || event.shiftKey, moved: false,
    };
    setSelecting(true);
    root.setPointerCapture(event.pointerId);
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!(event.buttons & 1)) { finish(); return; }
      current.clientX = event.clientX; current.clientY = event.clientY;
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 4) current.moved = true;
      if (current.moved && animation.current === null) animation.current = requestAnimationFrame(tick);
    };
    const up = (event: PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.clientX = event.clientX; current.clientY = event.clientY;
      paint(false); finish();
    };
    const cancel = () => finish(true);
    const lostCapture = (event: PointerEvent) => { if (session.current?.pointerId === event.pointerId) cancel(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true); window.addEventListener("lostpointercapture", lostCapture, true);
    window.addEventListener("blur", cancel); window.addEventListener("keydown", key, true);
    return () => {
      finish(false, false);
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true); window.removeEventListener("lostpointercapture", lostCapture, true);
      window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key, true);
    };
  }, []);
  const signature = JSON.stringify(options.keys);
  const previousScope = useRef(options.scope);
  useEffect(() => {
    finish(false);
    if (previousScope.current !== options.scope || (anchor.current && !latest.current.keys.includes(anchor.current))) clearAnchor();
    previousScope.current = options.scope;
  }, [signature, options.scope]);
  useEffect(() => { if (!options.enabled) finish(true); }, [options.enabled]);
  return { select, point, clearAnchor, begin, box, selecting };
}
