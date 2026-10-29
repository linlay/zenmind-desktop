import { useState, type ComponentProps, type ReactNode } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { PlusCircleOutlined, ReloadOutlined, SearchOutlined, LoadingOutlined, CheckOutlined, DeleteOutlined } from "@ant-design/icons";
import type { MarketItem } from "@shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import type { DesktopSkinId, InstalledDesktopSkinSummary } from "../../../shared/desktop-appearance";
import type { ResolvedThemeMode } from "../../../shared/desktop-skin-definition";
import { DESKTOP_SKINS } from "../../appearance/skins";
import { useI18n } from "../../i18n/useI18n";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import { SkinPreview } from "./SkinPreview";
import { SkinMessages } from "./SkinMessages";
import { useMarketSkinFlow } from "./useMarketSkinFlow";
import "./SkillMarketplace.css";
import "./SkinMarketplace.css";

const builtinSkinNameKeys: Record<string, TranslationKey> = {
    default: "settings.appearance.skinDefault", mist: "settings.appearance.skinMist",
    ocean: "settings.appearance.skinOcean", violet: "settings.appearance.skinViolet"
};
const packagePreviewKey = (id: string, version: string) => `package:${id}@${version}`;

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

function SkinPreviewModes({ name, mode, onChange }: {
    name: string;
    mode: ResolvedThemeMode;
    onChange: (mode: ResolvedThemeMode) => void;
}) {
    const { t } = useI18n();
    return <div className="skin-market-modes" role="group" aria-label={t("market.skin.previewModes", { name })}
        onClick={event => event.stopPropagation()}>
        {(["light", "dark"] as const).map(value => <button type="button" key={value}
            aria-pressed={mode === value} onClick={() => onChange(value)}>
            {t(value === "light" ? "settings.appearance.light" : "settings.appearance.dark")}
        </button>)}
    </div>;
}

