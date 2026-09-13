import { useEffect, useRef } from "react";

/** Reading starts after the rendered result intersects the visible detail pane. */
export function useKanbanResultRead(input: {
  issueId: string;
  key: string;
  scope: string;
  ready: boolean;
  isRead: boolean;
  onRead?: () => void;
  onError: () => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const pending = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const callbacks = useRef(input);
  callbacks.current = input;
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !input.ready || input.isRead || !input.key || !input.scope) return;
    const key = JSON.stringify([input.scope, input.key]);
    let visible = false;
    let active = true;
    const read = () => {
      if (!active || !visible || document.visibilityState !== "visible" || pending.current.has(key) || completed.current.has(key)) return;
      pending.current.add(key);
      void window.electronAPI.kanban.markResultRead({ issueId: input.issueId, key: input.key, scope: input.scope }).then((result) => {
        if (!result.ok) throw new Error("Kanban result read failed");
        completed.current.add(key);
        if (active) callbacks.current.onRead?.();
      }).catch(() => {
        if (active) callbacks.current.onError();
      }).finally(() => pending.current.delete(key));
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      read();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", read);
    return () => { active = false; observer.disconnect(); document.removeEventListener("visibilitychange", read); };
  }, [input.issueId, input.key, input.scope, input.ready, input.isRead]);
  return elementRef;
}
