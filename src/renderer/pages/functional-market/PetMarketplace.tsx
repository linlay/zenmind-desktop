import { useState, type ReactNode } from "react";
import { Alert, Button, Modal, Select, Tag } from "antd";
import { CheckOutlined, DownloadOutlined, LoadingOutlined, PlusCircleOutlined, ReloadOutlined, SearchOutlined, SmileOutlined } from "@ant-design/icons";
import type { DesktopPetAppearanceOption, MarketItem } from "@shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { PetMessages } from "./PetMessages";
import { PetPreview } from "./PetPreview";
import { useMarketPetFlow } from "./useMarketPetFlow";
import "./SkillMarketplace.css";
import "./PetMarketplace.css";

export interface PetMarketplaceProps {
  items: MarketItem[];
  loading: boolean;
  feedback: ReactNode;
  onTabChange: (tab: MarketTab) => void;
  onChanged?: () => unknown;
  onRefresh: () => unknown;
  detailItem: MarketItem | null;
  onDetail: (item: MarketItem | null) => void;
}
export function PetMarketplace(props: PetMarketplaceProps) {
  const { t } = useI18n();
  const runtime = useMarketPetFlow(props.onChanged);
  const [scope, setScope] = useState<"market" | "mine">("market");
  const [query, setQuery] = useState("");
  const [localDetail, setLocalDetail] = useState<DesktopPetAppearanceOption | null>(null);
  const [remove, setRemove] = useState<DesktopPetAppearanceOption | null>(null);
  const [sort, setSort] = useState("newest");
  const appearances = runtime.petState?.appearanceOptions ?? [];
  const current = runtime.stateError ? undefined : runtime.petState?.appearanceId;
  const marketItems = props.items.filter(item => item.type === "pet" && (item.marketplaceAvailable === true || item.source === "cloud") && matchesMarketItemQuery(item, query, t)).sort((a, b) =>
    sort === "popular" ? (b.downloadCount ?? 0) - (a.downloadCount ?? 0) : String(b.updatedAt ?? b.publishedAt ?? "").localeCompare(String(a.updatedAt ?? a.publishedAt ?? "")));
  const mine = appearances.filter(item => `${item.displayName} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const installed = (item: MarketItem) => appearances.some(pet => pet.id === `user:${item.id}`);
  const detailsItem = props.detailItem?.type === "pet" ? props.detailItem : undefined;
  const detailAppearance = localDetail ?? undefined;
  const openMarket = (item: MarketItem) => { setLocalDetail(null); props.onDetail(item); };
  const openLocal = (appearance: DesktopPetAppearanceOption) => { props.onDetail(null); setLocalDetail(appearance); };
  const closeDetail = () => { setLocalDetail(null); props.onDetail(null); };
  const refreshButton = () => <Button onClick={() => void runtime.refresh()} loading={runtime.loading} disabled={runtime.busy}><ReloadOutlined />{t("market.pet.refresh")}</Button>;
  const stateWarning = runtime.stateError ? <Alert type="warning" showIcon message={runtime.stateError} action={refreshButton()} /> : null;
  const detailIDs = [detailsItem?.id, detailsItem ? `user:${detailsItem.id}` : undefined, detailAppearance?.id];
  const detailError = runtime.errorItemId && detailIDs.includes(runtime.errorItemId) ? runtime.error : "";
  const removeError = runtime.errorAction === "remove" && runtime.errorItemId === remove?.id ? runtime.error : "";
  const useButton = (appearance: DesktopPetAppearanceOption) => runtime.stateError ? refreshButton() : <Button type={current === appearance.id ? "default" : "primary"}
    disabled={runtime.busy || runtime.loading || current === appearance.id} loading={runtime.busyId === appearance.id}
    onClick={() => void runtime.usePet(appearance.id)} aria-label={t("market.pet.useName", { name: appearance.displayName })}
    icon={current === appearance.id ? <CheckOutlined /> : undefined}>
    {t(current === appearance.id ? "market.pet.current" : "market.pet.use")}
  </Button>;
  const installButton = (item: MarketItem) => {
    if (runtime.stateError) return refreshButton();
    const local = appearances.find(pet => pet.id === `user:${item.id}`);
    if (local && item.state !== "update-available") return useButton(local);
    return <Button type="primary" disabled={runtime.busy || runtime.loading || item.state === "incompatible"}
      loading={runtime.busyId === item.id} icon={<DownloadOutlined />} onClick={() => void runtime.install(item)}>
      {t(item.state === "update-available" ? "market.action.update" : "market.action.install")}
    </Button>;
  };
  return <MarketPageFrame activeTab="pets" onTabChange={props.onTabChange} tabs={getMarketTabDefinitions(t)} toolbar={<div className="skill-discovery-toolbar">
    <label className="skill-discovery-search"><SearchOutlined aria-hidden="true" /><input className="pet-market-search" type="search" placeholder={t("market.pet.search")} aria-label={t("market.pet.search")} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button type="button" className="skill-discovery-outline" onClick={async () => { if (await runtime.importPet()) { setQuery(""); setScope("mine"); } }} disabled={runtime.busy} aria-busy={runtime.busyId === "import"}>
      {runtime.busyId === "import" ? <LoadingOutlined aria-hidden="true" /> : <PlusCircleOutlined aria-hidden="true" />}{t("settings.desktopPet.import.zip")}
    </button>
    <button type="button" className="skill-discovery-outline" aria-label={t("market.pet.refresh")} disabled={runtime.busy} aria-busy={props.loading || runtime.loading} onClick={() => { void runtime.refresh(); props.onRefresh(); }}><ReloadOutlined aria-hidden="true" /></button>
  </div>}>
    <div className="skill-discovery pet-discovery">
      <PetMessages runtime={runtime} />
      {props.feedback}
      <div className="skill-discovery-scroll">
        <div className="pet-market-list-heading">
          <div className="skill-discovery-collections pet-market-scopes"><button type="button" aria-selected={scope === "market"} onClick={() => setScope("market")}>{t("market.pet.browse")}</button>
            <button type="button" aria-selected={scope === "mine"} onClick={() => setScope("mine")}>{t("market.pet.mine", { count: appearances.length })}</button></div>
          {scope === "market" ? <Select size="small" value={sort} onChange={setSort} aria-label={t("market.pet.sort")} options={[{ value: "newest", label: t("market.pet.newest") }, { value: "popular", label: t("market.pet.popular") }]} /> : null}
        </div>
        <div className="skill-discovery-grid pet-market-grid" aria-busy={props.loading || runtime.loading}>{scope === "market" ? marketItems.map(item => <article className="skill-discovery-card pet-market-card" key={item.id} tabIndex={0} aria-label={item.name} aria-haspopup="dialog"
          onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button, a, input, select, textarea")) openMarket(item); }}
          onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openMarket(item); } }}>
          <button className="pet-market-open" onClick={() => openMarket(item)} aria-label={t("market.pet.detailsName", { name: item.name })}><PetPreview item={item} /></button>
          <div className="pet-market-card-copy"><h2>{item.name}</h2><p>{item.description}</p><div className="pet-market-tags"><Tag>{item.version}</Tag>{installed(item) ? <Tag color="blue">{t("market.state.installed")}</Tag> : null}{item.tags.slice(0, 2).map(tag => <Tag key={tag}>{tag}</Tag>)}</div></div>
          <div className="pet-market-card-actions"><Button type="text" onClick={() => openMarket(item)}>{t("market.action.details")}</Button>{installButton(item)}</div>
        </article>) : mine.map(appearance => {
          const update = props.items.find(item => `user:${item.id}` === appearance.id && item.state === "update-available");
          return <article className={`skill-discovery-card pet-market-card ${current === appearance.id ? "is-current" : ""}`} key={appearance.id} tabIndex={0} aria-label={appearance.displayName} aria-haspopup="dialog"
            onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button, a, input, select, textarea")) openLocal(appearance); }}
            onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openLocal(appearance); } }}>
            <button className="pet-market-open" onClick={() => openLocal(appearance)} aria-label={t("market.pet.detailsName", { name: appearance.displayName })}><PetPreview appearance={appearance} /></button>
            <div className="pet-market-card-copy"><h2>{appearance.displayName}{current === appearance.id ? <Tag color="blue">{t("market.pet.current")}</Tag> : null}</h2><p>{appearance.description}</p></div>
            <div className="pet-market-card-actions">{appearance.id.startsWith("user:") ? <Button type="text" danger onClick={() => setRemove(appearance)} disabled={runtime.busy}>{t("common.delete")}</Button> : <Tag icon={<SmileOutlined />}>{t("market.pet.builtin")}</Tag>}
              {update ? <Button onClick={() => void runtime.install(update)} disabled={runtime.busy}>{t("market.action.update")}</Button> : null}{useButton(appearance)}</div>
          </article>;
        })}</div>
        {(scope === "market" ? marketItems.length : mine.length) === 0 ? <div className="skill-discovery-empty" role="status">{t(props.loading || runtime.loading ? "market.storefront.loading" : "market.pet.empty")}</div> : null}
      </div>
    </div>
    <Modal destroyOnHidden open={Boolean(detailsItem || detailAppearance)} onCancel={closeDetail} title={detailsItem?.name ?? detailAppearance?.displayName} footer={detailsItem ? installButton(detailsItem) : detailAppearance ? useButton(detailAppearance) : null}>
      {stateWarning}
      {detailError ? <Alert type="error" showIcon message={detailError} action={<Button aria-label={t("market.pet.retry")} disabled={runtime.busy} onClick={() => void runtime.retry()}>{t("market.pet.retry")}</Button>} /> : null}
      {detailsItem || detailAppearance ? <><PetPreview key={detailsItem?.id ?? detailAppearance?.id} item={detailsItem} appearance={detailAppearance} controls /><p>{detailsItem?.description ?? detailAppearance?.description}</p>{detailsItem ? <p className="pet-market-detail-meta">{detailsItem.author} · {detailsItem.version}</p> : null}</> : null}
    </Modal>
    <Modal destroyOnHidden open={Boolean(remove)} title={t("settings.desktopPet.remove.confirm")} onCancel={() => { if (!runtime.busy) setRemove(null); }} maskClosable={!runtime.busy} closable={!runtime.busy} cancelButtonProps={{ disabled: runtime.busy }} okText={t("common.delete")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} confirmLoading={runtime.busy} onOk={async () => { if (remove && await runtime.remove(remove.id)) setRemove(null); }}>
      {stateWarning}
      {removeError ? <Alert type="error" showIcon message={removeError} action={<Button aria-label={t("market.pet.retry")} disabled={runtime.busy} onClick={async () => { if (await runtime.retry()) setRemove(null); }}>{t("market.pet.retry")}</Button>} /> : null}
      <p>{remove?.displayName}</p><p>{t("market.pet.removeHint")}</p>
    </Modal>
  </MarketPageFrame>;
}