export function SkinMarketplace(props: Props) {
    const { t } = useI18n();
    const flow = useMarketSkinFlow(props.onChanged), appearance = flow.appearance;
    const [query, setQuery] = useState("");
    const [previewModes, setPreviewModes] = useState<Record<string, ResolvedThemeMode>>({});
    const [localDetail, setLocalDetail] = useState<InstalledDesktopSkinSummary | null>(null);
    const [remove, setRemove] = useState<InstalledDesktopSkinSummary | null>(null);
    const installed = appearance.skinSettings.installedSkins ?? [], current = appearance.skinSettings.skinId;
    const skinItems = props.items.filter(item => item.type === "skin");
    const installedKeys = new Set(installed.map(skin => packagePreviewKey(skin.packageId, skin.version)));
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const builtins = DESKTOP_SKINS.filter(skin => `${t(builtinSkinNameKeys[skin.id])} ${skin.id}`.toLocaleLowerCase().includes(normalizedQuery));
    const mine = installed.filter(skin => {
        const item = skinItems.find(item => item.id === skin.packageId && item.version === skin.version);
        return `${skin.name} ${skin.packageId} ${skin.version}`.toLocaleLowerCase().includes(normalizedQuery)
            || Boolean(item && matchesMarketItemQuery(item, query, t));
    });
    const market = skinItems.filter(item => !installedKeys.has(packagePreviewKey(item.id, item.version))
        && matchesMarketItemQuery(item, query, t));
    const count = builtins.length + mine.length + market.length;
    const detail = localDetail
        ? skinItems.find(item => item.id === localDetail.packageId && item.version === localDetail.version)
        : props.detailItem?.type === "skin" ? props.detailItem : undefined;
    const selected = localDetail ?? (detail ? installed.find(skin => skin.packageId === detail.id && skin.version === detail.version) : undefined);
    const open = (item: MarketItem) => { setLocalDetail(null); props.onDetail(item); };
    const close = () => { props.onDetail(null); setLocalDetail(null); };
    const openLocal = (skin: InstalledDesktopSkinSummary) => { props.onDetail(null); setLocalDetail(skin); };
    const refresh = () => { void flow.refresh(); props.onRefresh(); };
    const renderPreview = (key: string, name: string, options: Omit<ComponentProps<typeof SkinPreview>, "mode">) => {
        const mode = previewModes[key] ?? appearance.resolvedTheme;
        return <div className="skin-market-card-preview">
            <SkinPreview {...options} mode={mode}/>
            <SkinPreviewModes name={name} mode={mode} onChange={value => setPreviewModes(previous => ({ ...previous, [key]: value }))}/>
        </div>;
    };
    const useButton = (id: DesktopSkinId) => <Button type={current === id ? "default" : "primary"}
        className={`market-card-action market-card-primary ${current === id ? "is-current" : ""}`}
        disabled={!flow.ready || flow.busy || current === id} loading={flow.busyId === id}
        icon={current === id ? <CheckOutlined /> : undefined} onClick={() => void flow.useSkin(id)}>
        {t(current === id ? "market.skin.current" : "market.skin.use")}
    </Button>;
    const installButton = (item: MarketItem) => {
        const exact = installed.find(skin => skin.packageId === item.id && skin.version === item.version);
        return exact ? useButton(exact.id) : <Button type="primary" className="market-card-action market-card-primary"
            disabled={!flow.ready || flow.busy || item.state === "incompatible"} loading={flow.busyId === item.id}
            onClick={() => void flow.install(item)}>
            {t(item.state === "update-available" ? "market.action.update" : "market.action.install")}
        </Button>;
    };
    const failure = flow.errorItemId && [detail?.id, selected?.id].includes(flow.errorItemId) ? flow.error : "";
    const retry = <Button aria-label={t("market.skin.retry")} disabled={flow.busy} onClick={() => void flow.retry()}>{t("market.skin.retry")}</Button>;
    const detailPreviewKey = localDetail ? packagePreviewKey(localDetail.packageId, localDetail.version)
        : detail ? packagePreviewKey(detail.id, detail.version) : "";

    return <MarketPageFrame activeTab="skins" tabs={getMarketTabDefinitions(t)} onTabChange={props.onTabChange}
        toolbar={<div className="skill-discovery-toolbar">
            <label className="skill-discovery-search"><SearchOutlined /><input type="search"
                aria-label={t("market.skin.search")} placeholder={t("market.skin.search")} value={query}
                onChange={event => setQuery(event.target.value)}/></label>
            <button type="button" className="skill-discovery-outline" disabled={flow.busy || !flow.ready}
                onClick={async () => { if (await flow.importSkin()) setQuery(""); }}>
                {flow.busyId === "import" ? <LoadingOutlined /> : <PlusCircleOutlined />}{t("settings.appearance.importPackage")}
            </button>
            <button type="button" className="skill-discovery-outline" aria-label={t("market.skin.refresh")}
                onClick={refresh} disabled={flow.busy}><ReloadOutlined /></button>
        </div>}>
        <div className="skill-discovery skin-discovery">
            <SkinMessages runtime={flow}/>{props.feedback}
            <div className="skill-discovery-scroll">
                {flow.stateError ? <Alert type="warning" showIcon message={flow.stateError}
                    action={<Button onClick={() => void flow.refresh()}>{t("market.skin.refresh")}</Button>}/> : null}
                <div className="skill-discovery-grid" aria-busy={props.loading || flow.loading}>
                    {builtins.map(skin => {
                        const name = t(builtinSkinNameKeys[skin.id]);
                        return <article className={`skill-discovery-card skin-market-card ${skin.id === current ? "is-selected" : ""}`}
                            key={skin.id} data-skin-id={skin.id} aria-label={name}>
                            {renderPreview(`builtin:${skin.id}`, name, { definition: skin })}
                            <div className="skin-market-copy"><div className="skin-market-title"><h2 title={name}>{name}</h2><div className="skin-market-meta"><Tag>{t("market.skin.builtin")}</Tag></div></div></div>
                            <div className="skin-market-actions">{useButton(skin.id as DesktopSkinId)}</div>
                        </article>;
                    })}
                    {mine.map(skin => <article className={`skill-discovery-card skin-market-card ${skin.id === current ? "is-selected" : ""}`}
                        key={skin.id} data-skin-id={skin.id} tabIndex={0} aria-label={`${skin.name} ${skin.version}`} aria-haspopup="dialog"
                        onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button,a,input")) openLocal(skin); }}
                        onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openLocal(skin); } }}>
                        {renderPreview(packagePreviewKey(skin.packageId, skin.version), `${skin.name} ${skin.version}`, {
                            installedSkinId: skin.id, definition: current === skin.id ? appearance.skin : undefined, thumbnail: skin.previewDataUrl
                        })}
                        <div className="skin-market-copy"><div className="skin-market-title"><h2 title={skin.name}>{skin.name}</h2><div className="skin-market-meta">
                            <Tag>{t("market.state.installed")}</Tag><span>{skin.version}</span>
                        </div></div></div>
                        <div className="skin-market-actions"><Button type="text" danger className="market-card-action market-card-delete" icon={<DeleteOutlined />} disabled={flow.busy} onClick={() => setRemove(skin)}>{t("common.delete")}</Button>{useButton(skin.id)}</div>
                    </article>)}
                    {market.map(item => <article className="skill-discovery-card skin-market-card" key={packagePreviewKey(item.id, item.version)}
                        data-package-id={item.id} tabIndex={0} aria-label={item.name} aria-haspopup="dialog"
                        onClick={event => { if (!(event.target instanceof Element) || !event.target.closest("button,a,input")) open(item); }}
                        onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(item); } }}>
                        {renderPreview(packagePreviewKey(item.id, item.version), item.name, { item })}
                        <div className="skin-market-copy"><div className="skin-market-title"><h2 title={item.name}>{item.name}</h2><div className="skin-market-meta">
                            <Tag>{t("market.skin.market")}</Tag><span>{item.version}</span>
                        </div></div><p>{item.description}</p></div>
                        <div className="skin-market-actions"><Button type="text" className="market-card-action market-card-secondary" onClick={() => open(item)}>{t("market.action.details")}</Button>{installButton(item)}</div>
                    </article>)}
                </div>
                {!count ? <div className="skill-discovery-empty">{t(props.loading ? "market.storefront.loading" : "market.skin.empty")}</div> : null}
            </div>
        </div>
        <Modal destroyOnHidden open={Boolean(detail || localDetail)} onCancel={close} title={localDetail?.name ?? detail?.name}
            footer={selected ? useButton(selected.id) : detail ? installButton(detail) : null}>
            {flow.stateError ? <Alert type="warning" showIcon message={flow.stateError}
                action={<Button onClick={() => void flow.refresh()}>{t("market.skin.refresh")}</Button>}/> : null}
            {failure ? <Alert type="error" showIcon message={failure} action={retry}/> : null}
            <div className="skin-market-detail">{renderPreview(detailPreviewKey, localDetail?.name ?? detail?.name ?? "", {
                item: selected ? undefined : detail, installedSkinId: selected?.id,
                definition: selected?.id === current ? appearance.skin : undefined, thumbnail: localDetail?.previewDataUrl
            })}</div>
            <p>{detail?.description}</p><p>{localDetail?.version ?? detail?.version}</p>
        </Modal>
        <Modal destroyOnHidden open={Boolean(remove)} title={t("market.skin.removeTitle")}
            onCancel={() => { if (!flow.busy) setRemove(null); }} okText={t("common.delete")} cancelText={t("common.cancel")}
            okButtonProps={{ danger: true }} confirmLoading={flow.busy}
            onOk={async () => { if (remove && await flow.remove(remove.id)) { setRemove(null); setLocalDetail(null); } }}>
            {flow.errorItemId === remove?.id && flow.error ? <Alert type="error" message={flow.error}
                action={<Button aria-label={t("market.skin.retry")} disabled={flow.busy}
                    onClick={async () => { if (await flow.retry()) { setRemove(null); setLocalDetail(null); } }}>{t("market.skin.retry")}</Button>}/> : null}
            <p>{remove?.name} · {remove?.version}</p><p>{t("market.skin.removeHint")}</p>
        </Modal>
    </MarketPageFrame>;
}
