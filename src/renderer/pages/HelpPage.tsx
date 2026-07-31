import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopHelpSettings } from "../../shared/help";
import { DESKTOP_HELP_WEBVIEW_PARTITION } from "../../shared/help";
import { useI18n } from "../i18n/useI18n";
import "./HelpPage.css";

type SettingsState =
  | { status: "loading"; settings: null; message: "" }
  | { status: "ready"; settings: DesktopHelpSettings; message: "" }
  | { status: "error"; settings: null; message: string };

export function HelpPage() {
  const { t } = useI18n();
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const requestSequenceRef = useRef(0);
  const [settingsState, setSettingsState] = useState<SettingsState>({
    status: "loading",
    settings: null,
    message: ""
  });
  const [webviewKey, setWebviewKey] = useState(0);
  const [webviewLoading, setWebviewLoading] = useState(true);
  const [webviewError, setWebviewError] = useState("");

  const loadSettings = useCallback(() => {
    requestSequenceRef.current += 1;
    const requestSequence = requestSequenceRef.current;
    setSettingsState({ status: "loading", settings: null, message: "" });
    void window.electronAPI.help.getSettings().then((settings) => {
      if (requestSequence !== requestSequenceRef.current) {
        return;
      }
      if (!settings.url) {
        setSettingsState({
          status: "error",
          settings: null,
          message: t("help.error.notConfigured")
        });
        return;
      }
      setSettingsState({ status: "ready", settings, message: "" });
    }).catch(() => {
      if (requestSequence === requestSequenceRef.current) {
        setSettingsState({
          status: "error",
          settings: null,
          message: t("help.error.notConfigured")
        });
      }
    });
  }, [t]);

  useEffect(() => {
    loadSettings();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [loadSettings]);

  const helpUrl = settingsState.status === "ready" ? settingsState.settings.url : "";

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !helpUrl) {
      return;
    }

    const handleDidStartLoading = () => {
      setWebviewLoading(true);
      setWebviewError("");
    };
    const handleDidStopLoading = () => {
      setWebviewLoading(false);
    };
    const handleDomReady = () => {
      setWebviewLoading(false);
    };
    const handleDidFailLoad = (event: Event) => {
      const details = event as Event & {
        errorCode?: number;
        isMainFrame?: boolean;
      };
      if (details.errorCode === -3 || details.isMainFrame === false) {
        return;
      }
      setWebviewLoading(false);
      setWebviewError(t("help.error.loadFailed"));
    };
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    return () => {
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
    };
  }, [helpUrl, t, webviewKey]);

  const retryWebview = () => {
    setWebviewError("");
    setWebviewLoading(true);
    setWebviewKey((current) => current + 1);
  };

  if (settingsState.status !== "ready") {
    return (
      <section className="help-webview-page embedded-surface-page">
        <div className="help-webview-status" role="status">
          <p>
            {settingsState.status === "loading"
              ? t("help.loading")
              : settingsState.message}
          </p>
          {settingsState.status === "error" ? (
            <button type="button" onClick={loadSettings}>
              {t("common.retry")}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="help-webview-page embedded-surface-page">
      <div className="embedded-surface-frame-shell help-webview-frame-shell">
        {createElement("webview", {
          key: webviewKey,
          ref: (node: Electron.WebviewTag | null): void => {
            webviewRef.current = node;
          },
          src: settingsState.settings.url,
          title: t("nav.help"),
          partition: DESKTOP_HELP_WEBVIEW_PARTITION,
          allowpopups: "true",
          className: "embedded-surface-frame help-webview-frame"
        })}
        {webviewLoading && !webviewError ? (
          <div className="help-webview-overlay" role="status">
            <span className="help-webview-spinner" aria-hidden="true" />
            <p>{t("help.loading")}</p>
          </div>
        ) : null}
        {webviewError ? (
          <div className="help-webview-overlay" role="alert">
            <p>{webviewError}</p>
            <button type="button" onClick={retryWebview}>
              {t("common.retry")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
