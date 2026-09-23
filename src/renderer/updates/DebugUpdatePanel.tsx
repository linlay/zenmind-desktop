import { useEffect, useState } from "react";
import { Button, Input } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useDesktopUpdates } from "./useDesktopUpdates";
import { DesktopUpdateCard } from "./DesktopUpdateCard";
import "./updates.css";

export function DebugUpdatePanel() {
  const { t } = useI18n();
  const state = useDesktopUpdates();
  const [nativeMac, setNativeMac] = useState(false);
  useEffect(() => { let active = true; void window.electronAPI.settings.getPlatform().then(platform => { if (active) setNativeMac(platform === "darwin"); }).catch(() => { /* Keep the stricter form if platform discovery fails. */ }); return () => { active = false; }; }, []);
  const [signature, setSignature] = useState("");
  const [json, setJson] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = pending || !state || ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  async function apply(clear = false) {
    setPending(true); setError("");
    try {
      if (clear) await window.electronAPI.updates.clearTest();
      else await window.electronAPI.updates.loadTest({ manifest: json, signature });
    } catch { setError(t(clear ? "updates.test.exitFailed" : "updates.test.invalid")); }
    finally { setPending(false); }
  }
  return <div className="settings-about-stack">
    <section className="desktop-update-card is-settings" aria-label={t("updates.test.title")}>
      <strong>{t("updates.test.title")}</strong>
      <p>{t(nativeMac ? "updates.test.macDescription" : "updates.test.description")}</p>
      <form className="desktop-update-test-form" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
        <fieldset disabled={busy}>
          <label>{t("updates.test.json")}<Input.TextArea value={json} onChange={(event) => setJson(event.target.value)} rows={10} maxLength={262144} spellCheck={false} required disabled={busy} /></label>
          {!nativeMac && <label>{t("updates.test.signature")}<Input.TextArea value={signature} onChange={(event) => setSignature(event.target.value)} rows={2} maxLength={128} spellCheck={false} required disabled={busy} /></label>}
          <div className="desktop-update-actions">
            <Button htmlType="submit" type="primary" disabled={busy} loading={pending}>{t("updates.test.load")}</Button>
            {state?.source === "test" ? <Button disabled={busy} onClick={() => void apply(true)}>{t("updates.test.exit")}</Button> : null}
          </div>
        </fieldset>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {!state?.canInstall ? <p>{t("updates.developmentHint")}</p> : null}
    </section>
    {state?.source === "test" ? <DesktopUpdateCard /> : null}
  </div>;
}
