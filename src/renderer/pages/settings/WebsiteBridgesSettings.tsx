import { useEffect, useRef, useState } from "react";
import { Modal, Switch } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { websiteBridgePageScripts, type WebsiteBridgeMatchRule, type WebsiteBridgeResult, type WebsiteBridgeView } from "../../../shared/website-bridge";
import { useI18n } from "../../i18n/useI18n";
import { SettingsSidebarIcon } from "../../app-shell/navigation/SettingsSidebarIcon";
import { SettingsActionButton } from "./SettingsActionButton";
import "./WebsiteBridgesSettings.css";

// One readable line per rule: all conditions of a rule must hold, any rule selects the page.
const ruleText = (rule: WebsiteBridgeMatchRule) => [
  ...Object.entries(rule.hashQuery ?? {}).map(([name, value]) => `#${name}=${value}`),
  ...(rule.title !== undefined ? [`title="${rule.title}"`] : []),
  ...(rule.text !== undefined ? [`text="${rule.text}"`] : []),
].join(" & ");

export function WebsiteBridgesSettings() {
  const { t } = useI18n();
  const [items, setItems] = useState<WebsiteBridgeView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageId, setPageId] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selected = items.find(item => item.id === selectedId);
  const pageIds = Object.keys(selected?.pages ?? {});
  const page = selected && pageIds.includes(pageId) ? pageId : pageIds[0];
  const scripts = selected && page ? websiteBridgePageScripts(selected, page) : [];
  const script = scripts.includes(scriptPath) ? scriptPath : scripts[0];
  const origins = Object.entries(selected?.origins ?? {});
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
    setSource(""); setSourceError(""); setSourceLoading(Boolean(selected && script));
    if (selected && script) void api.readWebsiteBridgeScript({ id: selected.id, script }).then(result => {
      if (cancelled) return;
      if (result.ok) setSource(result.script ?? ""); else setSourceError(t(`settings.websiteBridges.error.${result.error}`));
    }).catch(() => { if (!cancelled) setSourceError(t("settings.websiteBridges.error.storageFailed")); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [selected, script, t]);
  const filtered = items.filter(item => `${item.name} ${Object.values(item.origins).map(origin => `${origin.url} ${origin.name ?? ""}`).join(" ")} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="control-center-page workspace-wide service-workspace-page web-settings-page is-website-bridges website-bridges-settings" aria-label={t("settings.websiteBridges.label")}>
    <header className="page-head control-center-hero website-bridges-header">
      <div className="control-center-hero-copy"><h1>{t("settings.websiteBridges.label")}</h1><p>{t("settings.websiteBridges.description")}</p></div>
    </header>
    {error && <div role="alert" className="website-bridges-error">{error}</div>}
    {notice && <div role="status">{notice}</div>}
    <div className="control-center-shell web-settings-shell website-bridges-layout">
      <aside className="service-sider service-catalog web-settings-catalog website-bridges-list" aria-label={t("settings.websiteBridges.packages")}>
        <div className="management-group-scroll">
        <div className="service-group-head">
          <div className="service-group-copy"><h2>{t("settings.websiteBridges.packages")}</h2></div>
          <div className="service-title-actions">
            <SettingsActionButton label={t("settings.websiteBridges.refresh")} icon="refresh" disabled={busy} onClick={() => void perform(() => api.listWebsiteBridges())} />
            <SettingsActionButton label={t("settings.websiteBridges.import")} icon="import" tone="primary" loading={busy} onClick={() => void perform(() => api.importWebsiteBridge(), t("settings.websiteBridges.imported"))} />
          </div>
        </div>
        <div className="website-bridges-search">
          <div className="sidebar-settings-search">
            <input ref={searchInputRef} type="search" aria-label={t("settings.websiteBridges.search")} placeholder={t("settings.websiteBridges.search")} value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" className="sidebar-settings-search-clear" aria-label={t("common.clear")} onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}><CloseOutlined /></button>}
          </div>
        </div>
        <div className="service-nav-list">
        {filtered.map(item => <button key={item.id} type="button" className={`website-bridge-item${item.id === selectedId ? " is-selected" : ""}`} aria-pressed={item.id === selectedId}
          onClick={() => { setSelectedId(item.id); setPageId(""); }}>
          <strong>{item.name}</strong><span>{item.outdated ? t("settings.websiteBridges.outdated") : Object.values(item.origins).map(origin => origin.url).join(" · ")}</span><small>{item.version} · {t(item.enabled ? "settings.websiteBridges.enabled" : "settings.websiteBridges.disabled")}</small>
        </button>)}
        {!filtered.length && <p className="service-group-empty">{t(busy ? "settings.websiteBridges.loading" : "settings.websiteBridges.empty")}</p>}
        </div>
        </div>
      </aside>
      {selected ? <article className="control-center-detail management-detail-group web-settings-detail website-bridge-detail">
        <div className="management-group-scroll service-detail-scroll">
        <section className="service-card control-center-service-hero">
          <div className="control-center-service-head website-bridge-heading">
            <div className="control-center-service-main">
              <div className="service-hero-icon website-bridge-icon" aria-hidden="true"><SettingsSidebarIcon kind="websiteBridges" /></div>
              <div className="service-hero-copy">
                <div className="service-hero-title-line"><h2>{selected.name}</h2></div>
                <p title={`${selected.id} · ${selected.version}`}>{selected.id} · {selected.version}</p>
              </div>
            </div>
            <div className="service-title-actions">
              <Switch size="small" checked={selected.enabled} disabled={busy || selected.outdated} aria-label={t("settings.websiteBridges.enabled")} onChange={enabled => void perform(() => api.setWebsiteBridgeEnabled({ id: selected.id, enabled }), t("settings.websiteBridges.applied"))} />
              <SettingsActionButton label={t("settings.websiteBridges.update")} icon="import" disabled={busy} onClick={() => void perform(() => api.importWebsiteBridge(selected.id), t("settings.websiteBridges.imported"))} />
              <SettingsActionButton label={t("settings.websiteBridges.export")} icon="export" disabled={busy || selected.outdated} onClick={() => void perform(() => api.exportWebsiteBridge(selected.id))} />
              <SettingsActionButton label={t("settings.websiteBridges.remove")} icon="delete" tone="danger" disabled={busy} onClick={() => setRemoveOpen(true)} />
            </div>
          </div>
          {selected.description && <p className="website-bridge-description">{selected.description}</p>}
          {selected.outdated ? <p role="status" className="website-bridge-hint">{t("settings.websiteBridges.outdatedHint")}</p>
            : origins.map(([key, origin]) => <dl key={key} className="website-bridge-meta"><dt>{t("settings.websiteBridges.origin")}{origins.length > 1 ? ` · ${key}` : ""}</dt>
              <dd>{origin.url}{origin.name ? ` · ${origin.name}` : ""}{origin.description && <small>{origin.description}</small>}</dd></dl>)}
        </section>
        {!selected.outdated && <><section className="service-card">
        <div className="config-head"><h3>{t("settings.websiteBridges.pages")}</h3></div>
        <p className="website-bridge-hint">{t("settings.websiteBridges.pathHint")}</p>
        <div className="website-bridge-routes" role="group" aria-label={t("settings.websiteBridges.pages")}>
          {Object.entries(selected.pages).map(([id, route]) => <button type="button" key={id} aria-pressed={page === id} onClick={() => setPageId(id)} className={page === id ? "is-selected" : ""}>
            <code>{origins.length > 1 ? `${route.origin} ` : ""}{route.path}</code><span>{route.name ? `${route.name} · ${id}` : id}</span>
            <small>{route.match ? route.match.map(ruleText).join(" | ") : t("settings.websiteBridges.byPath")}</small>
          </button>)}
        </div>
        </section>
        <section className="service-card config-panel website-bridge-code">
        <div className="config-head"><h3>{t("settings.websiteBridges.script")}</h3><span>{script}</span></div>
        <div className="website-bridge-features" role="group" aria-label={t("settings.websiteBridges.script")}>
          {scripts.map(name => <button type="button" key={name} aria-pressed={script === name} onClick={() => setScriptPath(name)} className={script === name ? "is-selected" : ""}>{name.slice(0, -".js".length)}</button>)}
        </div>
        {sourceError && <p role="alert" className="website-bridges-error">{sourceError}</p>}
        {sourceLoading ? <p role="status">{t("settings.websiteBridges.loading")}</p> : <textarea className="config-editor website-bridge-source" readOnly spellCheck={false} aria-label={t("settings.websiteBridges.script")} value={source} />}
        <p className="website-bridge-hint">{t("settings.websiteBridges.scriptHint")}</p>
        </section></>}
        </div>
      </article> : <div className="service-card control-center-detail control-center-empty website-bridge-empty">{t("settings.websiteBridges.start")}</div>}
    </div>
    <Modal title={t("settings.websiteBridges.remove")} open={removeOpen} onCancel={() => setRemoveOpen(false)} okButtonProps={{ danger: true, disabled: busy }}
      okText={t("settings.websiteBridges.remove")} cancelText={t("settings.websiteBridges.cancel")}
      onOk={() => { setRemoveOpen(false); if (selected) void perform(() => api.removeWebsiteBridge(selected.id), t("settings.websiteBridges.removed")); }}>
      <p>{t("settings.websiteBridges.removeConfirm", { name: selected?.name ?? "" })}</p>
    </Modal>
  </section>;
}
