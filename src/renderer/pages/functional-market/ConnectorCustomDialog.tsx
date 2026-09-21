import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Select, Tabs } from "antd";
import type { MarketCommandResult, MarketItem } from "@shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";
import { createBasicConnectorPackage, createConnectorDialogScope, runConnectorDialogRequest, validateConnectorPackage, type BasicConnectorInput } from "./ConnectorCustomPackage";

export function ConnectorCustomDialog({ open, onClose, onSaved, onManage }: { open: boolean; onClose: () => void; onSaved: (item: MarketItem, connect: boolean) => void; onManage: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState("basic");
  const [basic, setBasic] = useState<BasicConnectorInput>({ id: "", name: "", url: "", authMode: "none" });
  const [connectorJson, setConnectorJson] = useState("");
  const [mcpJson, setMcpJson] = useState("");
  const [cliJson, setCliJson] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<symbol | null>(null);
  const scope = useRef(createConnectorDialogScope());
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    scope.current.setVisible(open); pending.current = null; setBusy(false);
    return () => { scope.current.setVisible(false); pending.current = null; };
  }, [open]);
  useEffect(() => {
    if (!open) { setConnectorJson(""); setMcpJson(""); setCliJson(""); setBasic({ id: "", name: "", url: "", authMode: "none" }); return; }
    const id = `custom-mcp-${Date.now().toString(36)}`;
    setBasic({ id, name: "", url: "", authMode: "none" }); setMode("basic"); setError("");
    setConnectorJson(JSON.stringify({ id, name: "", version: "1.0.0", type: "mcp", auth_mode: null }, null, 2)); setMcpJson(""); setCliJson("");
  }, [open]);
  const accept = (result: MarketCommandResult, connect: boolean, metadata?: { name: string; version: string }) => {
    if (!result.ok || !result.connectorId) throw new Error(result.message || t("market.connector.customForm.failed"));
    const item: MarketItem = { id: result.connectorId, connectorId: result.connectorId, connectorInstalled: true, type: "connector", name: metadata?.name || result.connectorId,
      version: metadata?.version || "", description: "", tags: [], state: "installed", source: "local", marketplaceAvailable: false };
    onSaved(item, connect); onClose();
  };
  const save = async (connect: boolean) => {
    const current = scope.current.capture();
    if (!current() || pending.current) return;
    const operation = Symbol(); pending.current = operation; setBusy(true); setError("");
    try {
      const input = mode === "basic" ? createBasicConnectorPackage(basic) : { connectorJson, ...(mcpJson.trim() ? { mcpJson } : {}), ...(cliJson.trim() ? { cliJson } : {}) };
      const metadata = validateConnectorPackage(input);
      await runConnectorDialogRequest(current, () => window.electronAPI.market.createConnector(input), result => accept(result, connect, metadata));
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (pending.current === operation) { pending.current = null; if (current()) setBusy(false); } }
  };
  const importZip = async () => {
    const current = scope.current.capture();
    if (!current() || pending.current) return;
    const operation = Symbol(); pending.current = operation; setBusy(true); setError("");
    try { await runConnectorDialogRequest(current, () => window.electronAPI.market.importConnector(), result => { if (!result.canceled) accept(result, false); }); }
    catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (pending.current === operation) { pending.current = null; if (current()) setBusy(false); } }
  };
  const field = (key: "id" | "name" | "url") => <label className="connector-token-field"><span>{t(`market.connector.customForm.${key}` as TranslationKey)}</span><Input value={basic[key]} disabled={busy} onChange={event => setBasic(previous => ({ ...previous, [key]: event.target.value }))} /></label>;
  return <Modal open={open} centered width={660} title={t("market.connector.customForm.title")} maskClosable={false} closable={!busy} onCancel={() => { if (!busy) onClose(); }} footer={null} destroyOnClose>
    <p>{t("market.connector.customForm.hint")}</p>
    <Tabs activeKey={mode} onChange={next => {
      if (busy) return;
      if (next === "advanced" && mode === "basic") { try { const input = createBasicConnectorPackage(basic); setConnectorJson(input.connectorJson); setMcpJson(input.mcpJson || ""); } catch { /* Incomplete basic declarations remain in their form. */ } }
      setMode(next);
    }} items={[
      { key: "basic", label: t("market.connector.customForm.basic"), children: <div className="connector-token-form">{field("name")}{field("id")}{field("url")}
        <label className="connector-token-field"><span>{t("market.connector.customForm.auth")}</span><Select value={basic.authMode} disabled={busy} onChange={authMode => setBasic(previous => ({ ...previous, authMode }))}
          options={[{ value: "none", label: t("market.connector.customForm.authNone") }, { value: "mcp", label: t("market.connector.customForm.authMcp") }, { value: "token", label: t("market.connector.customForm.authToken") }]} /></label></div> },
      { key: "advanced", label: t("market.connector.customForm.advanced"), children: <div className="connector-token-form">
        <label className="connector-token-field"><span>{t("market.connector.customForm.connectorJson")}</span><Input.TextArea autoComplete="off" value={connectorJson} disabled={busy} autoSize={{ minRows: 5, maxRows: 10 }} onChange={event => setConnectorJson(event.target.value)} /></label>
        <label className="connector-token-field"><span>{t("market.connector.customForm.mcpJson")}</span><Input.TextArea autoComplete="off" value={mcpJson} disabled={busy} autoSize={{ minRows: 4, maxRows: 8 }} onChange={event => setMcpJson(event.target.value)} /></label>
        <label className="connector-token-field"><span>{t("market.connector.customForm.cliJson")}</span><Input.TextArea autoComplete="off" value={cliJson} disabled={busy} autoSize={{ minRows: 2, maxRows: 8 }} onChange={event => setCliJson(event.target.value)} /></label>
      </div> },
    ]} />
    {error && <Alert showIcon type="error" message={error.startsWith("market.") ? t(error as TranslationKey) : error} />}
    <div className="connector-detail-actions"><Button disabled={busy} onClick={() => void importZip()}>{t("market.connector.customForm.importZip")}</Button><Button type="link" disabled={busy} onClick={() => { onClose(); onManage(); }}>{t("market.connector.customForm.manage")}</Button></div>
    <div className="connector-detail-actions"><Button disabled={busy} onClick={() => void save(false)}>{t("market.connector.customForm.save")}</Button><Button type="primary" loading={busy} onClick={() => void save(true)}>{t("market.connector.customForm.saveConnect")}</Button></div>
  </Modal>;
}
