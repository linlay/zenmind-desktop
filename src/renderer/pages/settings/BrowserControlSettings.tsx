import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, Spin, Switch } from "antd";
import type { BrowserUseBackend, BrowserUseSettingsRequest, BrowserUseSettingsState } from "../../../shared/browser-use";
import { useI18n } from "../../i18n/useI18n";
import "./BrowserControlSettings.css";

/** Authorization is write-only in the renderer; Main owns encrypted persistence. */
export function BrowserControlSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserUseSettingsState>();
  const [defaultBackend, setDefaultBackend] = useState<BrowserUseBackend>("workpanel");
  const [remember, setRemember] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState<"saved" | "forgotten" | "" >("");
  const alive = useRef(false);
  const operation = useRef(0);
  const dirty = useRef(false);
  const locked = useRef(false);

  const receive = useCallback((next: BrowserUseSettingsState, resetDraft = false) => {
    setState(next);
    if (resetDraft || !dirty.current) {
      setDefaultBackend(next.defaultBackend);
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
    return () => { alive.current = false; operation.current++; locked.current = false; };
  }, [perform, receive]);

  const changed = Boolean(state && (defaultBackend !== state.defaultBackend || remember !== state.rememberChromeConnection || token.trim()));
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
    void perform({ action: "save", defaultBackend, rememberChromeConnection: remember,
      ...(remember && token.trim() ? { extensionToken: token.trim() } : {}) });
  }

  return <div className="browser-control-settings">
    {error && <p className="browser-use-settings-error" role="alert">{error}</p>}
    {notice && <p className="browser-use-settings-notice" role="status">{t(`settings.browser.${notice}`)}</p>}
    {!state && busy && <div className="browser-use-settings-loading" role="status"><Spin size="small" />{t("common.loading")}</div>}
    <div className="settings-appearance-panel">
      <div className="settings-appearance-row">
        <div className="settings-appearance-row-copy"><strong id="browser-default-label">{t("settings.browser.defaultBrowser")}</strong><span>{t("settings.browser.defaultHelp")}</span></div>
        <Select aria-labelledby="browser-default-label" className="browser-use-default-select" value={state ? defaultBackend : undefined} disabled={busy || !state}
          placeholder={t(busy ? "common.loading" : "settings.browser.statusUnavailable")}
          options={[{ value: "workpanel", label: t("browserUse.workpanel") }, { value: "chrome", label: "Chrome" }]}
          onChange={value => { edit(); setDefaultBackend(value); }} />
      </div>
      <div className="settings-appearance-row">
        <div className="settings-appearance-row-copy"><strong id="browser-remember-label">{t("settings.browser.remember")}</strong><span>{t("settings.browser.rememberHelp")}</span></div>
        <Switch aria-labelledby="browser-remember-label" checked={remember}
          disabled={busy || !state || (!state.secureStorageAvailable && !remember)}
          onChange={value => { edit(); setRemember(value); if (!value) setToken(""); }} />
      </div>
      <div className="settings-appearance-row browser-use-authorization-row">
        <div className="settings-appearance-row-copy"><strong id="browser-authorization-label">{t("settings.browser.authorization")}</strong><span>{t("settings.browser.authorizationHelp")}</span></div>
        <Input.Password aria-labelledby="browser-authorization-label" className="browser-use-authorization-input" value={token}
          autoComplete="new-password" spellCheck={false} maxLength={1024}
          placeholder={t(state?.hasSavedAuthorization ? "settings.browser.authorizationSavedPlaceholder" : "settings.browser.authorizationPlaceholder")}
          disabled={busy || !state || !remember || !state.secureStorageAvailable}
          onChange={event => { edit(); setToken(event.target.value); }} />
      </div>
      <div className="settings-appearance-row browser-use-settings-status">
        <div className="settings-appearance-row-copy"><strong>{t(!state ? "settings.browser.statusUnavailable" : state.hasSavedAuthorization ? "settings.browser.authorized" : "settings.browser.notAuthorized")}</strong>
          {state && <span>{t("settings.browser.connections", { chats: state.connectedChats, runs: state.activeRuns })}</span>}
          {state && !state.secureStorageAvailable && <span role="status">{t("settings.browser.storageUnavailable")}</span>}
          {active && <span>{t("settings.browser.activeHelp")}</span>}
        </div>
      </div>
      <div className="browser-use-settings-actions">
        <Button disabled={busy} onClick={() => void perform({ action: "install-extension" })}>{t("browserUse.install")}</Button>
        <Button disabled={busy || active || Boolean(state && !state.hasSavedAuthorization && !state.connectedChats)} onClick={() => void perform({ action: "forget" })}>{t(state ? "settings.browser.forget" : "settings.browser.clearConfiguration")}</Button>
        <Button type="primary" disabled={busy || !state || !changed} loading={busy && Boolean(state)} onClick={save}>{t("common.save")}</Button>
        {!state && !busy && <Button onClick={() => void perform({ action: "get" })}>{t("common.refresh")}</Button>}
      </div>
    </div>
  </div>;
}
