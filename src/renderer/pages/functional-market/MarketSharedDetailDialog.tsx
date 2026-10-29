import { Alert, Modal, Tag } from "antd";
import type { MarketShareContext } from "../../../shared/market-share";
import { useI18n } from "../../i18n/useI18n";

export function MarketSharedDetailDialog({ context, loading, currentVersion, onClose }: {
  context: MarketShareContext; loading: boolean; currentVersion?: string; onClose(): void;
}) {
  const { t } = useI18n();
  return <Modal open centered width={600} footer={null} title={context.display.name} onCancel={onClose}>
    <Tag>{t("market.share.version")}: {context.resourceVersion}</Tag>
    <Alert type="info" showIcon message={t(loading ? "market.share.loading" : "market.share.unavailable")} />
    {currentVersion && currentVersion !== context.resourceVersion ? <p>{t("market.share.currentVersion", { version: currentVersion })}</p> : null}
    <p className="connector-detail-description">{context.display.description}</p>
    <p>{t("market.storefront.detail.author")}: {context.display.author || "—"}</p>
    <p>{context.display.tags.map((tag, index) => <Tag key={`${index}-${tag}`}>{tag}</Tag>)}</p>
  </Modal>;
}
