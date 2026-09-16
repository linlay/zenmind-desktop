import { Alert, Button, Modal, Tag } from "antd";
import { LinkOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarketItem } from "@shared/contracts";
import type { MarketConnectorConnection } from "@shared/contracts/market-connector-state";
import type { TranslationKey } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";
import type { MarketConnectorFlowRuntime } from "./useMarketConnectorFlow";
import "./SkillDetailDialog.css";

export function ConnectorStateTag({ connection, installed, checking = false }: { connection?: MarketConnectorConnection; installed: boolean; checking?: boolean }) {
  const { t } = useI18n();
  const label = checking ? t("market.connector.flow.checking") : connection ? t(`market.connector.flow.state.${connection.readiness}` as TranslationKey) : t(installed ? "market.connector.flow.stateUnavailable" : "market.connector.flow.notInstalled");
  return <><Tag color={connection?.readiness === "ready" ? "success" : connection?.readiness === "authorization_required" ? "warning" : undefined}>{label}</Tag>{connection?.authentication.status === "configured" && <Tag>{t("market.connector.flow.configured")}</Tag>}</>;
}
export function ConnectorDetailDialog({ item, runtime, onClose, onDisconnect }: { item: MarketItem | null; runtime: MarketConnectorFlowRuntime; onClose: () => void; onDisconnect: (item: MarketItem) => void }) {
  const { t } = useI18n();
  if (!item) return null;
  const connection = runtime.getConnection(item);
  const installed = runtime.isInstalled(item);
  const blocked = runtime.busy || runtime.loading || !!runtime.stateError || (!installed && item.state === "incompatible");
  const suggestions = [
    ["market.connector.flow.usageLearn", "market.connector.flow.draftLearn"],
    ["market.connector.flow.usageRead", "market.connector.flow.draftRead"],
    ["market.connector.flow.usageTask", "market.connector.flow.draftTask"],
  ] as const;
  return <Modal open centered width={820} footer={null} title={item.name} onCancel={onClose}>
    <div className="skill-detail-layout connector-detail-layout">
      <div className="skill-detail-main">
        <header className="skill-detail-heading"><span className="connector-detail-icon"><LinkOutlined /></span><div><h2>{item.name}</h2><ConnectorStateTag connection={connection} installed={installed} checking={runtime.loading && !connection} /></div></header>
        {runtime.error && <Alert type="error" showIcon message={runtime.error.startsWith("market.") ? t(runtime.error as TranslationKey) : runtime.error} action={<Button size="small" disabled={runtime.busy} onClick={() => void runtime.retry()}>{t("market.connector.flow.retry")}</Button>} />}
        {runtime.flow?.item.id === item.id && runtime.busy && <Alert type="info" message={t(`market.connector.flow.phase.${runtime.flow.phase}` as TranslationKey)} action={<Button size="small" onClick={() => void runtime.cancel()}>{t("market.connector.flow.cancel")}</Button>} />}
        <p className="skill-detail-description">{item.description || t("market.discovery.noDescription")}</p>
        <div className="skill-detail-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
        {item.readme && <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{item.readme}</ReactMarkdown>}
        <h3>{t("market.connector.flow.usage")}</h3>
        <div className="connector-suggestions">{suggestions.map(([label, draft]) => <Button key={label} disabled={blocked} onClick={() => void runtime.start(item, true, true, t(draft, { name: item.name }))}>{t(label)}</Button>)}</div>
        <p className="skill-detail-hint">{t("market.connector.flow.accountScope")}</p>
      </div>
      <aside className="skill-detail-side">
        <dl><dt>{t("market.storefront.detail.version")}</dt><dd>{item.version}</dd><dt>{t("market.storefront.detail.author")}</dt><dd>{item.author || "—"}</dd></dl>
        {runtime.stateError && <Alert type="warning" showIcon message={t("market.connector.flow.stateUnavailable")} description={runtime.stateError} action={<Button size="small" onClick={() => void runtime.refresh()}>{t("market.connector.flow.retry")}</Button>} />}
        <div className="connector-detail-actions is-column">
          {item.state === "update-available" && <Button disabled={blocked} onClick={() => void runtime.mutate(item, "update")}>{t("market.action.update")} · {item.installedVersion} → {item.version}</Button>}
          {connection?.readiness === "ready" ? <Button type="primary" disabled={blocked} onClick={() => void runtime.start(item, true, true)}>{t("market.connector.flow.try")}</Button>
            : <Button type="primary" disabled={blocked || (installed && connection?.capabilities.canConnect === false)} loading={runtime.busy && runtime.flow?.item.id === item.id} onClick={() => void runtime.start(item, true, true)}>{t("market.connector.flow.connect")}</Button>}
          {connection?.bound ? <Button disabled={blocked || (!connection.enabled && !connection.capabilities.canEnable)} onClick={() => void (connection.enabled ? runtime.mutate(item, "disable") : runtime.start(item, true))}>{t(connection.enabled ? "market.connector.flow.disable" : "market.connector.flow.enable")}</Button>
            : <Button disabled={blocked} onClick={() => void runtime.start(item, false)}>{t("market.connector.flow.connectAccount")}</Button>}
          {connection?.bound && connection.capabilities.canDisconnect && <Button danger disabled={runtime.busy} onClick={() => onDisconnect(item)}>{t("market.connector.flow.disconnect")}</Button>}
        </div>
        {!installed && item.state === "incompatible" && <Alert type="warning" message={item.message || t("market.state.incompatible")} />}
      </aside>
    </div>
  </Modal>;
}
