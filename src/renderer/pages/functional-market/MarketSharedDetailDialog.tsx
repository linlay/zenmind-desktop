import { Alert, Modal, Tag } from "antd";
import { useEffect, useState } from "react";
import type { MarketLinkDetail } from "../../../shared/contracts";
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


export function MarketLinkDetailDialog({ item, linkId, onClose }: { item: MarketLinkDetail & { install: boolean }; linkId: string; onClose(): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(item.install);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  useEffect(() => {
    if (!item.install) return;
    let current = true;
    void window.electronAPI.market.installLinkedItem(linkId).then(result => {
      if (current && result) setFeedback({ type: result.ok ? "success" : "error", message: result.message });
    }).catch(error => {
      if (current) setFeedback({ type: "error", message: String(error) });
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [item.install, linkId]);
  return <Modal open centered width={600} footer={null} title={item.name} onCancel={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <Tag>{item.type}</Tag>
    <Tag>{item.id}</Tag>
    <Tag>{t("market.share.version")}: {item.version}</Tag>
    <p>{item.source}</p>
    {busy ? <Alert type="info" showIcon message={t("market.action.installing")} /> : null}
    {feedback ? <Alert type={feedback.type} showIcon message={feedback.message} /> : null}
    <p className="connector-detail-description">{item.description}</p>
    <p>{t("market.storefront.detail.author")}: {item.author || "—"}</p>
    <p>{item.tags.map((tag, index) => <Tag key={`${index}-${tag}`}>{tag}</Tag>)}</p>
  </Modal>;
}
