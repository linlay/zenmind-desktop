import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Popover, Radio, Spin } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import type { BrowserUseControlRequest, BrowserUseState } from "../../shared/browser-use";
import { useI18n } from "../i18n/useI18n";
import { buildSettingsSectionPath } from "../settings/settingsRoutes";
import "./browser-use.css";

/** The host toolbar owns browser connection controls, not an untrusted webpage. */
export function BrowserUseControl({ chatId }: { chatId: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<BrowserUseState>();
  const [error, setError] = useState<{ code: string; connecting?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const currentChat = useRef(chatId);
  const operation = useRef(0);
  const shownRequests = useRef(new Set<string>());
  currentChat.current = chatId;
  const receive = useCallback((next: BrowserUseState) => {
    if (next.chatId !== currentChat.current) return;
    setState(next);
    const request = next.connectionRequest;
    const requestKey = request ? `${next.chatId}:${request.id}` : "";
    if (request && !shownRequests.current.has(requestKey)) {
      shownRequests.current.add(requestKey);
      setOpen(true);
    }
  }, []);
  const apply = useCallback(async (request: BrowserUseControlRequest, quiet = false) => {
    const requestOperation = quiet ? operation.current : ++operation.current;
    if (!quiet) { setBusy(true); setError(undefined); }
    try {
      const result = await window.electronAPI.browserUse.control(request);
      if (currentChat.current !== request.chatId || operation.current !== requestOperation) return;
      if (result.ok) receive(result.state);
      else if (!quiet) setError({ ...result.error, connecting: request.action === "connect" });
    } catch {
      if (!quiet && currentChat.current === request.chatId && operation.current === requestOperation) {
        setError({ code: "browser_control_failed" });
      }
    } finally {
      if (!quiet && currentChat.current === request.chatId && operation.current === requestOperation) setBusy(false);
    }
  }, [receive]);
  useEffect(() => {
    operation.current++;
    setState(undefined); setError(undefined); setBusy(false);
    if (!chatId) return;
    void apply({ action: "state", chatId }, true);
    return window.electronAPI.browserUse.onChanged(next => {
      receive(next);
    });
  }, [chatId, apply, receive]);
  useEffect(() => { setOpen(false); }, [chatId]);
  useEffect(() => {
    if (open && chatId) void apply({ action: "state", chatId }, true);
  }, [open, chatId, apply]);
  const running = Boolean(state?.activeRunIds.length);
  const workspaceShared = state?.workspaceShared === true;
  const workspaceOwner = state?.workspaceOwner;
  const workspaceDraining = workspaceOwner?.draining === true;
  const workspaceBusy = Boolean(workspaceOwner);
  const workspaceOwnedElsewhere = Boolean(workspaceOwner && workspaceOwner.chatId !== chatId);
  const locked = running || workspaceBusy;
  const connection = state?.connection ?? "disconnected";
  const needsConnection = Boolean(state?.connectionRequest && connection !== "connected");
  const needsNewRun = Boolean(state?.connectionRequest && connection === "connected" && !workspaceBusy);
  const failure = error ?? (state?.error ? { ...state.error, connecting: true } : undefined);
  const errorMessage = failure?.code === "chrome_connection_timeout" || (failure?.code === "browser_action_timeout" && failure.connecting)
    ? t("browserUse.connectionTimeout")
    : failure?.code === "chrome_unavailable" ? t("browserUse.chromeUnavailable")
      : failure?.code === "chrome_connection_failed" || failure?.code === "chrome_extension_missing" ? t("browserUse.connectionFailed")
        : failure?.code === "browser_workspace_draining" ? t("browserUse.workspaceDraining")
          : failure?.code === "browser_busy" ? t(workspaceShared ? "browserUse.workspaceBusy" : "browserUse.connectionFrozen")
          : failure?.code === "browser_connecting" ? t("browserUse.connecting")
            : failure?.code === "invalid_browser_authorization" || failure?.code === "browser_authorization_unavailable" || failure?.code === "secure_storage_unavailable"
              ? t("browserUse.savedAuthorizationUnavailable")
              : failure ? t("browserUse.failed") : undefined;
  const content = (
    <div className="browser-use-controls">
      <strong>{t("browserUse.title")}</strong>
      {!chatId ? <p>{t("browserUse.startChat")}</p> : <>
        {needsConnection && <p className="browser-use-request-help" role="status">{t("browserUse.connectionRequested")}</p>}
        {needsNewRun && <p className="browser-use-request-help" role="status">{t("browserUse.continueRequested")}</p>}
        <Radio.Group
          value={state?.backend ?? "workpanel"}
          disabled={busy || locked}
          onChange={event => void apply({ action: "select", chatId, backend: event.target.value })}
          optionType="button"
          options={[{ label: t("browserUse.workpanel"), value: "workpanel" }, { label: "Chrome", value: "chrome" }]}
        />
        <p className="browser-use-help">{t(state?.backend === "chrome" ? workspaceShared ? "browserUse.sharedChromeHelp" : "browserUse.chromeHelp" : "browserUse.workpanelHelp")}</p>
        {workspaceDraining ? <p className="browser-use-request-help" role="status">{t("browserUse.workspaceDraining")}</p>
          : workspaceOwnedElsewhere && <p className="browser-use-request-help" role="status">{t("browserUse.workspaceBusy")}</p>}
        {(state?.backend === "chrome" || needsConnection || connection === "connecting") && <>
          <div className="browser-use-status" role="status">
            {connection === "connecting" && <Spin size="small" />}
            <span>{t(`browserUse.${connection}`)}</span>
          </div>
          {state?.connectionName && <p className="browser-use-help">{t(workspaceShared ? "browserUse.sharedConnectionLabel" : "browserUse.connectionLabel")}: {state.connectionName}</p>}
          {connection === "connected" && <div className="browser-use-pages">
            {state?.pages.map(page => <button type="button" className="browser-use-page-button" key={page.surfaceId} title={page.url}
              aria-pressed={page.surfaceId === state.selectedSurfaceId}
              disabled={busy || locked} onClick={() => void apply({ action: "activate", chatId, surfaceId: page.surfaceId })}>
              <GlobalOutlined /><span>{page.title || page.url}</span>
            </button>)}
            {!state?.pages.length && <p className="browser-use-help">{t("browserUse.noBusinessPages")}</p>}
            <Button size="small" disabled={busy || locked} onClick={() => void apply({ action: "connect", chatId, interactive: true })}>{t("browserUse.selectExisting")}</Button>
            <Button size="small" disabled={busy || locked} onClick={() => void apply({ action: "disconnect", chatId })}>{t(workspaceShared ? "browserUse.disconnectWorkspace" : "browserUse.disconnect")}</Button>
            {workspaceShared && !locked && <p className="browser-use-help">{t("browserUse.sharedDisconnectHelp")}</p>}
          </div>}
        </>}
        {connection !== "connected" && <>
          <Button size="small" type="primary" loading={connection === "connecting"} disabled={locked || (busy && connection !== "connecting")}
            onClick={() => void apply({ action: "connect", chatId })}>{t("browserUse.connect")}</Button>
          {connection === "connecting" ? <Button size="small" disabled={locked} onClick={() => void apply({ action: "disconnect", chatId })}>{t("browserUse.cancel")}</Button>
            : <Button size="small" disabled={busy || locked} onClick={() => void apply({ action: "connect", chatId, interactive: true })}>{t("browserUse.manualAuthorization")}</Button>}
        </>}
        {locked && <Button size="small" danger loading={busy} onClick={() => void apply({ action: "takeover", chatId })}>{t(workspaceShared ? "browserUse.workspaceTakeover" : "browserUse.takeover")}</Button>}
        {locked && <p className="browser-use-help">{t(workspaceShared ? "browserUse.workspaceTakeoverHelp" : "browserUse.runningHelp")}</p>}
        {locked && !workspaceShared && <p className="browser-use-help">{t("browserUse.connectionFrozen")}</p>}
      </>}
      {errorMessage && <p className="browser-use-error" role="alert">{errorMessage}</p>}
      <Button size="small" type="link" className="browser-use-settings-link" onClick={() => { setOpen(false); navigate(buildSettingsSectionPath("browser")); }}>{t("browserUse.settings")}</Button>
    </div>
  );
  return <Popover content={content} trigger="click" open={open} onOpenChange={setOpen} placement="bottomRight">
    <button type="button" className={`main-chat-header-action browser-use-trigger${state?.backend === "chrome" ? " is-chrome" : ""}`}
      aria-label={t("browserUse.title")} title={t("browserUse.title")} aria-expanded={open}>
      <GlobalOutlined aria-hidden="true" />
      {state?.backend === "chrome" && <span className={`browser-use-dot is-${connection}`} />}
    </button>
  </Popover>;
}
