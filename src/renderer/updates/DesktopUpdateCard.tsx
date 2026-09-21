import { useState } from "react";
import { Button, Progress, Switch } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useDesktopUpdates } from "./useDesktopUpdates";
import "./updates.css";
import { desktopUpdateAction } from "../../shared/desktop-updates";
import { DesktopUpdateConfirm } from "./DesktopUpdateConfirm";

export function DesktopUpdateCard({ compact = false, onViewAbout, onDownload }: {
  compact?: boolean;
  onViewAbout?: () => void;
  onDownload?: () => void;
}) {
  const state = useDesktopUpdates();
  const { t, locale } = useI18n();
  const [requestFailed, setRequestFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  if (!state || (compact && !state.version)) return null;
  const action = desktopUpdateAction(state);
  const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  const notes = state.releaseNotes?.[locale] ?? state.releaseNotes?.["en-US"] ?? state.releaseNotes?.["zh-CN"] ?? [];
  async function run(action: () => Promise<unknown>) {
    setRequestFailed(false);
    try { await action(); } catch { setRequestFailed(true); }
  }
  async function install() {
    if (pending || !state?.canInstall || action !== "install") return;
    setPending(true);
    try { await run(() => window.electronAPI.updates.install()); }
    finally { setPending(false); setConfirmOpen(false); }
  }
  const error = state.error || requestFailed
    ? <p role="alert">{t(`updates.error.${requestFailed ? "operationFailed" : (state.error ?? "operationFailed")}`)}</p> : null;
  const confirm = <DesktopUpdateConfirm open={confirmOpen} pending={pending} canInstall={state.canInstall && action === "install"}
    onConfirm={() => void install()} onCancel={() => setConfirmOpen(false)} />;
  const installButton = action === "install" ? <Button size={compact ? "small" : "middle"} type="primary" disabled={!state.canInstall} onClick={() => setConfirmOpen(true)}>{t(state.error ? "updates.retryInstall" : "updates.install")}</Button> : null;
  if (compact) return <section className="desktop-update-card is-compact" aria-label={t("updates.title")}>
    <div className="desktop-update-menu-title">{state.phase === "available"
      ? t("updates.menuVersion", { version: state.version ?? "" })
      : `${t(`updates.phase.${state.phase}`)}${state.phase === "downloading" ? ` ${Math.round(state.progress)}%` : ""} · v${state.version ?? ""}`}</div>
    {error}
    {state.restartRequired ? <p>{t("updates.restartRequired")}</p> : null}
    {confirm}
    <div className="desktop-update-actions">
      {installButton}
      {action === "download" ? <Button size="small" type="primary" onClick={() => onDownload ? onDownload() : void run(() => window.electronAPI.updates.download())}>{t("updates.download")}</Button> : null}
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
    {error}
    {state.restartRequired ? <p>{t("updates.restartRequired")}</p> : null}
    {confirm}
    {notes.length ? <details><summary>{t("updates.releaseNotes")}</summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details> : null}
    <div className="desktop-update-actions">
      {installButton}
      {action === "download" ? <Button type="primary" onClick={() => void run(() => window.electronAPI.updates.download())}>{t("updates.download")}</Button> : null}
      {action === "check" && state.source !== "test" ? <Button size={compact ? "small" : "middle"} disabled={busy} loading={busy} onClick={() => void run(() => window.electronAPI.updates.check())}>{t(state.phase === "error" ? "updates.retry" : "updates.check")}</Button> : null}
    </div>
    {!state.canInstall && state.phase === "ready" ? <p>{t("updates.developmentHint")}</p> : null}
    {!compact && state.source !== "test" && state.phase !== "disabled" ? <label className="desktop-update-preference"><Switch size="small" checked={state.autoDownload} disabled={busy} onChange={(value) => void run(() => window.electronAPI.updates.setAutoDownload(value))} />{t("updates.autoDownload")}</label> : null}
  </section>;
}
