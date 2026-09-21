import { CloseOutlined, DownOutlined, EllipsisOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, UpOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import { nextBrowserZoom, resolveWorkPanelBrowserShortcut, type WorkPanelBrowserCommand } from "../../../shared/work-panel-browser";
import { normalizeWorkPanelWebUrl } from "../../../shared/work-panel";
import { useI18n } from "../../i18n/useI18n";
import "./work-panel-browser-tools.css";

export function WorkPanelBrowserTools({ webview, active }: { webview: Electron.WebviewTag | null; active: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState({ activeMatchOrdinal: 0, matches: 0 });
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(false);
  const [printing, setPrinting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef<number>();
  const printingRef = useRef(false);
  const isMac = /Mac/i.test(navigator.platform);
  const shortcut = isMac ? "⌘" : "Ctrl+";
  function syncZoom() {
    try { if (webview) setZoom(Math.round(webview.getZoomFactor() * 100)); } catch { /* Guest not ready. */ }
  }
  function changeZoom(direction: number) {
    if (!webview) return;
    try {
      const value = direction === 0 ? 100 : nextBrowserZoom(Math.round(webview.getZoomFactor() * 100), direction);
      webview.setZoomFactor(value / 100);
      setZoom(value);
    } catch { setError(true); }
  }
  function find(text: string, next = false, forward = true) {
    setQuery(text);
    if (!webview) return;
    try {
      // Electron uses findNext=true to start a new search, false to continue it.
      if (text) requestId.current = webview.findInPage(text, { findNext: !next, forward });
      else {
        requestId.current = undefined;
        webview.stopFindInPage("clearSelection");
        setMatches({ activeMatchOrdinal: 0, matches: 0 });
      }
    } catch { setError(true); }
  }
  function closeFind() {
    setFinding(false);
    find("");
    webview?.focus();
  }
  async function print() {
    if (!webview || printingRef.current) return;
    printingRef.current = true;
    setPrinting(true);
    setError(false);
    try { await webview.print({ silent: false, printBackground: true }); }
    catch (reason) {
      // Cancelling the native dialog is a normal outcome on both platforms.
      if (!/cancel/i.test(String(reason))) setError(true);
    } finally { printingRef.current = false; setPrinting(false); }
  }
  function command(action: WorkPanelBrowserCommand) {
    setOpen(false);
    if (action === "find") { setFinding(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }
    else if (action === "print") void print();
    else changeZoom(action === "zoom-in" ? 1 : action === "zoom-out" ? -1 : 0);
  }
  useEffect(() => {
    if (!webview) return;
    const found = (event: Event) => {
      const result = (event as Event & { result: { requestId: number; activeMatchOrdinal: number; matches: number } }).result;
      if (result.requestId === requestId.current) setMatches(result);
    };
    const navigate = () => { setFinding(false); setQuery(""); requestId.current = undefined; setError(false); syncZoom(); };
    const focus = () => setOpen(false);
    webview.addEventListener("focus", focus);
    webview.addEventListener("found-in-page", found);
    webview.addEventListener("dom-ready", navigate);
    syncZoom();
    return () => {
      webview.removeEventListener("focus", focus);
      webview.removeEventListener("found-in-page", found);
      webview.removeEventListener("dom-ready", navigate);
      try { webview.stopFindInPage("clearSelection"); } catch { /* Guest already destroyed. */ }
    };
  }, [webview]);
  useEffect(() => {
    if (!active) { setOpen(false); return; }
    const keydown = (event: KeyboardEvent) => {
      const action = resolveWorkPanelBrowserShortcut(isMac ? "darwin" : "win32", {
        key: event.key, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      command(action);
    };
    window.addEventListener("keydown", keydown, true);
    const unsubscribe = window.electronAPI.onWorkPanelBrowserShortcut((request) => {
      try { if (webview?.getWebContentsId() === request.guestId) command(request.command); } catch { /* Guest detached. */ }
    });
    return () => { window.removeEventListener("keydown", keydown, true); unsubscribe(); };
  }, [active, webview, isMac]);
  async function linkAction(copy: boolean) {
    setOpen(false);
    try {
      const url = normalizeWorkPanelWebUrl(webview?.getURL() || "");
      if (!url) throw new Error("unavailable");
      if (copy) await window.electronAPI.clipboard.writeText(url);
      else if (!(await window.electronAPI.shell.openExternal(url)).ok) throw new Error("open_failed");
    } catch { setError(true); }
  }
  return <div className="work-panel-browser-tools">
    <Popover overlayClassName="work-panel-browser-popover" arrow={false} trigger="click" placement="bottomRight" open={open && active} onOpenChange={(value) => { syncZoom(); setOpen(value); }} content={
      <div className="work-panel-browser-menu">
        <button disabled={!webview} onClick={() => command("find")}>{t("externalWebview.find")}<kbd>{shortcut}F</kbd></button>
        <button disabled={!webview || printing} onClick={() => command("print")}>{t("externalWebview.print")}<kbd>{shortcut}P</kbd></button>
        <div className="work-panel-browser-zoom"><span>{t("externalWebview.zoom")}</span>
          <button disabled={!webview || zoom <= 25} aria-label={t("externalWebview.zoomOut")} onClick={() => changeZoom(-1)}><MinusOutlined /></button>
          <output>{zoom}%</output>
          <button disabled={!webview || zoom >= 300} aria-label={t("externalWebview.zoomIn")} onClick={() => changeZoom(1)}><PlusOutlined /></button>
          <button disabled={!webview || zoom === 100} title={t("externalWebview.zoomReset")} aria-label={t("externalWebview.zoomReset")} onClick={() => changeZoom(0)}><ReloadOutlined /></button>
        </div>
        <button disabled={!webview} onClick={() => void linkAction(false)}>{t("externalWebview.openExternal")}</button>
        <button disabled={!webview} onClick={() => void linkAction(true)}>{t("externalWebview.copyLink")}</button>
      </div>
    }><button className="external-webview-toolbar-button" aria-label={t("externalWebview.more")} title={t("externalWebview.more")} aria-expanded={open}><EllipsisOutlined rotate={90} /></button></Popover>
    {finding && active ? <div className="work-panel-browser-find" role="search">
      <input ref={input} value={query} placeholder={t("externalWebview.find")} aria-label={t("externalWebview.find")} onChange={(event) => find(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); closeFind(); }
        if (event.key === "Enter") { event.preventDefault(); find(query, true, !event.shiftKey); }
      }} />
      <output aria-live="polite">{matches.activeMatchOrdinal}/{matches.matches}</output>
      <button disabled={!query} aria-label={t("externalWebview.findPrevious")} onClick={() => find(query, true, false)}><UpOutlined /></button>
      <button disabled={!query} aria-label={t("externalWebview.findNext")} onClick={() => find(query, true)}><DownOutlined /></button>
      <button aria-label={t("externalWebview.findClose")} onClick={closeFind}><CloseOutlined /></button>
    </div> : null}
    {error && active ? <div className="work-panel-browser-error" role="alert">{t("externalWebview.actionFailed")}<button onClick={() => setError(false)} aria-label={t("externalWebview.findClose")}><CloseOutlined /></button></div> : null}
  </div>;
}
