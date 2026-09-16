import { useState } from "react";
import { Button, Input, Radio } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useDesktopUpdates } from "./useDesktopUpdates";
import { DesktopUpdateCard } from "./DesktopUpdateCard";
import "./updates.css";

export function DebugUpdatePanel() {
  const { t } = useI18n();
  const state = useDesktopUpdates();
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [size, setSize] = useState("");
  const [sha256, setSha256] = useState("");
  const [json, setJson] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = pending || !state || ["checking", "downloading", "verifying", "installing"].includes(state.phase);
  async function apply(clear = false) {
    setPending(true); setError("");
    try {
      if (clear) await window.electronAPI.updates.clearTest();
      else await window.electronAPI.updates.loadTest(mode === "json"
        ? { manifest: JSON.parse(json) }
        : { version: version.trim(), url: url.trim(), size: Number(size), sha256: sha256.trim() });
    } catch { setError(t(clear ? "updates.test.exitFailed" : "updates.test.invalid")); }
    finally { setPending(false); }
  }
  return <div className="settings-about-stack">
    <section className="desktop-update-card is-settings" aria-label={t("updates.test.title")}>
      <strong>{t("updates.test.title")}</strong>
      <p>{t("updates.test.description")}</p>
      <Radio.Group value={mode} disabled={busy} onChange={(event) => setMode(event.target.value)}>
        <Radio.Button value="fields">{t("updates.test.fields")}</Radio.Button>
        <Radio.Button value="json">{t("updates.test.json")}</Radio.Button>
      </Radio.Group>
      <form className="desktop-update-test-form" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
        <fieldset disabled={busy}>
          {mode === "json" ? <label>{t("updates.test.json")}<Input.TextArea value={json} onChange={(event) => setJson(event.target.value)} rows={10} maxLength={262144} spellCheck={false} required disabled={busy} /></label> : <>
            <label>{t("updates.test.version")}<Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.4.6" required disabled={busy} /></label>
            <label>{t("updates.test.url")}<Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" required disabled={busy} /></label>
            <label>{t("updates.test.size")}<Input value={size} onChange={(event) => setSize(event.target.value)} inputMode="numeric" required disabled={busy} /></label>
            <label>SHA-256<Input value={sha256} onChange={(event) => setSha256(event.target.value)} maxLength={64} required disabled={busy} /></label>
          </>}
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
