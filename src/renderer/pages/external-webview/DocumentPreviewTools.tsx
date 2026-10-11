import { EllipsisOutlined, FolderOpenOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { nextBrowserZoom, resolveWorkPanelBrowserShortcut } from "../../../shared/work-panel-browser";
import { useI18n } from "../../i18n/useI18n";
import "./document-preview.css";

export function DocumentPreviewTools({ webview, active, onReveal }: {
  webview: Electron.WebviewTag | null;
  active: boolean;
  onReveal?: () => void;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(100);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMac = /Mac/i.test(navigator.platform);

  const changeZoom = useCallback((direction: -1 | 0 | 1) => {
    if (!webview) return;
    try {
      const value = direction === 0 ? 100 : nextBrowserZoom(Math.round(webview.getZoomFactor() * 100), direction);
      webview.setZoomFactor(value / 100);
      setZoom(value);
    } catch { /* The guest may have closed while its toolbar was receiving input. */ }
  }, [webview]);

  useEffect(() => {
    if (!webview) return;
    const syncZoom = () => {
      try { setZoom(Math.round(webview.getZoomFactor() * 100)); } catch { /* Guest not ready. */ }
    };
    syncZoom();
    webview.addEventListener("dom-ready", syncZoom);
    return () => { webview.removeEventListener("dom-ready", syncZoom); };
  }, [webview]);

  useEffect(() => {
    if (!active) { setOpen(false); return; }
    const run = (command: string) => {
      if (command === "zoom-in") changeZoom(1);
      else if (command === "zoom-out") changeZoom(-1);
      else if (command === "zoom-reset") changeZoom(0);
      else return false;
      return true;
    };
    const keydown = (event: KeyboardEvent) => {
      // macOS uses Command; Windows and Linux use Control, matching WorkPanel.
      const command = resolveWorkPanelBrowserShortcut(isMac ? "darwin" : "win32", {
        key: event.key, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
      });
      if (!command || !run(command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", keydown, true);
    const unsubscribe = window.electronAPI.onWorkPanelBrowserShortcut((request) => {
      try {
        if (webview?.getWebContentsId() === request.guestId) run(request.command);
      } catch { /* A detached guest cannot own a shortcut. */ }
    });
    return () => {
      window.removeEventListener("keydown", keydown, true);
      unsubscribe();
    };
  }, [active, changeZoom, isMac, webview]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div className="document-preview-tools">
      <Popover open={open && active} onOpenChange={setOpen} trigger="click" placement="bottomRight" arrow={false}
        overlayClassName="document-preview-popover" content={
          <div ref={menuRef} className="document-preview-menu" role="dialog" aria-label={t("externalWebview.more")}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }}>
            <div className="document-preview-zoom" role="group" aria-label={t("externalWebview.zoom")}>
              <span>{t("externalWebview.zoom")}</span>
              <button type="button" disabled={!webview || zoom <= 25}
                aria-label={t("externalWebview.zoomOut")} title={t("externalWebview.zoomOut")} onClick={() => changeZoom(-1)}>
                <MinusOutlined />
              </button>
              <button type="button" className="document-preview-zoom-reset" disabled={!webview}
                aria-label={t("externalWebview.zoomReset")} title={t("externalWebview.zoomReset")} onClick={() => changeZoom(0)}>
                {zoom}%
              </button>
              <button type="button" disabled={!webview || zoom >= 300}
                aria-label={t("externalWebview.zoomIn")} title={t("externalWebview.zoomIn")} onClick={() => changeZoom(1)}>
                <PlusOutlined />
              </button>
            </div>
            {onReveal ? (
              <button type="button" className="document-preview-reveal" onClick={() => { setOpen(false); onReveal(); }}>
                <FolderOpenOutlined />{t("localDocuments.reveal")}
              </button>
            ) : null}
          </div>
        }>
        <button ref={triggerRef} type="button" className="external-webview-toolbar-button document-preview-more"
          aria-label={t("externalWebview.more")} title={t("externalWebview.more")} aria-expanded={open && active} aria-haspopup="dialog">
          <EllipsisOutlined />
        </button>
      </Popover>
    </div>
  );
}
