import { useEffect, useRef, useState } from "react";
import { Input, Modal, Switch, Tooltip } from "antd";
import { CloseOutlined, CopyOutlined, DeleteOutlined, EditOutlined, ExportOutlined, EyeInvisibleOutlined, EyeOutlined, ImportOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  WEBSITE_CREDENTIAL_BACKUP_PASSWORD_MIN_LENGTH,
  WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH,
  WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH,
  WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH,
  type WebsiteCredentialResult,
  type WebsiteCredentialSecret,
  type WebsiteCredentialSummary,
  type WebsiteCredentialVaultStatus
} from "../../../shared/website-credentials";
import { useI18n } from "../../i18n/useI18n";
import { SettingsSidebarIcon } from "../../app-shell/navigation/SettingsSidebarIcon";
import { SettingsActionButton } from "./SettingsActionButton";
import "./WebsiteCredentialsSettings.css";

// A revealed password leaves the screen on its own.
const REVEAL_VISIBLE_MS = 30_000;
type Draft = { id: string | null; origin: string; username: string; password: string; note: string };

export function WebsiteCredentialsSettings() {
  const { t } = useI18n();
  const [items, setItems] = useState<WebsiteCredentialSummary[]>([]);
  const [vault, setVault] = useState<WebsiteCredentialVaultStatus>({ state: "ready" });
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [neverSaveOrigins, setNeverSaveOrigins] = useState<string[]>([]);
  const [neverSaveOpen, setNeverSaveOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealed, setRevealed] = useState<WebsiteCredentialSecret | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  // "export" asks for a new backup password; "import" asks for the password of the backup just chosen.
  const [backup, setBackup] = useState<{ mode: "export" | "import"; password: string; confirm: string } | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const api = window.electronAPI.settings;
  const selected = items.find(item => item.id === selectedId);
  const secret = revealed && revealed.id === selectedId ? revealed : null;
  const available = vault.state === "ready";

  /** Returns whether the operation succeeded. */
  async function perform(operation: () => Promise<WebsiteCredentialResult>, message?: string) {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await operation();
      if (!alive.current) return false;
      if (!result.ok) {
        if (result.error === "backupPasswordRequired") setBackup({ mode: "import", password: "", confirm: "" });
        else setError(t(`settings.websiteCredentials.error.${result.error}`));
        return false;
      }
      setItems(result.credentials); setVault(result.vault); setCaptureEnabled(result.captureEnabled); setNeverSaveOrigins(result.neverSaveOrigins);
      setSelectedId(id => result.credentials.some(item => item.id === id) ? id : result.credentials[0]?.id ?? "");
      if (result.imported) setNotice(t("settings.websiteCredentials.imported", result.imported));
      else if (message && !result.cancelled) setNotice(message);
      return true;
    } catch { if (alive.current) setError(t("settings.websiteCredentials.error.storageFailed")); return false; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  /** System authentication happens in Main; this only receives the single requested secret. */
  async function reveal(id: string) {
    if (locked.current) return null;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.revealWebsiteCredential(id);
      if (!alive.current) return null;
      if (!result.ok) { setError(t(`settings.websiteCredentials.error.${result.error}`)); return null; }
      return result.secret;
    } catch { if (alive.current) setError(t("settings.websiteCredentials.error.storageFailed")); return null; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void perform(() => api.getWebsiteCredentials());
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), REVEAL_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  useEffect(() => { setRevealed(null); }, [selectedId]);
  // Locking the screen hides a revealed password and discards an edit that holds one.
  useEffect(() => api.onWebsiteCredentialsLocked(() => {
    setRevealed(null);
    setDraft(current => current?.id ? null : current);
  }), []);

  async function copyPassword(id: string) {
    const value = secret ?? await reveal(id);
    if (!value) return;
    try { await navigator.clipboard.writeText(value.password); setNotice(t("settings.websiteCredentials.copied")); }
    catch { setError(t("settings.websiteCredentials.error.storageFailed")); }
  }
  async function edit(id: string) {
    const value = secret ?? await reveal(id);
    if (value) setDraft({ id, origin: value.origin, username: value.username, password: value.password, note: selected?.note ?? "" });
  }
  async function saveDraft() {
    if (!draft) return;
    const saved = draft.id
      ? await perform(() => api.updateWebsiteCredential({ id: draft.id!, username: draft.username, password: draft.password, note: draft.note }), t("settings.websiteCredentials.saved"))
      : await perform(() => api.addWebsiteCredential({ origin: draft.origin, username: draft.username, password: draft.password, note: draft.note }), t("settings.websiteCredentials.saved"));
    if (saved && alive.current) { setDraft(null); setRevealed(null); }
  }

  async function submitBackup() {
    if (!backup) return;
    const { mode, password } = backup;
    const done = mode === "export"
      ? await perform(() => api.exportWebsiteCredentials({ password }), t("settings.websiteCredentials.exported"))
      : await perform(() => api.importWebsiteCredentials({ password }));
    if (done && alive.current) setBackup(null);
  }

  const backupValid = Boolean(backup && (backup.mode === "import" ? backup.password : backup.password.length >= WEBSITE_CREDENTIAL_BACKUP_PASSWORD_MIN_LENGTH && backup.password === backup.confirm));
  const needle = query.trim().toLowerCase();
  const filtered = items.filter(item => `${item.origin} ${item.maskedUsername} ${item.note}`.toLowerCase().includes(needle));
  const draftValid = Boolean(draft && draft.origin.trim() && draft.username && draft.password);
  return <section className="control-center-page workspace-wide service-workspace-page web-settings-page website-credentials-settings" aria-label={t("settings.websiteCredentials.label")}>
    <header className="settings-page-head">
      <div className="settings-page-head-copy"><h1>{t("settings.websiteCredentials.label")}</h1><p className="page-copy">{t("settings.websiteCredentials.description")}</p></div>
      <div className="settings-page-head-action website-credential-capture">
        <Tooltip title={t("settings.websiteCredentials.capture")}>
          <Switch checked={captureEnabled} disabled={busy || !available} aria-label={t("settings.websiteCredentials.capture")} onChange={enabled => void perform(() => api.setWebsiteCredentialCapture(enabled), t("settings.websiteCredentials.saved"))} />
        </Tooltip>
      </div>
    </header>
    {vault.state === "unavailable" && <div role="alert" className="website-credentials-error">{t(`settings.websiteCredentials.unavailable.${vault.reason}`)}</div>}
    {error && <div role="alert" className="website-credentials-error">{error}</div>}
    {notice && <div role="status">{notice}</div>}
    <div className="control-center-shell web-settings-shell">
      <aside className="service-sider service-catalog web-settings-catalog" aria-label={t("settings.websiteCredentials.accounts")}>
        <div className="management-group-scroll">
        <div className="service-group-head">
          <div className="service-group-copy"><h2>{t("settings.websiteCredentials.accounts")}</h2></div>
          <div className="service-title-actions">
            <SettingsActionButton label={t("common.refresh")} icon={<ReloadOutlined />} disabled={busy} onClick={() => void perform(() => api.getWebsiteCredentials())} />
            <SettingsActionButton label={t("settings.websiteCredentials.import")} icon={<ImportOutlined />} disabled={busy || !available} onClick={() => void perform(() => api.importWebsiteCredentials())} />
            <SettingsActionButton label={t("settings.websiteCredentials.export")} icon={<ExportOutlined />} disabled={busy || !available || !items.length} onClick={() => setBackup({ mode: "export", password: "", confirm: "" })} />
            <SettingsActionButton label={t("settings.websiteCredentials.add")} icon={<PlusOutlined />} tone="primary" disabled={busy || !available} onClick={() => setDraft({ id: null, origin: "https://", username: "", password: "", note: "" })} />
          </div>
        </div>
        <div className="website-credentials-search">
          <div className="sidebar-settings-search">
            <input ref={searchInputRef} type="search" aria-label={t("settings.websiteCredentials.search")} placeholder={t("settings.websiteCredentials.search")} value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" className="sidebar-settings-search-clear" aria-label={t("common.clear")} onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}><CloseOutlined /></button>}
          </div>
          {neverSaveOrigins.length > 0 && <button type="button" className="website-credential-link website-credential-exclusions" onClick={() => setNeverSaveOpen(true)}>{t("settings.websiteCredentials.neverSave", { count: neverSaveOrigins.length })}</button>}
        </div>
        <div className="service-nav-list">
        {filtered.map(item => <button key={item.id} type="button" className={`website-credential-item${item.id === selectedId ? " is-selected" : ""}`} aria-pressed={item.id === selectedId} onClick={() => setSelectedId(item.id)}>
          <strong>{new URL(item.origin).host}</strong><span>{item.maskedUsername}</span>
          {(item.isSiteDefault || !item.agentAllowed) && <small>{[item.isSiteDefault && t("settings.websiteCredentials.defaultBadge"), !item.agentAllowed && t("settings.websiteCredentials.agentBlockedBadge")].filter(Boolean).join(" · ")}</small>}
        </button>)}
        {!filtered.length && <p className="service-group-empty">{t(busy ? "settings.websiteCredentials.loading" : "settings.websiteCredentials.empty")}</p>}
        </div>
        </div>
      </aside>
      {selected ? <article className="control-center-detail management-detail-group web-settings-detail">
        <div className="management-group-scroll service-detail-scroll">
        <section className="service-card control-center-service-hero">
          <div className="control-center-service-head">
            <div className="control-center-service-main">
              <div className="service-hero-icon website-credential-icon" aria-hidden="true"><SettingsSidebarIcon kind="websiteCredentials" /></div>
              <div className="service-hero-copy">
                <div className="service-hero-title-line"><h2>{new URL(selected.origin).host}</h2></div>
                <p title={selected.origin}>{selected.origin}</p>
              </div>
            </div>
            <div className="service-title-actions">
              <SettingsActionButton label={t("settings.websiteCredentials.edit")} icon={<EditOutlined />} disabled={busy} onClick={() => void edit(selected.id)} />
              <SettingsActionButton label={t("common.delete")} icon={<DeleteOutlined />} tone="danger" disabled={busy} onClick={() => setRemoveOpen(true)} />
            </div>
          </div>
          <dl className="website-credential-meta"><dt>{t("settings.websiteCredentials.username")}</dt><dd><code>{secret ? secret.username : selected.maskedUsername}</code></dd></dl>
          <dl className="website-credential-meta"><dt>{t("settings.websiteCredentials.password")}</dt><dd>
            <code>{secret ? secret.password : "••••••••"}</code>
            {secret
              ? <SettingsActionButton label={t("settings.websiteCredentials.hide")} icon={<EyeInvisibleOutlined />} onClick={() => setRevealed(null)} />
              : <SettingsActionButton label={t("settings.websiteCredentials.reveal")} icon={<EyeOutlined />} disabled={busy} onClick={() => void reveal(selected.id).then(value => { if (value && alive.current) setRevealed(value); })} />}
            <SettingsActionButton label={t("settings.websiteCredentials.copyPassword")} icon={<CopyOutlined />} disabled={busy} onClick={() => void copyPassword(selected.id)} />
          </dd></dl>
          {selected.note && <dl className="website-credential-meta"><dt>{t("settings.websiteCredentials.note")}</dt><dd>{selected.note}</dd></dl>}
          {secret && <p className="website-credential-hint">{t("settings.websiteCredentials.authHint")}</p>}
        </section>
        <section className="service-card">
          <div className="website-credential-option">
            <strong>{t("settings.websiteCredentials.agentAllowed")}</strong>
            <Switch size="small" checked={selected.agentAllowed} disabled={busy} aria-label={t("settings.websiteCredentials.agentAllowed")} onChange={agentAllowed => void perform(() => api.updateWebsiteCredential({ id: selected.id, agentAllowed }), t("settings.websiteCredentials.saved"))} />
          </div>
          <div className="website-credential-option">
            <strong>{t("settings.websiteCredentials.siteDefault")}</strong>
            <Switch size="small" checked={selected.isSiteDefault} disabled={busy} aria-label={t("settings.websiteCredentials.siteDefault")} onChange={isSiteDefault => void perform(() => api.updateWebsiteCredential({ id: selected.id, isSiteDefault }), t("settings.websiteCredentials.saved"))} />
          </div>
        </section>
        </div>
      </article> : <div className="service-card control-center-detail control-center-empty website-credential-empty">{t("settings.websiteCredentials.start")}</div>}
    </div>
    <Modal title={t(draft?.id ? "settings.websiteCredentials.edit" : "settings.websiteCredentials.add")} open={Boolean(draft)} destroyOnClose onCancel={() => setDraft(null)}
      okText={t("common.save")} cancelText={t("common.cancel")} okButtonProps={{ disabled: busy || !draftValid }} onOk={() => void saveDraft()}>
      {draft && <div className="website-credential-form">
        <label>{t("settings.websiteCredentials.site")}<Input value={draft.origin} disabled={Boolean(draft.id)} placeholder="https://" spellCheck={false} onChange={event => setDraft({ ...draft, origin: event.target.value })} /></label>
        <label>{t("settings.websiteCredentials.username")}<Input value={draft.username} maxLength={WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH} spellCheck={false} autoComplete="off" onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
        <label>{t("settings.websiteCredentials.password")}<Input.Password value={draft.password} maxLength={WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH} autoComplete="new-password" onChange={event => setDraft({ ...draft, password: event.target.value })} /></label>
        <label>{t("settings.websiteCredentials.note")}<Input value={draft.note} maxLength={WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label>
        {!draft.id && <p className="website-credential-hint">{t("settings.websiteCredentials.siteHint")}</p>}
      </div>}
    </Modal>
    <Modal title={t(backup?.mode === "import" ? "settings.websiteCredentials.import" : "settings.websiteCredentials.export")} open={Boolean(backup)} destroyOnClose onCancel={() => setBackup(null)}
      okText={t(backup?.mode === "import" ? "settings.websiteCredentials.import" : "settings.websiteCredentials.export")} cancelText={t("common.cancel")} okButtonProps={{ disabled: busy || !backupValid }} onOk={() => void submitBackup()}>
      {backup && <div className="website-credential-form">
        {error && <p role="alert" className="website-credentials-error">{error}</p>}
        <label>{t("settings.websiteCredentials.backupPassword")}<Input.Password value={backup.password} autoComplete="new-password" onChange={event => setBackup({ ...backup, password: event.target.value })} /></label>
        {backup.mode === "export" && <label>{t("settings.websiteCredentials.backupPasswordConfirm")}<Input.Password value={backup.confirm} autoComplete="new-password" onChange={event => setBackup({ ...backup, confirm: event.target.value })} /></label>}
        <p className="website-credential-hint">{t(backup.mode === "export" ? "settings.websiteCredentials.exportHint" : "settings.websiteCredentials.importPasswordHint")}</p>
      </div>}
    </Modal>
    <Modal title={t("settings.websiteCredentials.neverSave", { count: neverSaveOrigins.length })} open={neverSaveOpen} footer={null} onCancel={() => setNeverSaveOpen(false)}>
      {neverSaveOrigins.length ? neverSaveOrigins.map(origin => <div key={origin} className="website-credential-option">
        <code>{origin}</code>
        <button type="button" className="website-credential-link" disabled={busy} onClick={() => void perform(() => api.setWebsiteCredentialNeverSave({ origin, never: false }))}>{t("settings.websiteCredentials.neverSaveRemove")}</button>
      </div>) : <p className="website-credential-hint">{t("settings.websiteCredentials.neverSaveEmpty")}</p>}
    </Modal>
    <Modal title={t("common.delete")} open={removeOpen} onCancel={() => setRemoveOpen(false)} okButtonProps={{ danger: true, disabled: busy }}
      okText={t("common.delete")} cancelText={t("common.cancel")}
      onOk={() => { setRemoveOpen(false); if (selected) void perform(() => api.removeWebsiteCredential(selected.id), t("settings.websiteCredentials.removed")); }}>
      <p>{t("settings.websiteCredentials.removeConfirm", { site: selected ? new URL(selected.origin).host : "", account: selected?.maskedUsername ?? "" })}</p>
    </Modal>
  </section>;
}
