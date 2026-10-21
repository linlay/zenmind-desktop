import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopSsoEmbeddedLoginRequest } from "../../shared/contracts";
import type { TranslationKey } from "../../shared/i18n";
import { useI18n } from "../i18n/useI18n";
import {
  createDesktopSsoLoginLoadController,
  createDesktopSsoLoginLoadState,
  type DesktopSsoLoginFailureReason,
  type DesktopSsoLoginLoadFailure
} from "./login-surface";
import "./DesktopSsoLoginSurface.css";

const FAILURE_MESSAGES: Record<DesktopSsoLoginFailureReason, TranslationKey> = {
  dns: "sidebar.sso.pageErrorDns",
  offline: "sidebar.sso.pageErrorOffline",
  proxy: "sidebar.sso.pageErrorProxy",
  timeout: "sidebar.sso.pageErrorTimeout",
  connection: "sidebar.sso.pageErrorConnection",
  certificate: "sidebar.sso.pageErrorCertificate",
  process: "sidebar.sso.pageErrorProcess",
  unknown: "sidebar.sso.pageErrorUnknown"
};

export function DesktopSsoLoginFailure({ failure, onRetry, onCancel }: {
  failure: DesktopSsoLoginLoadFailure;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="desktop-sso-login-surface-overlay" role="alert">
      <div className="desktop-sso-login-result">
        <div className="desktop-sso-login-result-copy">
          <strong>{t("sidebar.sso.pageLoadFailed")}</strong>
          <p>{t(FAILURE_MESSAGES[failure.reason])}</p>
          {failure.code !== null ? <p><code>{t("sidebar.sso.pageErrorCode", { code: failure.code })}</code></p> : null}
        </div>
        <div className="desktop-sso-login-result-actions">
          <button type="button" onClick={onCancel}>{t("sidebar.sso.cancelLogin")}</button>
          <button type="button" onClick={onRetry}>{t("sidebar.sso.retry")}</button>
        </div>
      </div>
    </div>
  );
}

export function DesktopSsoLoginSurface({ request, onCancel }: {
  request: DesktopSsoEmbeddedLoginRequest;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [loadState, setLoadState] = useState(createDesktopSsoLoginLoadState);
  const [controller] = useState(() => createDesktopSsoLoginLoadController(setLoadState));
  const guestRef = useRef<Electron.WebviewTag | null>(null);
  const bindGuest = useCallback((guest: Electron.WebviewTag | null) => {
    guestRef.current = guest;
    controller.bindGuest(guest);
  }, [controller]);

  useEffect(() => {
    // Rebinding also supports React StrictMode's effect cleanup/setup cycle.
    controller.bindGuest(guestRef.current);
    return () => controller.detach();
  }, [controller]);

  return (
    <div className="desktop-sso-login-surface" data-load-state={loadState.status} aria-busy={loadState.status === "loading"}>
      {createElement("webview", {
        key: loadState.attempt,
        ref: bindGuest,
        src: request.url,
        title: request.label,
        className: "desktop-sso-login-webview",
        partition: request.partition,
        useragent: request.userAgent
      })}
      {loadState.status === "loading" ? (
        <div className="desktop-sso-login-surface-overlay desktop-sso-login-surface-loading" role="status">
          {t("sidebar.sso.pageLoading")}
        </div>
      ) : null}
      {loadState.failure ? (
        <DesktopSsoLoginFailure failure={loadState.failure} onRetry={() => controller.retry()} onCancel={onCancel} />
      ) : null}
    </div>
  );
}
