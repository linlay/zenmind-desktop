import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckOutlined } from "@ant-design/icons";
export interface LibraryMenuItem { key: string; label?: string; icon?: ReactNode; disabled?: boolean; danger?: boolean; separator?: boolean; checked?: boolean; run?(): void }
export interface LibraryMenuState { x: number; y: number; anchor: HTMLElement | null; items: LibraryMenuItem[] }
export function LibraryMenu({ menu, onClose }: { menu: LibraryMenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)) });
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const resize = () => onClose();
    window.addEventListener("pointerdown", dismiss); window.addEventListener("resize", resize);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", resize); };
  }, [onClose]);
  return createPortal(<div className="library-menu sidebar-operation-menu-popover" ref={ref} role="menu" style={{ left: position.x, top: position.y }} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); menu.anchor?.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return;
    if (event.key === "Tab") { onClose(); return; }
    event.preventDefault();
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>{menu.items.map(item => item.separator ? <div key={item.key} role="separator" className="library-menu-separator" /> : <button key={item.key} role="menuitem" className={`library-menu-item${item.danger ? " is-danger" : ""}`} disabled={item.disabled} onClick={() => { onClose(); item.run?.(); }}>
    <span className="library-menu-icon">{item.icon}</span><span>{item.label}</span>{item.checked && <span className="library-menu-check" aria-hidden="true"><CheckOutlined /></span>}
  </button>)}</div>, document.body);
}
