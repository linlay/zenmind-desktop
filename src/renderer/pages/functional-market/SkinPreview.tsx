import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { MarketItem } from "@shared/contracts";
import type { DesktopSkinDefinition } from "../../../shared/desktop-skin-definition";
import { parseSkinPackageManifest } from "../../../shared/desktop-skin-package";
import { useI18n } from "../../i18n/useI18n";
export function readMarketSkinManifest(item?: MarketItem) { try {
    return item ? parseSkinPackageManifest(JSON.parse(item.metadata?.skinManifest ?? "null")) : null;
}
catch {
    return null;
} }
export function SkinPreview({ item, definition, thumbnail, mode }: {
    item?: MarketItem;
    definition?: DesktopSkinDefinition;
    thumbnail?: string | null;
    mode: "light" | "dark";
}) {
    const { t } = useI18n(), manifest = useMemo(() => readMarketSkinManifest(item), [item?.metadata?.skinManifest]);
    const [image, setImage] = useState("");
    const path = manifest?.variants[mode].background?.path ?? manifest?.preview;
    useEffect(() => { let active = true; setImage(""); if (definition) {
        setImage(definition.backgrounds?.[mode]?.imageUrl ?? thumbnail ?? "");
        return;
    } if (item && path) {
        void window.electronAPI.market.readSkinAsset({ id: item.id, version: item.version, path }).then(result => { if (active)
            setImage(result.dataUrl); }).catch(() => { if (active)
            setImage(thumbnail ?? ""); });
    }
    else
        setImage(thumbnail ?? ""); return () => { active = false; }; }, [item?.id, item?.version, path, definition, thumbnail, mode]);
    const tokens = definition?.tokens[mode] ?? manifest?.variants[mode].tokens ?? {};
    const style: CSSProperties = { backgroundColor: tokens["--bg-base"] ?? (mode === "dark" ? "#1e2530" : "#f1f5fa"), color: tokens["--ink"] ?? (mode === "dark" ? "#e6edf5" : "#273448"), backgroundImage: image ? `url("${image}")` : undefined };
    return <div className={`skin-market-preview is-${mode}`} style={style} role="img" aria-label={t("market.skin.preview", { mode: t(mode === "light" ? "settings.appearance.light" : "settings.appearance.dark") })}>
  <div className="skin-market-preview-sidebar" style={{ backgroundColor: tokens["--surface-sidebar"] ?? (mode === "dark" ? "#212a37cc" : "#ffffffbb") }}><i /><i /><i /><i /></div>
  <div className="skin-market-preview-panel" style={{ backgroundColor: tokens["--surface-strong"] ?? (mode === "dark" ? "#243143cc" : "#ffffffcc") }}><span /><span /><b style={{ backgroundColor: tokens["--control-primary-bg"] ?? tokens["--accent"] ?? "#4885dd" }}/></div>
 </div>;
}
