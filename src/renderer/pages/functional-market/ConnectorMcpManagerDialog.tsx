import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import { ArrowLeftOutlined, CloseOutlined, DatabaseOutlined, SearchOutlined, SettingOutlined } from "@ant-design/icons";
import { useI18n } from "../../i18n/useI18n";
import "./ConnectorLifecycle.css";

export function ConnectorMcpManagerDialog({ open, onClose, onAdvanced, onSaved }: {
  open: boolean; onClose: () => void; onAdvanced: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [content, setContent] = useState('{\n  "mcpServers": {}\n}');
  const [saved, setSaved] = useState(content);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const lines = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const request = ++generation.current;
    if (!open) return;
    setEditing(false); setSearch(""); setError(""); setBusy(true); setLoaded(false);
    void window.electronAPI.market.getCustomMcpConfig().then(result => {
      if (request !== generation.current) return;
      setContent(result.content); setSaved(result.content); setPath(result.path); setLoaded(true);
    }).catch(reason => { if (request === generation.current) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (request === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [open]);
  let servers: Array<[string, Record<string, unknown>]> = [];
  try {
    const config = JSON.parse(saved);
    if (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)) {
      servers = Object.entries(config.mcpServers).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]));
    }
  } catch { /* File validation failures are shown by the configuration API. */ }
  const visible = (loaded ? servers : []).filter(([name]) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const save = async () => {
    if (busy || !loaded) return;
    setError("");
    try {
      const config = JSON.parse(content);
      if (!config || typeof config !== "object" || Array.isArray(config) || !config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) throw new Error(t("market.connector.manager.invalid"));
    } catch { setError(t("market.connector.manager.invalid")); return; }
    const request = generation.current;
    setBusy(true);
    try {
      const result = await window.electronAPI.market.saveCustomMcpConfig({ content });
      if (request !== generation.current) return;
      setContent(result.content); setSaved(result.content); setPath(result.path); setLoaded(true); setEditing(false); onSaved();
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const cancelEdit = () => { setContent(saved); setEditing(false); setError(""); };
  return <Modal open={open} centered width={540} footer={null} title={null} closable={false} maskClosable={!busy} onCancel={() => { if (!busy) onClose(); }} styles={{ content: { borderRadius: 18, padding: 0 }, body: { height: "min(78vh, 640px)", display: "flex", flexDirection: "column" } }}>
    <header className="connector-manager-header">
      <span className="connector-manager-symbol"><DatabaseOutlined /></span>
      <div className="connector-manager-heading"><h2>{t("market.connector.manager.title")}</h2><p>{t("market.connector.manager.subtitle")}</p></div>
      {!editing && <Button size="small" icon={<SettingOutlined />} disabled={busy || !loaded} onClick={() => setEditing(true)}>{t("market.connector.manager.configure")}</Button>}
      <Button type="text" icon={<CloseOutlined />} aria-label={t("market.connector.manager.close")} disabled={busy} onClick={onClose} />
    </header>
    {error && <div className="connector-manager-error"><Alert type="error" showIcon message={error} /></div>}
    {editing ? <>
      <div className="connector-manager-toolbar"><Button type="text" size="small" icon={<ArrowLeftOutlined />} disabled={busy} onClick={cancelEdit}>{t("market.connector.manager.back")}</Button><span className="connector-manager-spacer" /><Button size="small" disabled={busy} onClick={cancelEdit}>{t("market.connector.manager.cancel")}</Button><Button type="primary" size="small" loading={busy} disabled={busy || content === saved} onClick={() => void save()}>{t("market.connector.manager.save")}</Button></div>
      <div className="connector-manager-path" title={path}>{t("market.connector.manager.location")}: {path || t("market.connector.manager.loading")}</div>
      <div className="connector-manager-editor"><pre ref={lines} aria-hidden="true">{content.split("\n").map((_, index) => index + 1).join("\n")}</pre><textarea aria-label={t("market.connector.manager.json")} spellCheck={false} autoComplete="off" value={content} disabled={busy} onChange={event => setContent(event.target.value)} onScroll={event => { if (lines.current) lines.current.scrollTop = event.currentTarget.scrollTop; }} /></div>
    </> : <>
      <div className="connector-manager-toolbar"><Input prefix={<SearchOutlined />} placeholder={t("market.connector.manager.search")} aria-label={t("market.connector.manager.search")} value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="connector-manager-list">
        {busy ? <p className="connector-manager-loading">{t("market.connector.manager.loading")}</p> : visible.length ? visible.map(([name, server]) => <button type="button" className="connector-manager-server" key={name} onClick={() => setEditing(true)}><DatabaseOutlined /><span><strong>{name}</strong><small>{typeof server.type === "string" ? server.type : typeof server.url === "string" ? "HTTP" : "stdio"}</small></span><span className="connector-manager-edit-label">{t("market.connector.manager.edit")}</span></button>) : <div className="connector-manager-empty"><DatabaseOutlined /><h3>{t(search ? "market.connector.manager.noMatches" : "market.connector.manager.empty")}</h3><p>{t("market.connector.manager.emptyHint")}</p><Button disabled={busy || !loaded} onClick={() => setEditing(true)}>{t("market.connector.manager.configure")}</Button></div>}
      </div>
      <footer className="connector-manager-footer"><Button type="link" size="small" disabled={busy} onClick={onAdvanced}>{t("market.connector.manager.advanced")}</Button></footer>
    </>}
  </Modal>;
}
