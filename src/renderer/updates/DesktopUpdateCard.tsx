import { useState } from "react";
import { Button, Progress, Switch } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useDesktopUpdates } from "./useDesktopUpdates";
import "./updates.css";

export function DesktopUpdateCard({ compact = false }: { compact?: boolean }) {
  const state = useDesktopUpdates();
  const { t, locale } = useI18n();
  const [requestFailed, setRequestFailed] = useState(false);
  if (!state || (compact && !["available", "downloading", "verifying", "ready", "installing", "error"].includes(state.phase))) return null;
  const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  const notes = state.releaseNotes?.[locale] ?? state.releaseNotes?.["en-US"] ?? state.releaseNotes?.["zh-CN"] ?? [];
  async function run(action: () => Promise<unknown>) {
    setRequestFailed(false);
    try { await action(); } catch { setRequestFailed(true); }
  }
  function install() {
    const dirty = document.querySelector('[data-native-image-dirty="true"], [data-work-panel-document-dirty="true"], [data-webclient-document-dirty="true"]');
    if (dirty && !window.confirm(t("updates.confirmDrafts"))) return;
    void run(() => window.electronAPI.updates.install());
  }
  return <section className={`desktop-update-card${compact ? " is-compact" : " settings-item-card"}`} aria-label={t("updates.title")}>
    <div className="desktop-update-heading">
      <strong aria-live="polite">{t(`updates.phase.${state.phase}`)}</strong>
      {state.version ? <span className="desktop-update-version">v{state.version}</span> : null}
    </div>
    {state.version && !compact ? <p>{`v${state.currentVersion} → v${state.version}`}</p> : null}
    {state.phase === "ready" || state.phase === "installing" ? <p>{t("updates.restartHint")}</p> : null}
    {state.phase === "downloading" ? <Progress percent={state.progress} size="small" /> : null}
    {state.error || requestFailed ? <p role="alert">{t(`updates.error.${requestFailed ? "operationFailed" : (state.error ?? "operationFailed")}`)}</p> : null}
    {notes.length ? <details><summary>{t("updates.releaseNotes")}</summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details> : null}
    <div className="desktop-update-actions">
      {state.phase === "ready" ? <Button size={compact ? "small" : "middle"} type="primary" disabled={!state.canInstall} onClick={install}>{t("updates.install")}</Button> : null}
      {state.phase === "available" ? <Button type="primary" onClick={() => void run(() => window.electronAPI.updates.download())}>{t("updates.download")}</Button> : null}
      {state.phase !== "disabled" && state.phase !== "ready" ? <Button size={compact ? "small" : "middle"} disabled={busy} loading={busy} onClick={() => void run(() => window.electronAPI.updates.check())}>{t(state.phase === "error" ? "updates.retry" : "updates.check")}</Button> : null}
    </div>
    {!state.canInstall && state.phase === "ready" ? <p>{t("updates.developmentHint")}</p> : null}
    {!compact && state.phase !== "disabled" ? <label className="desktop-update-preference"><Switch size="small" checked={state.autoDownload} disabled={busy} onChange={(value) => void run(() => window.electronAPI.updates.setAutoDownload(value))} />{t("updates.autoDownload")}</label> : null}
  </section>;
}
