import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DesktopHistoryGestureProgress } from "../../../shared/contracts/desktop-api";
import { DESKTOP_HISTORY_GESTURE_IDLE_MS } from "../../../shared/desktop-history-gesture";
import "./HistoryGestureOverlay.css";

export function HistoryGestureOverlay({ canGoBack, canGoForward }: {
  canGoBack: boolean;
  canGoForward: boolean;
}) {
  const [feedback, setFeedback] = useState<(DesktopHistoryGestureProgress & { exiting: boolean }) | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const visible = feedback !== null;

  useEffect(() => {
    if (typeof window.electronAPI.onHistoryGestureProgress !== "function") return;
    let timer: number | undefined;
    const dismiss = () => {
      setFeedback((current) => current ? { ...current, exiting: true } : null);
      timer = window.setTimeout(() => setFeedback(null), 140);
    };
    const unsubscribe = window.electronAPI.onHistoryGestureProgress((progress) => {
      window.clearTimeout(timer);
      if (!progress) {
        dismiss();
        return;
      }
      setFeedback({ ...progress, exiting: false });
      timer = window.setTimeout(dismiss, progress.committed ? 180 : DESKTOP_HISTORY_GESTURE_IDLE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const overlay = ref.current;
    if (!overlay || !visible) return;
    // The top layer keeps this centered hint above embedded guests and WorkPanel.
    overlay.setAttribute("popover", "manual");
    overlay.showPopover();
    return () => {
      if (overlay.matches(":popover-open")) overlay.hidePopover();
    };
  }, [visible]);

  if (!feedback) return null;
  const available = feedback.direction === "back" ? canGoBack : canGoForward;
  const style = {
    "--history-gesture-opacity": available ? 0.2 + feedback.progress * 0.34 : 0.14,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={`history-gesture-overlay${feedback.exiting ? " is-exiting" : ""}`}
      data-direction={feedback.direction}
      data-progress={feedback.progress}
      data-committed={feedback.committed}
      style={style}
      aria-hidden="true"
    >
      <svg className="history-gesture-arrow" viewBox="0 0 180 180" fill="none" stroke="currentColor" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round">
        <path d="M32 90H148M98 40L148 90L98 140" />
      </svg>
    </div>
  );
}
