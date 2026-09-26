import { ConnectorMessages } from "./ConnectorMessages";
import { ConnectorIcon } from "./ConnectorIcon";
import { useState, type ReactNode } from "react";
import { CheckOutlined, LoadingOutlined, MessageOutlined, PlusCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Modal } from "antd";
import { useNavigate } from "react-router-dom";
import type { MarketItem } from "@shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import { createAgentWebclientAgentPath } from "../../../shared/agent-webclient-routes";
import { useI18n } from "../../i18n/useI18n";
import { MarketCardDescription } from "./MarketCardDescription";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { ConnectorDetailDialog } from "./ConnectorDetailDialog";
import { ConnectorMcpManagerDialog } from "./ConnectorMcpManagerDialog";
import { ConnectorCustomDialog } from "./ConnectorCustomDialog";
import { ConnectorCredentialsDialog } from "./ConnectorCredentialsDialog";
import { useMarketConnectorFlow } from "./useMarketConnectorFlow";
import "./SkillMarketplace.css";
import "./ConnectorMarketplace.css";
import "./ConnectorLifecycle.css";

interface ConnectorMarketplaceProps {
  items: MarketItem[]; loading: boolean; feedback: ReactNode;
  onTabChange: (tab: MarketTab) => void; onManage: () => void; onChanged?: () => void;
}
export function ConnectorMarketplace(props: ConnectorMarketplaceProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [customOpen, setCustomOpen] = useState(false);
  const [mcpManagerOpen, setMcpManagerOpen] = useState(false);
  const [localItems, setLocalItems] = useState<MarketItem[]>([]);
  const [query, setQuery] = useState("");
  const [detailItem, setDetailItem] = useState<MarketItem | null>(null);
  const [disconnectItem, setDisconnectItem] = useState<MarketItem | null>(null);
  const runtime = useMarketConnectorFlow(props.onChanged, (agentKey, draft) => {
    const search = new URLSearchParams({ newChat: String(Date.now()) });
    if (draft) search.set("composerDraft", draft);
    navigate(createAgentWebclientAgentPath(agentKey, search));
  });
  const message = (value: string) => value.startsWith("market.") ? t(value as TranslationKey) : value;
  const items = [...props.items, ...localItems.filter(local => !props.items.some(item => (item.connectorId || item.id) === local.connectorId))];
  const visible = items.filter(item => item.type === "connector" && (item.marketplaceAvailable || item.source === "local") && matchesMarketItemQuery(item, query, t));
  return <MarketPageFrame activeTab="mcps" tabs={getMarketTabDefinitions(t)} onTabChange={props.onTabChange}
    toolbar={<div className="skill-discovery-toolbar"><label className="skill-discovery-search"><SearchOutlined aria-hidden="true" />
      <input type="search" aria-label={t("market.connector.search")} placeholder={t("market.connector.search")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="skill-discovery-outline" onClick={() => setMcpManagerOpen(true)}><PlusCircleOutlined aria-hidden="true" />{t("market.connector.custom")}</button></div>}>
    <div className="skill-discovery connector-discovery">
      <ConnectorMessages runtime={runtime} />
      {props.feedback}
      <div className="skill-discovery-scroll"><div className="skill-discovery-grid" aria-busy={props.loading || runtime.loading}>
        {visible.map(item => {
          const connection = runtime.getConnection(item), installed = runtime.isInstalled(item);
          const ready = connection?.readiness === "ready";
          const checking = runtime.loading && !connection;
          const statusLabel = checking ? t("market.connector.flow.checking") : connection ? t(`market.connector.flow.state.${connection.readiness}` as TranslationKey) : t(installed ? "market.connector.flow.stateUnavailable" : "market.connector.flow.notInstalled");
          const statusTone = ready ? "ready" : installed || checking ? "pending" : "idle";
          const actionLabel = t(checking ? "market.connector.flow.checking" : ready ? "market.connector.flow.try" : installed ? "market.connector.flow.installedAwaitingConnection" : "market.connector.flow.connect");
          const disabled = runtime.busy || runtime.loading || !!runtime.stateError || (!installed && item.state === "incompatible");
          return <article className="skill-discovery-card connector-market-card" key={item.id} tabIndex={0} aria-label={item.name} aria-haspopup="dialog"
            onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button, a, input, select, textarea")) setDetailItem(item); }}
            onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setDetailItem(item); } }}>
            <div className="skill-discovery-card-head"><span className={`skill-discovery-icon tone-${item.id.length % 6}`} aria-hidden="true"><ConnectorIcon item={item} /></span>
              <div className="connector-card-title"><button type="button" className="skill-discovery-name" title={item.name} onClick={() => setDetailItem(item)}>{item.name}</button>
                <span className={`connector-runtime-dot is-${statusTone}`} role="img" aria-label={statusLabel} title={statusLabel} /></div>
              <div className="connector-card-actions">
                {item.state === "update-available" && <button type="button" className="skill-discovery-install connector-card-update" disabled={disabled} aria-label={`${item.name}: ${t("market.action.update")}`} title={t("market.action.update")} onClick={() => void runtime.mutate(item, "update")}><ReloadOutlined aria-hidden="true" /></button>}
                {item.state !== "update-available" && <button type="button" className="skill-discovery-install" disabled={disabled} aria-label={`${item.name}: ${actionLabel}`}
                  title={!installed && item.state === "incompatible" ? item.message || t("market.state.incompatible") : actionLabel} onClick={() => { if (installed && !ready) setDetailItem(item); else void runtime.start(item, true, true); }}>
                  {checking || (runtime.busy && runtime.flow?.item.id === item.id) ? <LoadingOutlined aria-hidden="true" /> : ready ? <MessageOutlined aria-hidden="true" /> : installed ? <CheckOutlined aria-hidden="true" /> : <PlusOutlined aria-hidden="true" />}
                </button>}
              </div></div>
            <MarketCardDescription text={item.description || t("market.discovery.noDescription")} onDetail={() => setDetailItem(item)} />
          </article>;
        })}
      </div>{!visible.length && <div className="skill-discovery-empty" role="status">{t(props.loading ? "market.storefront.loading" : "market.connector.empty")}</div>}</div>
    </div>
    <ConnectorMcpManagerDialog open={mcpManagerOpen} onClose={() => setMcpManagerOpen(false)} onSaved={() => { void runtime.refresh(); props.onChanged?.(); }} onAdvanced={() => { setMcpManagerOpen(false); setCustomOpen(true); }} />
    <ConnectorCustomDialog open={customOpen} onClose={() => setCustomOpen(false)} onManage={props.onManage} onSaved={(item, connect) => {
      setLocalItems(previous => [...previous.filter(value => value.connectorId !== item.connectorId), item]); setDetailItem(item); props.onChanged?.(); void runtime.refresh();
      if (connect) void runtime.start(item, true, true);
    }} />
    <ConnectorDetailDialog item={detailItem} runtime={runtime} onClose={() => setDetailItem(null)} onDisconnect={setDisconnectItem} />
    <ConnectorCredentialsDialog connectorName={runtime.flow?.item.name || ""} schema={runtime.flow?.phase === "credentials" ? runtime.flow.schema || null : null} busy={runtime.busy} error={runtime.error ? message(runtime.error) : undefined} onSubmit={runtime.submitCredentials} onCancel={() => void runtime.cancel()} />
    <Modal open={!!disconnectItem} centered title={t("market.connector.flow.disconnectTitle")} okText={t("market.connector.flow.disconnect")} okButtonProps={{ danger: true }} confirmLoading={runtime.busy}
      onCancel={() => setDisconnectItem(null)} onOk={() => { if (disconnectItem) { void runtime.mutate(disconnectItem, "disconnect"); setDisconnectItem(null); } }}>
      <p>{t("market.connector.flow.disconnectDescription")}</p>
    </Modal>
  </MarketPageFrame>;
}
