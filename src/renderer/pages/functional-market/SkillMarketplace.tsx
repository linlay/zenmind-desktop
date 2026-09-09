import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckOutlined, CheckSquareOutlined, LeftOutlined, PlusOutlined, SearchOutlined, PushpinOutlined, MoreOutlined, LoadingOutlined, InfoCircleOutlined, DeleteOutlined, ReloadOutlined, MessageOutlined } from "@ant-design/icons";
import { Modal } from "antd";
import { MarketCardDescription } from "./MarketCardDescription";
import type { MarketItem } from "@shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import { MarketSkillAvatar } from "./MarketSkillAvatar";
import { useMarketSkillPins } from "./useMarketSkillPins";
import { sortPinnedSkills } from "./skillPinning";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { cloudSkills, featuredSkills, isInstalledSkill, matchesSkillCategory, skillCategories, type SkillCategory } from "./skillDiscovery";
import "./SkillMarketplace.css";

interface Props {
  items: MarketItem[];
  loading: boolean;
  busyItemId: string;
  addControl: ReactNode;
  feedback: ReactNode;
  detail: ReactNode;
  onTabChange: (tab: MarketTab) => void;
  onInstall: (item: MarketItem, action: "install" | "update") => Promise<boolean>;
  onUninstall: (item: MarketItem) => Promise<boolean>;
  onDetail: (item: MarketItem) => void;
  onUse: (item: MarketItem) => void;
}

