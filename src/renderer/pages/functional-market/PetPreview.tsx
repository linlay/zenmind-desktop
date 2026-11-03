import { useEffect, useState, type CSSProperties } from "react";
import type { DesktopPetAppearanceOption, DesktopPetSignatureAction, DesktopPetStateAsset, MarketItem } from "@shared/contracts";
import { DESKTOP_PET_REQUIRED_STATE_KEYS, versionedDesktopPetAssetUrl } from "../../../shared/desktop-pet";
import { useI18n } from "../../i18n/useI18n";

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && /\.(png|webp)$/iu.test(value)
    && !value.split("/").some(part => !part || part.startsWith(".") || /[\\:%\x00-\x1f]/u.test(part));
}
function previewActions(value: unknown): DesktopPetSignatureAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((action: unknown) => {
    if (!action || typeof action !== "object" || !("id" in action) || !("label" in action) || !("variants" in action)
      || typeof action.id !== "string" || typeof action.label !== "string" || !Array.isArray(action.variants)) return [];
    const variants = action.variants.filter((variant: { path?: unknown; frameCount?: number; durationMs?: number }) =>
      validPath(variant?.path) && Number.isInteger(variant.frameCount) && variant.frameCount! >= 1 && variant.frameCount! <= 120
      && Number.isFinite(variant.durationMs) && variant.durationMs! > 0);
    return variants.length ? [{ id: action.id, label: action.label, trigger: [], variants }] as DesktopPetSignatureAction[] : [];
  });
}
export function readPetPreviewManifest(item: MarketItem) {
  try {
    const manifest = JSON.parse(item.metadata?.petManifest ?? "null");
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !manifest.states) return null;
    const states: Record<string, DesktopPetStateAsset> = {};
    for (const key of DESKTOP_PET_REQUIRED_STATE_KEYS) {
      const asset = manifest.states[key];
      if (!asset || !validPath(asset.path) || !Number.isInteger(asset.frameCount) || asset.frameCount < 4 || asset.frameCount > 8
        || !Number.isFinite(asset.durationMs) || asset.durationMs <= 0) return null;
      states[key] = { ...asset, alts: previewActions(asset.alts) };
    }
    const signature = previewActions(manifest.signature);
    return { ...manifest, states, signature } as DesktopPetAppearanceOption;
  } catch { return null; }
}
export function PetPreview({ item, appearance }: {
  item?: MarketItem;
  appearance?: DesktopPetAppearanceOption;
}) {
  const { t } = useI18n();
  const manifest = appearance ?? (item ? readPetPreviewManifest(item) : null);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ width: 128, height: 128 });
  const asset = manifest?.states.idle;
  useEffect(() => {
    let active = true;
    setSource(""); setFailed(false);
    if (!asset || !validPath(asset.path)) { setFailed(true); return; }
    if (appearance) {
      setSource(versionedDesktopPetAssetUrl(appearance.assetBasePath, asset.path, appearance.assetVersion));
    } else if (item) {
      void window.electronAPI.market.readPetAsset({ id: item.id, version: item.version, path: asset.path }).then(result => {
        if (active) setSource(result.dataUrl);
      }).catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; };
  }, [appearance?.assetBasePath, appearance?.assetVersion, item?.id, item?.version, asset?.path]);
  const frames = Math.max(1, Number(asset?.frameCount) || 1);
  useEffect(() => {
    let active = true;
    setSize({ width: 128, height: 128 });
    if (!source) return;
    const image = new Image();
    image.onload = () => {
      if (!active || !image.naturalWidth || !image.naturalHeight) return;
      const frameWidth = image.naturalWidth / frames;
      const scale = Math.min(144 / frameWidth, 144 / image.naturalHeight);
      setSize({ width: frameWidth * scale, height: image.naturalHeight * scale });
    };
    image.onerror = () => { if (active) setFailed(true); };
    image.src = source;
    return () => { active = false; };
  }, [source, frames]);
  const style = {
    width: size.width,
    height: size.height,
    backgroundImage: source ? `url("${source}")` : undefined,
    backgroundSize: `${frames * 100}% 100%`,
    backgroundPosition: "0 0"
  } as CSSProperties;
  return <div className="pet-market-preview">
    <div className="pet-market-stage">
      {failed ? <span className="pet-market-preview-fallback">{t("market.pet.noPreview")}</span>
        : <span aria-label={t("market.pet.animationPreview")} role="img" className="pet-market-sprite" style={style} />}
    </div>
  </div>;
}
