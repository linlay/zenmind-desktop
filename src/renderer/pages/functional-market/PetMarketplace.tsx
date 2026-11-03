import { useState, type ReactNode } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { CheckOutlined, DeleteOutlined, DownloadOutlined, LoadingOutlined, PlusCircleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
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
}
export function PetMarketplace(props: PetMarketplaceProps) {
  const { t } = useI18n();
  const runtime = useMarketPetFlow(props.onChanged);
  const [query, setQuery] = useState("");
  const [remove, setRemove] = useState<DesktopPetAppearanceOption | null>(null);
  const appearances = runtime.petState?.appearanceOptions ?? [];
  const current = runtime.stateError ? undefined : runtime.petState?.appearanceId;
  const marketItems = props.items.filter(item => item.type === "pet" && (item.marketplaceAvailable === true || item.source === "cloud")
    && !appearances.some(pet => pet.id === `user:${item.id}`) && matchesMarketItemQuery(item, query, t));
  const mine = appearances.filter(pet => {
    const item = props.items.find(item => item.type === "pet" && `user:${item.id}` === pet.id);
    return `${pet.displayName} ${pet.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      || Boolean(item && matchesMarketItemQuery(item, query, t));
  });
  const refreshButton = () => <Button onClick={() => void runtime.refresh()} loading={runtime.loading} disabled={runtime.busy}><ReloadOutlined />{t("market.pet.refresh")}</Button>;
  const stateWarning = runtime.stateError ? <Alert type="warning" showIcon message={runtime.stateError} action={refreshButton()} /> : null;
  const removeError = runtime.errorAction === "remove" && runtime.errorItemId === remove?.id ? runtime.error : "";
  const useButton = (appearance: DesktopPetAppearanceOption) => runtime.stateError ? refreshButton() : <Button type={current === appearance.id ? "default" : "primary"}
    className={`market-card-action market-card-primary ${current === appearance.id ? "is-current" : ""}`}
    disabled={runtime.busy || runtime.loading || current === appearance.id} loading={runtime.busyId === appearance.id}
    onClick={() => void runtime.usePet(appearance.id)} aria-label={t("market.pet.useName", { name: appearance.displayName })}
    icon={current === appearance.id ? <CheckOutlined /> : undefined}>
    {t(current === appearance.id ? "market.pet.current" : "market.pet.use")}
  </Button>;
  const installButton = (item: MarketItem) => {
    if (runtime.stateError) return refreshButton();
    const local = appearances.find(pet => pet.id === `user:${item.id}`);
    if (local && item.state !== "update-available") return useButton(local);
    return <Button type="primary" className="market-card-action market-card-primary" disabled={runtime.busy || runtime.loading || item.state === "incompatible"}
      loading={runtime.busyId === item.id} icon={<DownloadOutlined />} onClick={() => void runtime.install(item)}>
      {t(item.state === "update-available" ? "market.action.update" : "market.action.install")}
    </Button>;
  };
  return <MarketPageFrame activeTab="pets" onTabChange={props.onTabChange} tabs={getMarketTabDefinitions(t)} toolbar={<div className="skill-discovery-toolbar">
    <label className="skill-discovery-search"><SearchOutlined aria-hidden="true" /><input className="pet-market-search" type="search" placeholder={t("market.pet.search")} aria-label={t("market.pet.search")} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button type="button" className="skill-discovery-outline" onClick={async () => { if (await runtime.importPet()) setQuery(""); }} disabled={runtime.busy} aria-busy={runtime.busyId === "import"}>
      {runtime.busyId === "import" ? <LoadingOutlined aria-hidden="true" /> : <PlusCircleOutlined aria-hidden="true" />}{t("settings.desktopPet.import.zip")}
    </button>
    <button type="button" className="skill-discovery-outline" aria-label={t("market.pet.refresh")} disabled={runtime.busy} aria-busy={props.loading || runtime.loading} onClick={() => { void runtime.refresh(); props.onRefresh(); }}><ReloadOutlined aria-hidden="true" /></button>
  </div>}>
    <div className="skill-discovery pet-discovery">
      <PetMessages runtime={runtime} />
      {props.feedback}
      <div className="skill-discovery-scroll">
        {stateWarning}
        {runtime.error && !remove ? <Alert className="pet-market-error" type="error" showIcon message={runtime.error} action={<Button size="small" aria-label={t("market.pet.retry")} disabled={runtime.busy} onClick={() => void runtime.retry()}>{t("market.pet.retry")}</Button>} /> : null}
        <div className="skill-discovery-grid pet-market-grid" aria-busy={props.loading || runtime.loading}>{marketItems.map(item => <article className="skill-discovery-card pet-market-card" key={item.id} data-pet-id={item.id} aria-label={item.name}>
          <PetPreview item={item} />
          <div className="pet-market-card-copy"><h2><span className="pet-market-name" title={item.name}>{item.name}</span><Tag>{t("market.pet.market")}</Tag></h2><p title={item.description}>{item.description}</p><div className="pet-market-tags">{item.version}</div></div>
          <div className="pet-market-card-actions">{installButton(item)}</div>
        </article>)}{mine.map(appearance => {
          const update = props.items.find(item => item.type === "pet" && `user:${item.id}` === appearance.id && item.state === "update-available");
          return <article className={`skill-discovery-card pet-market-card ${current === appearance.id ? "is-current" : ""}`} key={appearance.id} data-pet-id={appearance.id} aria-label={appearance.displayName}>
            <PetPreview appearance={appearance} />
            <div className="pet-market-card-copy"><h2><span className="pet-market-name" title={appearance.displayName}>{appearance.displayName}</span><Tag>{t(appearance.id.startsWith("user:") ? "market.state.installed" : "market.pet.builtin")}</Tag></h2><p title={appearance.description}>{appearance.description}</p><div className="pet-market-tags">{appearance.assetVersion}</div></div>
            <div className="pet-market-card-actions">{appearance.id.startsWith("user:") ? <Button type="text" danger className="market-card-action market-card-delete" icon={<DeleteOutlined />} onClick={() => setRemove(appearance)} disabled={runtime.busy}>{t("common.delete")}</Button> : null}
              {update ? <Button className="market-card-action market-card-secondary" onClick={() => void runtime.install(update)} disabled={runtime.busy}>{t("market.action.update")}</Button> : null}{useButton(appearance)}</div>
          </article>;
        })}</div>
        {marketItems.length + mine.length === 0 ? <div className="skill-discovery-empty" role="status">{t(props.loading || runtime.loading ? "market.storefront.loading" : "market.pet.empty")}</div> : null}
      </div>
    </div>
    <Modal destroyOnHidden open={Boolean(remove)} title={t("settings.desktopPet.remove.confirm")} onCancel={() => { if (!runtime.busy) setRemove(null); }} maskClosable={!runtime.busy} closable={!runtime.busy} cancelButtonProps={{ disabled: runtime.busy }} okText={t("common.delete")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} confirmLoading={runtime.busy} onOk={async () => { if (remove && await runtime.remove(remove.id)) setRemove(null); }}>
      {stateWarning}
      {removeError ? <Alert type="error" showIcon message={removeError} action={<Button aria-label={t("market.pet.retry")} disabled={runtime.busy} onClick={async () => { if (await runtime.retry()) setRemove(null); }}>{t("market.pet.retry")}</Button>} /> : null}
      <p>{remove?.displayName}</p><p>{t("market.pet.removeHint")}</p>
    </Modal>
  </MarketPageFrame>;
}
