import type {TranslationKey} from "../../../shared/i18n";
import { useState, type ReactNode } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { PlusCircleOutlined, ReloadOutlined, SearchOutlined, LoadingOutlined, CheckOutlined } from "@ant-design/icons";
import type { MarketItem } from "@shared/contracts";
import type { DesktopSkinId, InstalledDesktopSkinSummary } from "../../../shared/desktop-appearance";
import { DESKTOP_SKINS } from "../../appearance/skins";
import { useI18n } from "../../i18n/useI18n";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { SkinPreview } from "./SkinPreview";
import { SkinMessages } from "./SkinMessages";
import { useMarketSkinFlow } from "./useMarketSkinFlow";
import "./SkillMarketplace.css";
import "./SkinMarketplace.css";
const builtinSkinNameKeys:Record<string,TranslationKey>={default:"settings.appearance.skinDefault",mist:"settings.appearance.skinMist",ocean:"settings.appearance.skinOcean",violet:"settings.appearance.skinViolet"};
interface Props {
    items: MarketItem[];
    loading: boolean;
    feedback: ReactNode;
    onTabChange: (tab: MarketTab) => void;
    onChanged?: () => unknown;
    onRefresh: () => unknown;
    detailItem: MarketItem | null;
    onDetail: (item: MarketItem | null) => void;
}
export function SkinMarketplace(props: Props) {
    const { t } = useI18n(), flow = useMarketSkinFlow(props.onChanged), appearance = flow.appearance;
    const [scope, setScope] = useState<"market" | "mine">("market"), [query, setQuery] = useState(""), [mode, setMode] = useState<"light" | "dark">(appearance.resolvedTheme);
    const [localDetail, setLocalDetail] = useState<InstalledDesktopSkinSummary | null>(null), [remove, setRemove] = useState<InstalledDesktopSkinSummary | null>(null);
    const installed = appearance.skinSettings.installedSkins ?? [], current = appearance.skinSettings.skinId;
    const items = props.items.filter(item => item.type === "skin" && matchesMarketItemQuery(item, query, t));
    const mine = installed.filter(skin => `${skin.name} ${skin.packageId} ${skin.version}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const detail = localDetail ? props.items.find(item => item.id === localDetail.packageId && item.version === localDetail.version) : props.detailItem?.type === "skin" ? props.detailItem : undefined;
    const selected = localDetail ?? (detail ? installed.find(skin => skin.packageId === detail.id && skin.version === detail.version) : undefined);
    const open = (item: MarketItem) => { setLocalDetail(null); props.onDetail(item); }, close = () => { props.onDetail(null); setLocalDetail(null); };
    const refresh = () => { void flow.refresh(); props.onRefresh(); };
    const useButton = (id: DesktopSkinId) => <Button type={current === id ? "default" : "primary"} disabled={!flow.ready || flow.busy || current === id} loading={flow.busyId === id} icon={current === id ? <CheckOutlined /> : undefined} onClick={() => void flow.useSkin(id)}>{t(current === id ? "market.skin.current" : "market.skin.use")}</Button>;
    const installButton = (item: MarketItem) => { const exact = installed.find(skin => skin.packageId === item.id && skin.version === item.version); return exact ? useButton(exact.id) : <Button type="primary" disabled={!flow.ready || flow.busy || item.state === "incompatible"} loading={flow.busyId === item.id} onClick={() => void flow.install(item)}>{t(item.state === "update-available" ? "market.action.update" : "market.action.install")}</Button>; };
    const failure = flow.errorItemId && [detail?.id, selected?.id].includes(flow.errorItemId) ? flow.error : "";
    const retry = <Button aria-label={t("market.skin.retry")} disabled={flow.busy} onClick={() => void flow.retry()}>{t("market.skin.retry")}</Button>;
    return <MarketPageFrame activeTab="skins" tabs={getMarketTabDefinitions(t)} onTabChange={props.onTabChange} toolbar={<div className="skill-discovery-toolbar"><label className="skill-discovery-search"><SearchOutlined /><input type="search" aria-label={t("market.skin.search")} placeholder={t("market.skin.search")} value={query} onChange={e => setQuery(e.target.value)}/></label><button className="skill-discovery-outline" disabled={flow.busy || !flow.ready} onClick={async () => { if (await flow.importSkin()) {
        setQuery("");
        setScope("mine");
    } }}>{flow.busyId === "import" ? <LoadingOutlined /> : <PlusCircleOutlined />}{t("settings.appearance.importPackage")}</button><button className="skill-discovery-outline" aria-label={t("market.skin.refresh")} onClick={refresh} disabled={flow.busy}><ReloadOutlined /></button></div>}>
 <div className="skill-discovery skin-discovery"><SkinMessages runtime={flow}/>{props.feedback}<div className="skill-discovery-scroll">
  <div className="skin-market-heading"><div className="skill-discovery-collections"><button aria-selected={scope === "market"} onClick={() => setScope("market")}>{t("market.skin.browse")}</button><button aria-selected={scope === "mine"} onClick={() => setScope("mine")}>{t("market.skin.mine", { count: installed.length })}</button></div><div className="skin-market-modes">{(["light", "dark"] as const).map(value => <button key={value} className="skill-discovery-outline" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value === "light" ? "settings.appearance.light" : "settings.appearance.dark")}</button>)}</div></div>
  {flow.stateError ? <Alert type="warning" showIcon message={flow.stateError} action={<Button onClick={() => void flow.refresh()}>{t("market.skin.refresh")}</Button>}/> : null}
  <div className="skill-discovery-grid" aria-busy={props.loading || flow.loading}>{scope === "market" ? items.map(item => <article className="skill-discovery-card skin-market-card" key={item.id} data-package-id={item.id} tabIndex={0} aria-label={item.name} aria-haspopup="dialog" onClick={e => { if (!(e.target instanceof Element) || !e.target.closest("button,a,input"))
            open(item); }} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            open(item);
        } }}><SkinPreview item={item} mode={mode}/><div className="skin-market-copy"><h2>{item.name}</h2><p>{item.description}</p><Tag>{item.version}</Tag></div><div className="skin-market-actions"><Button type="text" onClick={() => open(item)}>{t("market.action.details")}</Button>{installButton(item)}</div></article>) : <>
   {DESKTOP_SKINS.filter(skin => !query || `${t(builtinSkinNameKeys[skin.id])} ${skin.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(skin => <article className={`skill-discovery-card skin-market-card ${skin.id === current ? "is-selected" : ""}`} key={skin.id} data-skin-id={skin.id}><SkinPreview definition={skin} mode={mode}/><div className="skin-market-copy"><h2>{t(builtinSkinNameKeys[skin.id])}</h2><Tag>{t("market.skin.builtin")}</Tag></div><div className="skin-market-actions">{useButton(skin.id as DesktopSkinId)}</div></article>)}
   {mine.map(skin => <article className={`skill-discovery-card skin-market-card ${skin.id === current ? "is-selected" : ""}`} key={skin.id} data-skin-id={skin.id} tabIndex={0} aria-label={`${skin.name} ${skin.version}`} onClick={e => { if (!(e.target instanceof Element) || !e.target.closest("button,a,input")) {
            props.onDetail(null);
            setLocalDetail(skin);
        } }} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            props.onDetail(null);
            setLocalDetail(skin);
        } }}><SkinPreview item={props.items.find(item => item.id === skin.packageId && item.version === skin.version)} definition={current === skin.id ? appearance.skin : undefined} thumbnail={skin.previewDataUrl} mode={mode}/><div className="skin-market-copy"><h2>{skin.name}</h2><Tag>{skin.version}</Tag>{current === skin.id ? <Tag color="blue">{t("market.skin.current")}</Tag> : null}</div><div className="skin-market-actions"><Button type="text" danger disabled={flow.busy} onClick={() => setRemove(skin)}>{t("common.delete")}</Button>{useButton(skin.id)}</div></article>)}
  </>}</div>{scope === "market" && !items.length ? <div className="skill-discovery-empty">{t(props.loading ? "market.storefront.loading" : "market.skin.empty")}</div> : null}
 </div></div>
 <Modal destroyOnHidden open={Boolean(detail || localDetail)} onCancel={close} title={localDetail?.name ?? detail?.name} footer={selected ? useButton(selected.id) : detail ? installButton(detail) : null}>{flow.stateError ? <Alert type="warning" showIcon message={flow.stateError} action={<Button onClick={() => void flow.refresh()}>{t("market.skin.refresh")}</Button>}/> : null}{failure ? <Alert type="error" showIcon message={failure} action={retry}/> : null}<div className="skin-market-detail"><SkinPreview item={detail} definition={selected?.id === current ? appearance.skin : undefined} thumbnail={localDetail?.previewDataUrl} mode={mode}/></div><p>{detail?.description}</p><p>{localDetail?.version ?? detail?.version}</p><div className="skin-market-modes">{(["light", "dark"] as const).map(value => <Button key={value} onClick={() => setMode(value)}>{t(value === "light" ? "settings.appearance.light" : "settings.appearance.dark")}</Button>)}</div></Modal>
 <Modal destroyOnHidden open={Boolean(remove)} title={t("market.skin.removeTitle")} onCancel={() => { if (!flow.busy)
        setRemove(null); }} okText={t("common.delete")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} confirmLoading={flow.busy} onOk={async () => { if (remove && await flow.remove(remove.id)) {
        setRemove(null);
        setLocalDetail(null);
    } }}>{flow.errorItemId === remove?.id && flow.error ? <Alert type="error" message={flow.error} action={<Button aria-label={t("market.skin.retry")} disabled={flow.busy} onClick={async()=>{if(await flow.retry()){setRemove(null);setLocalDetail(null)}}}>{t("market.skin.retry")}</Button>}/> : null}<p>{remove?.name} · {remove?.version}</p><p>{t("market.skin.removeHint")}</p></Modal>
 </MarketPageFrame>;
}
