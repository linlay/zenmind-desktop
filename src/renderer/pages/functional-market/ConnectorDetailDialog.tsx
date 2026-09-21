import { ConnectorIcon } from "./ConnectorIcon";
import { Alert, Button, Modal, Tag } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarketItem } from "@shared/contracts";
import type { MarketConnectorConnection } from "@shared/contracts/market-connector-state";
import type { TranslationKey } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";
import type { MarketConnectorFlowRuntime } from "./useMarketConnectorFlow";
import { BrandMark } from "../../components/BrandMark";
import { PRODUCT_NAME } from "../../../shared/brand";
import "./ConnectorLifecycle.css";

export function ConnectorStateTag({ connection, installed, checking = false }: { connection?: MarketConnectorConnection; installed: boolean; checking?: boolean }) {
  const { t } = useI18n();
  const label = checking ? t("market.connector.flow.checking") : connection ? t(`market.connector.flow.state.${connection.readiness}` as TranslationKey) : t(installed ? "market.connector.flow.stateUnavailable" : "market.connector.flow.notInstalled");
  return <><Tag color={connection?.readiness === "ready" ? "success" : connection?.readiness === "authorization_required" ? "warning" : undefined}>{label}</Tag>{connection?.authentication.pendingVerification && connection.readiness === "ready" && <Tag color="warning">{t("market.connector.flow.state.pending_verification")}</Tag>}</>;
}
export function ConnectorDetailDialog({ item, runtime, onClose, onDisconnect }: { item: MarketItem | null; runtime: MarketConnectorFlowRuntime; onClose: () => void; onDisconnect: (item: MarketItem) => void }) {
  const { t } = useI18n();
  if (!item) return null;
  const connection = runtime.getConnection(item);
  const installed = runtime.isInstalled(item);
  const awaitingVerification = connection?.readiness === "pending_verification";
  const error = runtime.getError(item);
  const blocked = runtime.busy || runtime.loading || !!runtime.stateError || (!installed && item.state === "incompatible");
  const fallback = ["draftLearn", "draftRead", "draftTask"].map(key => t(`market.connector.flow.${key}` as TranslationKey, { name: item.name }));
  let suggestions = fallback;
  try {
    const prompts: unknown = JSON.parse(item.metadata?.prompts || "null");
    if (Array.isArray(prompts)) {
      const values = prompts.filter((value): value is string => typeof value === "string" && !!value.trim()).map(value => value.trim()).slice(0, 3);
      if (values.length) suggestions = values;
    }
  } catch { /* Invalid optional metadata does not block connecting. */ }
  return <Modal open centered width={600} footer={null} title={null} onCancel={onClose}
    styles={{ content: { borderRadius: 20, padding: 0, overflow: "hidden" }, body: { maxHeight: "calc(100dvh - 80px)", overflow: "hidden" } }}>
    <div className="connector-detail-dialog" key={item.id}>
      <header className="connector-detail-header">
      <div className="connector-detail-brand-row" aria-hidden="true">
        <BrandMark className="connector-detail-brand" ariaLabel={PRODUCT_NAME} />
        <span className="connector-detail-dots">···</span>
        <span className="connector-detail-icon"><ConnectorIcon item={item} /></span>
      </div>
      <h2 className="connector-detail-title">{t("market.connector.flow.detailTitle", { name: item.name })}</h2>
      <p className="connector-detail-description">{item.description || t("market.discovery.noDescription")}</p>
      <div className="connector-detail-status"><ConnectorStateTag connection={connection} installed={installed} checking={runtime.loading && !connection} /></div>
      {!error && connection?.authentication.message && <Alert type={connection.authentication.status === "failed" || connection.authentication.status === "unauthorized" ? "warning" : "info"} showIcon message={connection.authentication.message} />}
      {error && <Alert type="error" showIcon closable onClose={runtime.dismissError} message={error.startsWith("market.") ? t(error as TranslationKey) : error} action={<Button size="small" disabled={runtime.busy} onClick={() => void runtime.retry(item)}>{t("market.connector.flow.retry")}</Button>} />}
      {runtime.flow?.item.id === item.id && runtime.busy && <Alert type="info" message={t(`market.connector.flow.phase.${runtime.flow.phase}` as TranslationKey)} action={<Button size="small" onClick={() => void runtime.cancel()}>{t("market.connector.flow.cancel")}</Button>} />}
      {runtime.flow?.item.id === item.id && runtime.busy && runtime.flow.session?.authorizationUrl && <div className="connector-detail-actions"><Button disabled={runtime.openingAuth} onClick={() => void runtime.reopenAuth()}>{t("market.connector.flow.reopenAuthorization")}</Button></div>}
      {runtime.stateError && <Alert type="warning" showIcon message={t("market.connector.flow.stateUnavailable")} description={runtime.stateError} action={<Button size="small" onClick={() => void runtime.refresh()}>{t("market.connector.flow.retry")}</Button>} />}
      <div className="connector-detail-actions connector-detail-primary-actions">
        <Button type="primary" disabled={blocked || (connection?.readiness !== "ready" && installed && connection?.capabilities.canConnect === false && connection.capabilities.authMode !== "token" && !(awaitingVerification && connection.capabilities.canCheck))} loading={runtime.busy && runtime.flow?.item.id === item.id} onClick={() => void (awaitingVerification ? runtime.mutate(item, "check") : runtime.start(item, true, true))}>{t(awaitingVerification ? "market.connector.flow.check" : connection?.readiness === "ready" ? "market.connector.flow.try" : "market.connector.flow.connect")}</Button>
        {connection?.configured && connection.capabilities.canDisconnect && <Button disabled={runtime.busy} onClick={() => onDisconnect(item)}>{t("market.connector.flow.disconnect")}</Button>}
      </div>
      {!installed && item.state === "incompatible" && <Alert type="warning" message={item.message || t("market.state.incompatible")} />}
      </header>
      <div className="connector-detail-scroll">
      <section className="connector-detail-usage">
        <h3>{t("market.connector.flow.usage")}</h3>
        <div className="connector-suggestions">{suggestions.map((prompt, index) => <Button key={`${index}-${prompt}`} icon={<MessageOutlined />} disabled={blocked} onClick={() => void runtime.start(item, true, true, prompt)}>{prompt}</Button>)}</div>
      </section>
      <details className="connector-detail-more">
        <summary>{t("market.connector.flow.details")}</summary>
        <div className="connector-detail-info">
        <dl><div><dt>{t("market.storefront.detail.version")}</dt><dd>{item.version}</dd></div><div><dt>{t("market.storefront.detail.author")}</dt><dd>{item.author || "—"}</dd></div></dl>
        <div className="connector-detail-actions">
          {item.state === "update-available" && <Button disabled={blocked} onClick={() => void runtime.mutate(item, "update")}>{t("market.action.update")} · {item.installedVersion} → {item.version}</Button>}
          {connection?.capabilities.canCheck && <Button disabled={blocked} onClick={() => void runtime.mutate(item, "check")}>{t("market.connector.flow.check")}</Button>}
        </div>
        </div>
        <p className="connector-detail-scope">{t("market.connector.flow.accountScope")}</p>
        {item.readme && <div className="connector-detail-readme"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{item.readme}</ReactMarkdown></div>}
      </details>
      </div>
    </div>
  </Modal>;
}
