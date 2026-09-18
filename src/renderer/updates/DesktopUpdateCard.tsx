import { useState } from "react";
import { Button, Progress, Switch } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useDesktopUpdates } from "./useDesktopUpdates";
import "./updates.css";

export function DesktopUpdateCard({ compact = false, onViewAbout, onDownload }: {
  compact?: boolean;
  onViewAbout?: () => void;
  onDownload?: () => void;
}) {
  const state = useDesktopUpdates();
  const { t, locale } = useI18n();
  const [requestFailed, setRequestFailed] = useState(false);
  if (!state || (compact && (requestFailed || state.error)) || (compact && !["available", "downloading", "verifying", "ready", "installing"].includes(state.phase))) return null;
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
  if (compact) return <section className="desktop-update-card is-compact" aria-label={t("updates.title")}>
    <div className="desktop-update-menu-title">{state.phase === "available"
      ? t("updates.menuVersion", { version: state.version ?? "" })
      : `${t(`updates.phase.${state.phase}`)}${state.phase === "downloading" ? ` ${Math.round(state.progress)}%` : ""} · v${state.version ?? ""}`}</div>
    <div className="desktop-update-actions">
      {state.phase === "available" ? <Button size="small" type="primary" onClick={() => onDownload ? onDownload() : void run(() => window.electronAPI.updates.download())}>{t("updates.download")}</Button> : null}
      <Button size="small" type="link" onClick={onViewAbout}>{t("updates.viewAbout")}</Button>
    </div>
  </section>;
  return <section className={`desktop-update-card${compact ? " is-compact" : " is-settings"}`} aria-label={t("updates.title")}>
    <div className="desktop-update-heading">
      <strong>{compact ? t(`updates.phase.${state.phase}`) : t(state.source === "test" ? "updates.test.title" : "updates.title")}</strong>
      {state.version ? <span className="desktop-update-version">{compact ? `v${state.version}` : `v${state.currentVersion} → v${state.version}`}</span> : null}
    </div>
    {!compact ? <p className="desktop-update-status" aria-live="polite">{t(`updates.phase.${state.phase}`)}</p> : null}
    {state.phase === "ready" || state.phase === "installing" ? <p>{t("updates.restartHint")}</p> : null}
    {state.phase === "downloading" ? <Progress percent={state.progress} size="small" /> : null}
    {state.error || requestFailed ? <p role="alert">{t(`updates.error.${requestFailed ? "operationFailed" : (state.error ?? "operationFailed")}`)}</p> : null}
    {notes.length ? <details><summary>{t("updates.releaseNotes")}</summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details> : null}
    <div className="desktop-update-actions">
      {state.phase === "ready" ? <Button size={compact ? "small" : "middle"} type="primary" disabled={!state.canInstall} onClick={install}>{t("updates.install")}</Button> : null}
      {state.phase === "available" ? <Button type="primary" onClick={() => void run(() => window.electronAPI.updates.download())}>{t("updates.download")}</Button> : null}
      {state.phase !== "disabled" && state.phase !== "ready" && (state.source !== "test" || state.phase === "error") ? <Button size={compact ? "small" : "middle"} disabled={busy} loading={busy} onClick={() => void run(() => state.source === "test" ? window.electronAPI.updates.download() : window.electronAPI.updates.check())}>{t(state.phase === "error" ? "updates.retry" : "updates.check")}</Button> : null}
    </div>
    {!state.canInstall && state.phase === "ready" ? <p>{t("updates.developmentHint")}</p> : null}
    {!compact && state.source !== "test" && state.phase !== "disabled" ? <label className="desktop-update-preference"><Switch size="small" checked={state.autoDownload} disabled={busy} onChange={(value) => void run(() => window.electronAPI.updates.setAutoDownload(value))} />{t("updates.autoDownload")}</label> : null}
  </section>;
}
