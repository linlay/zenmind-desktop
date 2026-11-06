import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Spin, Switch, type InputRef } from "antd";
import type { BrowserUseSettingsRequest, BrowserUseSettingsState } from "../../../shared/browser-use";
import { useI18n } from "../../i18n/useI18n";
import { ChromeConnectionGuide } from "./ChromeConnectionGuide";
import "./BrowserControlSettings.css";

/** Authorization is write-only in the renderer; Main owns encrypted persistence. */
export function BrowserControlSettings({ isMac = false, isWindows = false }: { isMac?: boolean; isWindows?: boolean } = {}) {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserUseSettingsState>();
  const [remember, setRemember] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState<"saved" | "forgotten" | "" >("");
  const [guideOpen, setGuideOpen] = useState(false);
  const authorizationInput = useRef<InputRef>(null);
  const alive = useRef(false);
  const operation = useRef(0);
  const dirty = useRef(false);
  const locked = useRef(false);

  const receive = useCallback((next: BrowserUseSettingsState, resetDraft = false) => {
    setState(next);
    if (resetDraft || !dirty.current) {
      setRemember(next.rememberChromeConnection);
      setToken("");
      dirty.current = false;
    }
  }, []);

  const perform = useCallback(async (request: BrowserUseSettingsRequest) => {
    if (locked.current) return;
    const requestOperation = ++operation.current;
    locked.current = true;
    setBusy(true); setErrorCode(""); setNotice("");
    try {
      const result = await window.electronAPI.browserUse.settings(request);
      if (!alive.current || requestOperation !== operation.current) return;
      if (!result.ok) { setErrorCode(result.error.code); return; }
      receive(result.state, request.action === "save" || request.action === "forget");
      if (request.action === "save") setNotice("saved");
      if (request.action === "forget") setNotice("forgotten");
    } catch {
      if (alive.current && requestOperation === operation.current) setErrorCode("browser_settings_failed");
    } finally {
      if (requestOperation === operation.current) {
        locked.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }, [receive]);

  useEffect(() => {
    alive.current = true;
    void perform({ action: "get" });
    const unsubscribe = window.electronAPI.browserUse.onSettingsChanged(next => {
      if (alive.current) receive(next);
    });
    return () => {
      alive.current = false;
      operation.current++;
      locked.current = false;
      unsubscribe();
    };
  }, [perform, receive]);

  const changed = Boolean(state && (remember !== state.rememberChromeConnection || token.trim()));
  const active = Boolean(state?.activeRuns);
  const error = errorCode === "browser_workspace_draining"
    ? t("browserUse.workspaceDraining")
    : errorCode === "browser_busy" || errorCode === "browser_runs_active"
    ? t("settings.browser.activeHelp")
    : errorCode === "secure_storage_unavailable" || errorCode === "browser_secure_storage_unavailable"
      ? t("settings.browser.storageUnavailable")
      : errorCode === "invalid_args" || errorCode === "invalid_extension_token" || errorCode === "invalid_browser_authorization"
        ? t("settings.browser.invalidAuthorization")
        : errorCode === "invalid_browser_settings" || errorCode === "browser_authorization_unavailable" || errorCode === "browser_settings_unavailable"
          ? t("settings.browser.unreadableConfiguration")
          : errorCode ? t("settings.browser.failed") : "";

  function edit() { dirty.current = true; setErrorCode(""); setNotice(""); }
  function save() {
    void perform({ action: "save", defaultBackend: "workpanel", rememberChromeConnection: remember,
      ...(remember && token.trim() ? { extensionToken: token.trim() } : {}) });
  }

  return <div className="browser-control-settings">
    {error && <p className="browser-use-settings-error" role="alert">{error}</p>}
    {notice && <p className="browser-use-settings-notice" role="status">{t(`settings.browser.${notice}`)}</p>}
    {!state && busy && <div className="browser-use-settings-loading" role="status"><Spin size="small" />{t("common.loading")}</div>}
    <div className="settings-appearance-panel">
      <div className="browser-use-settings-heading">
        <strong>{t(!state ? "settings.browser.statusUnavailable" : state.hasSavedAuthorization ? "settings.browser.authorized" : "settings.browser.notAuthorized")}</strong>
        <Button onClick={() => setGuideOpen(true)}>{t("settings.browser.guide")}</Button>
      </div>
      <div className="settings-appearance-row">
        <div className="settings-appearance-row-copy"><strong id="browser-remember-label">{t("settings.browser.remember")}</strong><span>{t("settings.browser.rememberHelp")}</span></div>
        <Switch aria-labelledby="browser-remember-label" checked={remember}
          disabled={busy || !state}
          onChange={value => { edit(); setRemember(value); if (!value) setToken(""); }} />
      </div>
      <div className="settings-appearance-row browser-use-authorization-row">
        <div className="settings-appearance-row-copy"><strong id="browser-authorization-label">{t("settings.browser.authorization")}</strong><span>{t("settings.browser.authorizationHelp")}</span></div>
        <Input.Password ref={authorizationInput} aria-labelledby="browser-authorization-label" className="browser-use-authorization-input" value={token}
          autoComplete="new-password" spellCheck={false} maxLength={1024}
          placeholder={t(state?.hasSavedAuthorization ? "settings.browser.authorizationSavedPlaceholder" : "settings.browser.authorizationPlaceholder")}
          disabled={busy || !state}
          onChange={event => { edit(); setToken(event.target.value); if (event.target.value.trim()) setRemember(true); }} />
      </div>
      {active || Boolean(state?.connectedChats) ? <div className="settings-appearance-row browser-use-settings-status">
        <div className="settings-appearance-row-copy">
          {state && (state.connectedChats > 0 || active) && <span>{t("settings.browser.connections", { chats: state.connectedChats, runs: state.activeRuns })}</span>}
          {active && <span>{t("settings.browser.activeHelp")}</span>}
        </div>
      </div>
      : null}
      <div className="browser-use-settings-actions">
        <Button disabled={busy || active || Boolean(state && !state.hasSavedAuthorization && !state.connectedChats)} onClick={() => void perform({ action: "forget" })}>{t(state ? "settings.browser.forget" : "settings.browser.clearConfiguration")}</Button>
        <Button type="primary" disabled={busy || !state || !changed} loading={busy && Boolean(state)} onClick={save}>{t("common.save")}</Button>
        {!state && !busy && <Button onClick={() => void perform({ action: "get" })}>{t("common.refresh")}</Button>}
      </div>
    </div>
    <ChromeConnectionGuide isMac={isMac} isWindows={isWindows} open={guideOpen} busy={busy} onClose={() => setGuideOpen(false)}
      onOpenExtension={() => void perform({ action: "install-extension" })}
      onPaste={() => { setGuideOpen(false); }}
      afterClose={() => authorizationInput.current?.focus()} />
  </div>;
}
