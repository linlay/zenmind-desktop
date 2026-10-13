import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createSurfaceIdentity } from "../../shared/surface-identity";
import type { SelectionExplainWindowState } from "../../shared/selection-explain-window";
import { useI18n } from "../i18n/useI18n";
import "./SelectionExplainWindowPage.css";

const ServiceWebviewSurface = lazy(() =>
  import("../service-webview/ServiceWebviewSurface").then((module) => ({
    default: module.ServiceWebviewSurface,
  }))
);

export function SelectionExplainWindowPage() {
  const { t } = useI18n();
  const [state, setState] = useState<SelectionExplainWindowState | null>(null);
  const [platform, setPlatform] = useState(() => {
    // Keep window controls usable before (or if) the platform IPC resolves.
    // The trusted preload result remains authoritative once available.
    if (/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)) return "darwin";
    if (/Windows/i.test(navigator.userAgent)) return "win32";
    return "linux";
  });
  const hostTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  useEffect(() => {
    let active = true;
    void window.electronAPI.settings.getPlatform().then((value) => {
      if (active) setPlatform(value);
    }).catch(() => undefined);
    void window.electronAPI.selectionExplain.getState().then((next) => {
      if (active && next) setState(next);
    });
    const unsubscribe = window.electronAPI.selectionExplain.onState((next) => {
      setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const embedPath = useMemo(() => {
    if (state?.status !== "ready") return "";
    return `/explain/${encodeURIComponent(state.chatId)}?runId=${encodeURIComponent(state.runId)}`;
  }, [state]);

  return (
    <main className={`selection-explain-window${platform === "darwin" ? " is-mac" : platform === "win32" ? " is-windows" : ""}`}>
      <header className="selection-explain-window-header">
        <strong>{t("webviewSelectionToolbar.moreDetails")}</strong>
        {platform && platform !== "darwin" ? <div className="selection-explain-window-controls">
          <button
            type="button"
            aria-label={t("window.minimize")}
            onClick={() => void window.electronAPI.selectionExplain.minimize()}
          >
            <span aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => void window.electronAPI.selectionExplain.close()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div> : null}
      </header>
      <section className="selection-explain-window-body">
        {!state || state.status === "pending" ? (
          <div className="selection-explain-window-status" aria-live="polite">
            <span className="selection-explain-window-spinner" aria-hidden="true" />
            <p>{t("selectionExplain.preparing")}</p>
          </div>
        ) : state.status === "error" ? (
          <div className="selection-explain-window-status is-error" role="alert">
            <p>{t("selectionExplain.failed")}</p>
            <small>{state.code}</small>
          </div>
        ) : (
          <Suspense fallback={null}>
            <ServiceWebviewSurface
              key={state.requestId}
              active
              embedPath={embedPath}
              hostTheme={hostTheme}
              loadInitialEmbeddedUrlDirectly
              ownerChatId={state.chatId}
              serviceId="agent-webclient"
              skipContextRegistration
              surfaceIdentity={createSurfaceIdentity("selection-explain", "", {
                ownerChatId: state.chatId,
              })}
              surfaceLabel={t("webviewSelectionToolbar.moreDetails")}
              suppressInitialLoadingCopy
            />
          </Suspense>
        )}
      </section>
    </main>
  );
}
