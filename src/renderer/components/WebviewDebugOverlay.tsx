import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import {
  buildWebviewDebugClipboardText,
  formatWebviewDebugSurfaceLabel,
  redactWebviewDebugUrl,
} from "../debug/webviewDebugUrl";
import type { SurfaceIdentity } from "../../shared/surface-identity";
import { useI18n } from "../i18n/useI18n";
import { useWebviewDebugFloat } from "./useWebviewDebugFloat";
import Style from "./WebviewDebugOverlay.module.css";

type CopyState = "idle" | "copied" | "failed";

export function WebviewDebugOverlay({
  active,
  url,
  surfaceIdentity,
}: {
  active: boolean;
  url: string;
  surfaceIdentity?: SurfaceIdentity;
}) {
  const debugMode = useDebugMode();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const focusFloatAfterRenderRef = useRef(false);
  const dragHintId = useId();
  const displayUrl = useMemo(() => redactWebviewDebugUrl(url), [url]);
  const displaySurfaceLabel = formatWebviewDebugSurfaceLabel(surfaceIdentity);
  const copyText = buildWebviewDebugClipboardText(url, surfaceIdentity);
  const visible = debugMode && active && Boolean(displayUrl || displaySurfaceLabel);
  const {
    corner,
    overlayRef,
    setItemRef,
    focusItem,
    handlePointerDown,
    handleDockKeyDown,
    handleClickCapture,
  } = useWebviewDebugFloat(visible);

  useEffect(() => {
    setCopyState("idle");
  }, [copyText]);

  useEffect(() => {
    if (!debugMode) {
      setExpanded(true);
    }
  }, [debugMode]);

  useEffect(() => {
    if (!expanded && focusFloatAfterRenderRef.current) {
      focusFloatAfterRenderRef.current = false;
      focusItem();
    }
  }, [expanded, focusItem]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopyAll() {
    try {
      const result = await window.electronAPI.clipboard.writeText(copyText);
      setCopyState(result.ok ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  }

  const copyLabel = copyState === "copied"
    ? t("settings.debug.webviewOverlay.copied")
    : copyState === "failed"
      ? t("settings.debug.webviewOverlay.copyFailed")
      : t("settings.debug.webviewOverlay.copyAll");

  if (!visible) {
    return null;
  }

  const cornerClassName = {
    "top-left": Style.topLeft,
    "top-right": Style.topRight,
    "bottom-left": Style.bottomLeft,
    "bottom-right": Style.bottomRight,
  }[corner];
  const itemClassName = `${Style.item} ${cornerClassName}`;

  function handleOverlayKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    focusFloatAfterRenderRef.current = true;
    setExpanded(false);
  }

  return (
    <div
      className={Style.overlay}
      onClickCapture={handleClickCapture}
      onKeyDown={handleOverlayKeyDown}
      ref={overlayRef}
    >
      <span id={dragHintId} hidden>{t("settings.debug.webviewOverlay.dragHint")}</span>
      {expanded ? (
        <section className={`${itemClassName} ${Style.card}`} ref={setItemRef}>
          <div
            aria-describedby={dragHintId}
            aria-label={t("settings.debug.webviewOverlay.title")}
            className={Style.header}
            onKeyDown={handleDockKeyDown}
            onPointerDown={handlePointerDown}
            tabIndex={0}
          >
            <span className={Style.title}>{t("settings.debug.webviewOverlay.title")}</span>
            <div className={Style.actions}>
              {copyText ? (
                <button
                  aria-live="polite"
                  className={Style.actionButton}
                  data-state={copyState}
                  onClick={() => void handleCopyAll()}
                  title={copyLabel}
                  type="button"
                >
                  {copyLabel}
                </button>
              ) : null}
              <button
                aria-label={t("settings.debug.webviewOverlay.collapse")}
                className={`${Style.actionButton} ${Style.collapseButton}`}
                onClick={() => setExpanded(false)}
                title={t("settings.debug.webviewOverlay.collapse")}
                type="button"
              >
                −
              </button>
            </div>
          </div>
          <div className={Style.body}>
            {displaySurfaceLabel ? (
              <div className={Style.surfaceId}>{displaySurfaceLabel}</div>
            ) : null}
            {displayUrl ? <div className={Style.url}>{displayUrl}</div> : null}
          </div>
        </section>
      ) : (
        <button
          aria-describedby={dragHintId}
          aria-label={t("settings.debug.webviewOverlay.expand")}
          className={`${itemClassName} ${Style.floatButton}`}
          onClick={() => setExpanded(true)}
          onKeyDown={handleDockKeyDown}
          onPointerDown={handlePointerDown}
          ref={setItemRef}
          title={t("settings.debug.webviewOverlay.expand")}
          type="button"
        >
          &lt;/&gt;
        </button>
      )}
    </div>
  );
}
