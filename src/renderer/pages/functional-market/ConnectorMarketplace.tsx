import { useState, type ReactNode } from "react";
import { CheckOutlined, LinkOutlined, LoadingOutlined, PlusCircleOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Modal } from "antd";
import { useNavigate } from "react-router-dom";
import type { MarketItem } from "@shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import { createAgentWebclientAgentPath } from "../../../shared/agent-webclient-routes";
import { useI18n } from "../../i18n/useI18n";
import { MarketCardDescription } from "./MarketCardDescription";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { ConnectorDetailDialog, ConnectorStateTag } from "./ConnectorDetailDialog";
import { ConnectorCustomDialog } from "./ConnectorCustomDialog";
import { ConnectorCredentialsDialog } from "./ConnectorCredentialsDialog";
import { useMarketConnectorFlow } from "./useMarketConnectorFlow";
import "./SkillMarketplace.css";
import "./ConnectorMarketplace.css";
import "./ConnectorLifecycle.css";

interface ConnectorMarketplaceProps {
  items: MarketItem[]; loading: boolean; feedback: ReactNode;
  /** Legacy generic detail props are accepted while the parent migrates this branch. */
  detail?: ReactNode; onDetail?: (item: MarketItem) => void;
  onTabChange: (tab: MarketTab) => void; onManage: () => void; onChanged?: () => void;
}
export function ConnectorMarketplace(props: ConnectorMarketplaceProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [customOpen, setCustomOpen] = useState(false);
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
      <button type="button" className="skill-discovery-outline" onClick={() => setCustomOpen(true)}><PlusCircleOutlined aria-hidden="true" />{t("market.connector.custom")}</button></div>}>
    <div className="skill-discovery connector-discovery">
      {props.feedback}
      {runtime.stateError && <div className="connector-market-status"><Alert type="warning" showIcon message={t("market.connector.flow.stateUnavailable")} description={runtime.stateError} /><Button onClick={() => void runtime.refresh()}>{t("market.connector.flow.retry")}</Button></div>}
      {runtime.error && <div className="connector-market-status"><Alert type="error" showIcon message={message(runtime.error)} /><Button disabled={runtime.busy} onClick={() => void runtime.retry()}>{t("market.connector.flow.retry")}</Button>{runtime.flow?.session && !runtime.busy && <Button onClick={() => void runtime.cancel()}>{t("market.connector.flow.cancel")}</Button>}</div>}
      {runtime.notice && <div className="connector-market-status"><Alert type="info" showIcon message={message(runtime.notice)} /></div>}
      {runtime.flow && runtime.busy && runtime.flow.phase !== "credentials" && <div className="connector-market-status"><Alert type="info" message={`${runtime.flow.item.name} · ${t(`market.connector.flow.phase.${runtime.flow.phase}` as TranslationKey)}`} />
        {runtime.flow.session?.authorizationUrl && <>
          <Button disabled={runtime.openingAuth} onClick={() => void runtime.reopenAuth("embedded")}>{t("connectorAuth.openInside")}</Button>
          <Button disabled={runtime.openingAuth} onClick={() => void runtime.reopenAuth("system")}>{t("connectorAuth.openOutside")}</Button>
        </>}<Button onClick={() => void runtime.cancel()}>{t("market.connector.flow.cancel")}</Button></div>}
      <div className="skill-discovery-scroll"><div className="skill-discovery-grid" aria-busy={props.loading || runtime.loading}>
        {visible.map(item => {
          const connection = runtime.getConnection(item), installed = runtime.isInstalled(item);
          const ready = connection?.readiness === "ready";
          const checking = runtime.loading && !connection;
          const disabled = runtime.busy || runtime.loading || !!runtime.stateError || (!installed && item.state === "incompatible");
          return <article className="skill-discovery-card" key={item.id}>
            <div className="skill-discovery-card-head"><span className={`skill-discovery-icon tone-${item.id.length % 6}`} aria-hidden="true"><LinkOutlined /></span>
              <button type="button" className="skill-discovery-name" title={item.name} onClick={() => setDetailItem(item)}>{item.name}</button>
              <button type="button" className="skill-discovery-install" disabled={disabled} aria-label={`${item.name}: ${t(checking ? "market.connector.flow.checking" : ready ? "market.connector.flow.try" : "market.connector.flow.connect")}`}
                title={t(checking ? "market.connector.flow.checking" : ready ? "market.connector.flow.try" : "market.connector.flow.connect")} onClick={() => void runtime.start(item, true, true)}>
                {checking || (runtime.busy && runtime.flow?.item.id === item.id) ? <LoadingOutlined /> : ready ? <CheckOutlined /> : <PlusOutlined />}
              </button></div>
            <MarketCardDescription text={item.description || t("market.discovery.noDescription")} onDetail={() => setDetailItem(item)} />
            <div className="skill-discovery-card-footer"><ConnectorStateTag connection={connection} installed={installed} checking={checking} />
              {item.state === "update-available" && <Button className="connector-card-action" type="link" size="small" disabled={disabled} onClick={() => void runtime.mutate(item, "update")}>{t("market.action.update")}</Button>}
              {ready && <Button className="connector-card-action" type="link" size="small" disabled={disabled} onClick={() => void runtime.start(item, true, true)}>{t("market.connector.flow.try")}</Button>}
              {!installed && item.state === "incompatible" && <span className="skill-discovery-kind">{item.message || t("market.state.incompatible")}</span>}
            </div>
          </article>;
        })}
      </div>{!visible.length && <div className="skill-discovery-empty" role="status">{t(props.loading ? "market.storefront.loading" : "market.connector.empty")}</div>}</div>
    </div>
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