export function SkillMarketplace(props: Props) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const installedView = params.get("view") === "installed";
  const [query, setQuery] = useState("");
  const [installedQuery, setInstalledQuery] = useState("");
  const [collection, setCollection] = useState<"recommended" | "packages">("recommended");
  const [category, setCategory] = useState<SkillCategory>("all");
  const [featuredOffset, setFeaturedOffset] = useState(0);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingRemoval, setPendingRemoval] = useState<MarketItem[]>([]);
  const [removing, setRemoving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOutsideMenus = (event: PointerEvent) => {
      rootRef.current?.querySelectorAll<HTMLDetailsElement>(".skill-discovery-menu[open]").forEach((menu) => {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      });
    };
    const closeMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      rootRef.current?.querySelectorAll<HTMLDetailsElement>(".skill-discovery-menu[open]").forEach((menu) => {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", closeOutsideMenus);
    document.addEventListener("keydown", closeMenusOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutsideMenus);
      document.removeEventListener("keydown", closeMenusOnEscape);
    };
  }, []);
  const skillPins = useMarketSkillPins(props.items, props.loading);
  const pinned = skillPins.pins;
  const installed = props.items.filter(isInstalledSkill);
  const search = (item: MarketItem, value: string) => matchesMarketItemQuery(item, value, t);
  const featured = useMemo(() => featuredSkills(props.items, featuredOffset), [props.items, featuredOffset]);
  const featuredCount = cloudSkills(props.items).filter((item) => item.skillFeatured === true).length;
  const visible = installedView
    ? sortPinnedSkills(installed.filter((item) => search(item, installedQuery)), pinned)
    : cloudSkills(props.items).filter((item) => search(item, query) && matchesSkillCategory(item, category) &&
      (collection === "packages" ? item.skill?.kind === "package" : item.skill?.kind !== "package"));

  function changeView(next: boolean) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("view", "installed"); else nextParams.delete("view");
    setParams(nextParams);
    setManaging(false);
    setSelected([]);
  }
  async function confirmRemoval() {
    setRemoving(true);
    const failures: MarketItem[] = [];
    try {
      for (const item of pendingRemoval) {
        if (!await props.onUninstall(item)) failures.push(item);
        else setSelected((current) => current.filter((id) => id !== item.id));
      }
      setPendingRemoval(failures);
      if (!failures.length) setManaging(false);
    } finally { setRemoving(false); }
  }
  function searchBox(value: string, onChange: (value: string) => void, installedSearch = false) {
    return <label className="skill-discovery-search"><SearchOutlined /><input
      aria-label={t(installedSearch ? "market.discovery.searchInstalled" : "market.search.skills")}
      placeholder={t(installedSearch ? "market.discovery.searchInstalled" : "market.search.skills")}
      value={value} onChange={(event) => onChange(event.target.value)} type="search" /></label>;
  }
  function card(item: MarketItem, installedCard = false) {
    const busy = removing || props.busyItemId !== "";
    const installedState = isInstalledSkill(item);
    const isPackage = item.skill?.kind === "package";
    const content = <article className={`skill-discovery-card${isPackage ? " is-package" : ""}${selected.includes(item.id) && managing ? " is-selected" : ""}`} key={item.id}>
      <div className="skill-discovery-card-head">
        {installedCard && managing ? <input type="checkbox" aria-label={item.name} checked={selected.includes(item.id)} disabled={busy}
          onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> : null}
        <MarketSkillAvatar item={item} />
        <button className="skill-discovery-name" title={item.name} onClick={() => props.onDetail(item)}>{item.name}</button>
        {installedCard ? <div className="skill-discovery-card-tools">
          <button className={`skill-discovery-pin${pinned.includes(item.id) ? " is-pinned" : ""}`} disabled={!skillPins.ready || skillPins.saving || busy} aria-label={t("market.discovery.pin")} aria-pressed={pinned.includes(item.id)} onClick={() => void skillPins.toggle(item.id)}><PushpinOutlined /></button>
          <details className="skill-discovery-menu"><summary aria-label={t("common.more")}><MoreOutlined /></summary><div>
            <button onClick={(event) => { event.currentTarget.closest("details")!.open = false; props.onDetail(item); }}><InfoCircleOutlined /><span>{t("market.action.details")}</span></button>
            <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")!.open = false; setPendingRemoval([item]); }}><DeleteOutlined /><span>{t("market.action.uninstall")}</span></button>
          </div></details>
        </div> : <button className={`skill-discovery-install${item.state === "update-available" ? " is-update" : ""}`} disabled={busy || (installedState && item.state !== "update-available") || item.state === "incompatible"}
          aria-label={`${item.name}: ${t(item.state === "update-available" ? "market.state.updateAvailable" : installedState ? "market.state.installed" : "market.action.install")}`}
          title={t(item.state === "update-available" ? "market.action.update" : installedState ? "market.state.installed" : "market.action.install")}
          onClick={() => void props.onInstall(item, item.state === "update-available" ? "update" : "install")}>
          {props.busyItemId === item.id && item.state !== "installed" ? <LoadingOutlined /> : item.state === "update-available" ? t("market.state.updateAvailable") : installedState ? <CheckOutlined /> : <PlusOutlined />}
        </button>}
      </div>
      <MarketCardDescription text={item.description || t("market.discovery.noDescription")} onDetail={() => props.onDetail(item)} />
      <div className="skill-discovery-card-footer">
        <span className="skill-discovery-kind">{t(isPackage ? "market.discovery.packages" : "market.discovery.recommended")}{isPackage ? ` · ${item.skill?.includedSkills?.length ?? 0}` : ""}</span>
        {installedState ? <button className="skill-discovery-use" disabled={busy} onClick={() => isPackage ? props.onDetail(item) : props.onUse(item)}>
          <MessageOutlined />{t(isPackage ? "market.discovery.chooseSkill" : "market.discovery.useSkill")}
        </button> : null}
      </div>
    </article>;
    return content;
  }
  const toolbar = <div className="skill-discovery-toolbar">
    {searchBox(query, setQuery)}
    <button className="skill-discovery-outline" onClick={() => changeView(true)}><CheckSquareOutlined />{t("market.toolbar.myInstalled")}<span className="skill-discovery-count">{installed.length}</span></button>
    {props.addControl}
  </div>;
  return <MarketPageFrame activeTab="skills" tabs={getMarketTabDefinitions(t)}
    onTabChange={(tab) => { if (tab === "skills") changeView(false); else props.onTabChange(tab); }}
    toolbar={installedView ? <div className="skill-discovery-toolbar">
      {managing ? <div className="skill-discovery-batch">
        <span>{t("market.discovery.selected", { count: selected.length })}</span>
        <button disabled={removing} onClick={() => setSelected(visible.map((item) => item.id))}>{t("market.discovery.selectAll")}</button>
        <button disabled={removing || !selected.length} onClick={() => setSelected([])}>{t("common.clear")}</button>
        <button disabled={removing || Boolean(props.busyItemId) || !selected.length} onClick={() => setPendingRemoval(installed.filter((item) => selected.includes(item.id)))}>{t("market.action.uninstall")}</button>
        <button disabled={removing} onClick={() => { setManaging(false); setSelected([]); }}>{t("common.cancel")}</button>
      </div> : <button className="skill-discovery-text-button" onClick={() => { setManaging(true); setSelected([]); }}>{t("market.discovery.batch")}</button>}
      {searchBox(installedQuery, setInstalledQuery, true)}
    </div> : toolbar}
    leading={installedView ? <div className="skill-discovery-installed-nav">
      <button className="skill-discovery-back" onClick={() => changeView(false)}><LeftOutlined />{t("market.discovery.allSkills")}</button>
      <h2 className="skill-discovery-installed-title">{t("market.toolbar.myInstalled")}<span className="skill-discovery-count">{installed.length}</span></h2>
    </div> : undefined}>
    <div ref={rootRef} className={`skill-discovery${installedView ? " is-installed-view" : ""}`}>
      {props.feedback}{props.detail}
      <div className="skill-discovery-scroll">
        {installedView && skillPins.failed ? <p role="alert" className="skill-discovery-pin-error">{t("market.discovery.pinSyncFailed")} <button onClick={skillPins.retry}>{t("market.discovery.retry")}</button></p> : null}
        {!installedView ? <>
          {!query ? <section className="skill-discovery-featured">
            <div className="skill-discovery-section-heading"><h2>{t("market.discovery.featured")}</h2>
              <button className="skill-discovery-shuffle" disabled={featuredCount <= 3} onClick={() => setFeaturedOffset((value) => value + 3)}><ReloadOutlined />{t("market.discovery.shuffle")}</button>
            </div>
            <div className="skill-discovery-grid">{featured.map((item) => card(item))}</div>
            {!featured.length ? <p className="skill-discovery-featured-empty">{t("market.discovery.noFeatured")}</p> : null}
          </section> : null}
          <div className="skill-discovery-collections" role="tablist" aria-label={t("market.discovery.collections")}>
            {(["recommended", "packages"] as const).map((value) => <button key={value} role="tab" aria-selected={collection === value} onClick={() => setCollection(value)}>{t(`market.discovery.${value}`)}</button>)}
          </div>
          <div className="skill-discovery-categories" aria-label={t("market.discovery.categories")}>
            {skillCategories.map((value) => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{t(`market.discovery.category.${value}`)}</button>)}
          </div>
        </> : null}
        <div className="skill-discovery-grid" aria-busy={props.loading}>{visible.map((item) => card(item, installedView))}</div>
        {!visible.length ? <div className="skill-discovery-empty">{t(props.loading ? "market.storefront.loading" : "market.discovery.empty")}</div> : null}
      </div>
      <Modal open={pendingRemoval.length > 0} title={t("market.skill.uninstallConfirmTitle")} centered
        onCancel={() => { if (!removing) setPendingRemoval([]); }} onOk={() => void confirmRemoval()}
        confirmLoading={removing} closable={!removing} maskClosable={!removing} keyboard={!removing}
        cancelButtonProps={{ disabled: removing }} okButtonProps={{ danger: true }}
        okText={t("market.action.uninstall")} cancelText={t("common.cancel")}>
        <p>{t("market.discovery.confirmRemoval", { count: pendingRemoval.length })}</p>
        <ul>{pendingRemoval.map((item) => <li key={item.id}>{item.name}</li>)}</ul>
      </Modal>
    </div>
  </MarketPageFrame>;
}
