import { Fragment, useRef, useState, type ReactNode } from "react";
import { moveSidebarNavItem, type SidebarNavOrderItemKey } from "./sidebarNavOrder";

const DRAG_TYPE = "application/x-zenmind-navigation";

export function SortableNavEntries({ order, sortableKeys, onChange, renderItem, hint }: {
  order: SidebarNavOrderItemKey[];
  sortableKeys: SidebarNavOrderItemKey[];
  onChange?: (order: SidebarNavOrderItemKey[]) => void;
  renderItem: (key: SidebarNavOrderItemKey) => ReactNode;
  hint: string;
}) {
  const active = useRef<SidebarNavOrderItemKey | null>(null);
  const [target, setTarget] = useState<{ key: SidebarNavOrderItemKey; after: boolean } | null>(null);
  const [dragging, setDragging] = useState<SidebarNavOrderItemKey | null>(null);
  function clear() {
    active.current = null;
    setDragging(null);
    setTarget(null);
  }
  // Electron's Chromium drag events behave identically on macOS and Windows.
  // Keep routing controls intact, including roving focus and context menus.
  return <>{order.map((key) => {
    const child = renderItem(key);
    if (!sortableKeys.includes(key)) return <Fragment key={key}>{child}</Fragment>;
    return <div
      key={key}
      className={`sidebar-sortable-nav-entry${dragging === key ? " is-dragging" : ""}${target?.key === key ? target.after ? " drop-after" : " drop-before" : ""}`}
      draggable={Boolean(onChange)}
      title={hint}
      onDragStartCapture={(event) => {
        if (!onChange) { event.preventDefault(); return; }
        active.current = key;
        setDragging(key);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(DRAG_TYPE, key);
        event.dataTransfer.setDragImage(event.currentTarget, 20, 16);
        event.stopPropagation();
      }}
      onDragOver={(event) => {
        if (!active.current || active.current === key || !onChange) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        setTarget({ key, after: event.clientY > rect.top + rect.height / 2 });
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
      }}
      onDrop={(event) => {
        if (!active.current || !onChange) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onChange(moveSidebarNavItem(order, active.current, key, event.clientY > rect.top + rect.height / 2));
        clear();
      }}
      onDragEnd={clear}
      onKeyDownCapture={(event) => {
        if (!onChange || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
            (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        event.stopPropagation();
        const keys = order.filter((item) => sortableKeys.includes(item));
        const next = keys[keys.indexOf(key) + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) onChange(moveSidebarNavItem(order, key, next, event.key === "ArrowDown"));
      }}
    >{child}</div>;
  })}</>;
}
