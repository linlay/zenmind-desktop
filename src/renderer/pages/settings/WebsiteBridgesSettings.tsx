import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Switch } from "antd";
import { ImportOutlined, ExportOutlined, ReloadOutlined, DeleteOutlined } from "@ant-design/icons";
import type { WebsiteBridgeResult, WebsiteBridgeView } from "../../../shared/website-bridge";
import { useI18n } from "../../i18n/useI18n";
import "./WebsiteBridgesSettings.css";

export function WebsiteBridgesSettings() {
  const { t } = useI18n();
  const [items, setItems] = useState<WebsiteBridgeView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pagePath, setPagePath] = useState("");
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  const selected = items.find(item => item.id === selectedId);
  const page = selected?.pages.find(page => page.path === pagePath) ?? selected?.pages[0];
  const api = window.electronAPI.settings;
  async function perform(operation: () => Promise<WebsiteBridgeResult>, message?: string) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await operation();
      if (!alive.current) return;
      if (!result.ok) { setError(t(`settings.websiteBridges.error.${result.error}`)); return; }
      setItems(result.items);
      setSelectedId(id => result.selectedId ?? (result.items.some(item => item.id === id) ? id : result.items[0]?.id ?? ""));
      if (message && !result.cancelled) setNotice(message);
    } catch { if (alive.current) setError(t("settings.websiteBridges.error.storageFailed")); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void perform(() => api.listWebsiteBridges());
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSource(""); setSourceError(""); setSourceLoading(Boolean(selected && page));
    if (selected && page) void api.readWebsiteBridgeScript({ id: selected.id, script: page.script }).then(result => {
      if (cancelled) return;
      if (result.ok) setSource(result.script ?? ""); else setSourceError(t(`settings.websiteBridges.error.${result.error}`));
    }).catch(() => { if (!cancelled) setSourceError(t("settings.websiteBridges.error.storageFailed")); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [selected, page?.script, t]);
  const filtered = items.filter(item => `${item.name} ${item.origin} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="website-bridges-settings" aria-label={t("settings.websiteBridges.label")}>
    <header className="website-bridges-header">
      <div><h1>{t("settings.websiteBridges.label")}</h1><p>{t("settings.websiteBridges.description")}</p></div>
      <div className="website-bridges-actions">
        <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => void perform(() => api.listWebsiteBridges())}>{t("settings.websiteBridges.refresh")}</Button>
        <Button type="primary" icon={<ImportOutlined />} loading={busy} onClick={() => void perform(() => api.importWebsiteBridge(), t("settings.websiteBridges.imported"))}>{t("settings.websiteBridges.import")}</Button>
      </div>
    </header>
    {error && <div role="alert" className="website-bridges-error">{error}</div>}
    {notice && <div role="status">{notice}</div>}
    <div className="website-bridges-layout">
      <aside className="website-bridges-list" aria-label={t("settings.websiteBridges.packages")}>
        <Input.Search aria-label={t("settings.websiteBridges.search")} placeholder={t("settings.websiteBridges.search")} value={query} onChange={event => setQuery(event.target.value)} allowClear />
        {filtered.map(item => <button key={item.id} type="button" className={`website-bridge-item${item.id === selectedId ? " is-selected" : ""}`} aria-pressed={item.id === selectedId}
          onClick={() => { setSelectedId(item.id); setPagePath(""); }}>
          <strong>{item.name}</strong><span>{item.origin}</span><small>{item.version} · {t(item.enabled ? "settings.websiteBridges.enabled" : "settings.websiteBridges.disabled")}</small>
        </button>)}
        {!filtered.length && <p>{t(busy ? "settings.websiteBridges.loading" : "settings.websiteBridges.empty")}</p>}
      </aside>
      {selected ? <main className="website-bridge-detail">
        <div className="website-bridge-heading"><div><h2>{selected.name}</h2><span>{selected.id} · {selected.version}</span></div>
          <Switch checked={selected.enabled} disabled={busy} aria-label={t("settings.websiteBridges.enabled")} onChange={enabled => void perform(() => api.setWebsiteBridgeEnabled({ id: selected.id, enabled }), t("settings.websiteBridges.applied"))} />
        </div>
        {selected.description && <p>{selected.description}</p>}
        <dl><dt>{t("settings.websiteBridges.origin")}</dt><dd>{selected.origin}</dd></dl>
        <div className="website-bridges-actions">
          <Button icon={<ImportOutlined />} disabled={busy} onClick={() => void perform(() => api.importWebsiteBridge(selected.id), t("settings.websiteBridges.imported"))}>{t("settings.websiteBridges.update")}</Button>
          <Button icon={<ExportOutlined />} disabled={busy} onClick={() => void perform(() => api.exportWebsiteBridge(selected.id), t("settings.websiteBridges.exported"))}>{t("settings.websiteBridges.export")}</Button>
          <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={() => setRemoveOpen(true)}>{t("settings.websiteBridges.remove")}</Button>
        </div>
        <h3>{t("settings.websiteBridges.pages")}</h3><p className="website-bridge-hint">{t("settings.websiteBridges.pathHint")}</p>
        <div className="website-bridge-routes" role="group" aria-label={t("settings.websiteBridges.pages")}>
          {selected.pages.map(route => <button type="button" key={route.path} aria-pressed={page?.path === route.path} onClick={() => setPagePath(route.path)} className={page?.path === route.path ? "is-selected" : ""}>
            <code>{route.path}</code><span>{route.script}</span>
          </button>)}
        </div>
        <h3>{page?.script}</h3>
        {sourceError && <p role="alert" className="website-bridges-error">{sourceError}</p>}
        {sourceLoading ? <p role="status">{t("settings.websiteBridges.loading")}</p> : <textarea className="website-bridge-source" readOnly spellCheck={false} aria-label={t("settings.websiteBridges.script")} value={source} />}
        <p className="website-bridge-hint">{t("settings.websiteBridges.scriptHint")}</p>
      </main> : <div className="website-bridge-empty">{t("settings.websiteBridges.start")}</div>}
    </div>
    <Modal title={t("settings.websiteBridges.remove")} open={removeOpen} onCancel={() => setRemoveOpen(false)} okButtonProps={{ danger: true, disabled: busy }}
      okText={t("settings.websiteBridges.remove")} cancelText={t("settings.websiteBridges.cancel")}
      onOk={() => { setRemoveOpen(false); if (selected) void perform(() => api.removeWebsiteBridge(selected.id), t("settings.websiteBridges.removed")); }}>
      <p>{t("settings.websiteBridges.removeConfirm", { name: selected?.name ?? "" })}</p>
    </Modal>
  </section>;
}
