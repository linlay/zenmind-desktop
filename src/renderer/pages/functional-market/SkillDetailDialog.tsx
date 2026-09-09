import { useEffect, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarketItem } from "@shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import { MarketSkillAvatar } from "./MarketSkillAvatar";
import { isInstalledSkill } from "./skillDiscovery";
import "./SkillDetailDialog.css";

export function SkillDetailDialog({ item, items, busy, onClose, onInstall, onUse, onDetail }: {
  item: MarketItem; items: MarketItem[]; busy: boolean; onClose: () => void;
  onInstall: (item: MarketItem, action: "install" | "update") => Promise<boolean>;
  onUse: (item: MarketItem) => void; onDetail: (item: MarketItem) => void;
}) {
  const { t } = useI18n();
  const isPackage = item.skill?.kind === "package";
  const installed = isInstalledSkill(item);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setContent(""); setFailed(false);
    if (isPackage || (item.source === "local" && !item.marketplaceAvailable)) { setLoading(false); return; }
    setLoading(true);
    Promise.resolve().then(() => window.electronAPI.market.readSkillContent(item.id))
      .then((result) => { if (current) setContent(result.content.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")); })
      .catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [item.id, item.version, item.source, item.marketplaceAvailable, isPackage, retry]);
  const includes = item.skill?.includedSkills ?? [];
  return <Modal open centered width={820} footer={null} onCancel={onClose} title={t(isPackage ? "market.discovery.packages" : "market.discovery.recommended")}>
    <div className="skill-detail-layout">
      <div className="skill-detail-main">
        <header className="skill-detail-heading"><MarketSkillAvatar item={item} /><div><h2>{item.name}</h2>
          <div className="skill-detail-tags">{item.skillFeatured ? <span>{t("market.discovery.featured")}</span> : null}{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div></header>
        <p className="skill-detail-description">{item.description}</p>
        {isPackage ? <>
          {item.readme ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{item.readme}</ReactMarkdown> : null}
          <h3>{t("market.discovery.includedSkills", { count: includes.length })}</h3>
          <div className="skill-detail-includes">{includes.map((child) => {
            const skill = items.find((entry) => entry.type === "skill" && entry.id === child.id);
            return <div className="skill-detail-child" key={child.id}>
              {skill ? <MarketSkillAvatar item={skill} /> : null}
              <div><button disabled={!skill} onClick={() => skill && onDetail(skill)}>{skill?.name || child.name || child.id}</button><p>{skill?.description || child.id}</p></div>
              {skill && isInstalledSkill(skill) ? <Button size="small" disabled={busy} onClick={() => onUse(skill)}>{t("market.discovery.useSkill")}</Button> : null}
            </div>;
          })}</div>
        </> : <div className="skill-detail-markdown">
          {loading ? <Spin /> : failed ? <Alert type="warning" message={t("market.discovery.contentFailed")} action={<Button size="small" onClick={() => setRetry((value) => value + 1)}>{t("market.discovery.retry")}</Button>} />
            : <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{content || item.readme || item.description}</ReactMarkdown>}
        </div>}
      </div>
      <aside className="skill-detail-side"><dl>
        <dt>{t("market.storefront.detail.version")}</dt><dd>{item.version}</dd>
        <dt>{t("market.storefront.detail.author")}</dt><dd>{item.author || "—"}</dd>
        <dt>{t("market.stats.downloads")}</dt><dd>{item.downloadCount ?? 0}</dd>
      </dl>
        {item.state === "update-available" || !installed ? <Button block type="primary" disabled={busy || item.state === "incompatible" || item.state === "failed"} loading={busy}
          onClick={() => void onInstall(item, item.state === "update-available" ? "update" : "install")}>{t(item.state === "update-available" ? "market.action.update" : "market.action.install")}</Button> : null}
        {installed && !isPackage ? <Button block type="primary" disabled={busy} onClick={() => onUse(item)}>{t("market.discovery.useSkill")}</Button> : null}
        {installed && isPackage ? <p className="skill-detail-hint">{t("market.discovery.chooseSkill")}</p> : null}
      </aside>
    </div>
  </Modal>;
}
