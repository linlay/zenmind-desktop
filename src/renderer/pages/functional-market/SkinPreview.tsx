import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MarketItem } from "@shared/contracts";
import type { DesktopSkinPreview, InstalledDesktopSkinId } from "../../../shared/desktop-appearance";
import type { DesktopSkinDefinition, ResolvedThemeMode } from "../../../shared/desktop-skin-definition";
import { parseSkinPackageManifest } from "../../../shared/desktop-skin-package";
import { useI18n } from "../../i18n/useI18n";

export function readMarketSkinManifest(item?: MarketItem) {
    try { return item ? parseSkinPackageManifest(JSON.parse(item.metadata?.skinManifest ?? "null")) : null; }
    catch { return null; }
}

export function SkinPreview({ item, definition, installedSkinId, thumbnail, mode }: {
    item?: MarketItem;
    definition?: DesktopSkinDefinition;
    installedSkinId?: InstalledDesktopSkinId;
    thumbnail?: string | null;
    mode: ResolvedThemeMode;
}) {
    const { t } = useI18n();
    const manifest = useMemo(() => readMarketSkinManifest(item), [item?.metadata?.skinManifest]);
    const [resource, setResource] = useState<{ key: string; preview: DesktopSkinPreview } | null>(null);
    const cache = useRef(new Map<string, DesktopSkinPreview>());
    const path = manifest?.variants[mode].background?.path ?? manifest?.preview;
    const position = manifest?.variants[mode].background?.position ?? "center";
    const resourceKey = JSON.stringify([installedSkinId, item?.id, item?.version, path, position, mode]);
    useEffect(() => {
        if (definition || (!installedSkinId && (!item || !path))) return;
        let active = true;
        const publish = (preview: DesktopSkinPreview | null) => {
            if (!active || !preview) return;
            // Cache only the two small per-mode thumbnails; full market artwork
            // remains a single active resource rather than accumulating copies.
            if (!preview.background || preview.background.imageUrl.length <= 192 * 1024) {
                if (cache.current.size >= 2 && !cache.current.has(resourceKey)) cache.current.clear();
                cache.current.set(resourceKey, preview);
            }
            setResource({ key: resourceKey, preview });
        };
        const cached = cache.current.get(resourceKey);
        if (cached) publish(cached);
        else if (installedSkinId) {
            const read = window.electronAPI.settings.getDesktopSkinPreview;
            if (typeof read === "function") void read(installedSkinId, mode).then(publish).catch(() => {});
        } else if (item && path) {
            void window.electronAPI.market.readSkinAsset({ id: item.id, version: item.version, path })
                .then(result => publish({ tokens: {}, background: { imageUrl: result.dataUrl, position } }))
                .catch(() => {});
        }
        return () => { active = false; };
    }, [definition, installedSkinId, item?.id, item?.version, path, position, mode, resourceKey]);
    const loaded = resource?.key === resourceKey ? resource.preview : null;
    const tokens = definition?.tokens[mode] ?? (installedSkinId ? loaded?.tokens : manifest?.variants[mode].tokens) ?? {};
    const background = definition?.backgrounds?.[mode] ?? loaded?.background;
    const image = background?.imageUrl ?? thumbnail;
    const surface = tokens["--surface"] ?? tokens["--surface-strong"] ?? (mode === "dark" ? "#243143" : "#ffffff");
    const sidebar = tokens["--surface-sidebar"] ?? surface;
    const style: CSSProperties = {
        backgroundColor: tokens["--bg-base"] ?? (mode === "dark" ? "#1e2530" : "#f1f5fa"),
        color: tokens["--ink"] ?? (mode === "dark" ? "#e6edf5" : "#273448"),
        backgroundImage: image ? `url("${image}")` : undefined,
        backgroundPosition: background?.position ?? manifest?.variants[mode].background?.position ?? "center"
    };
    return <div className={`skin-market-preview is-${mode}`} style={style} role="img"
        aria-label={t("market.skin.preview", { mode: t(mode === "light" ? "settings.appearance.light" : "settings.appearance.dark") })}>
        <div className="skin-market-preview-sidebar" style={{ backgroundColor: `color-mix(in srgb, ${sidebar} 58%, transparent)` }}><i /><i /><i /><i /></div>
        <div className="skin-market-preview-panel" style={{ backgroundColor: `color-mix(in srgb, ${surface} 62%, transparent)` }}>
            <span /><span /><b style={{ backgroundColor: tokens["--control-primary-bg"] ?? tokens["--accent"] ?? "#4885dd" }}/>
        </div>
    </div>;
}
