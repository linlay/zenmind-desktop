import { useState, type CSSProperties } from "react";
import { Button } from "antd";
import { useI18n } from "../i18n/useI18n";
import { useAppearance } from "./AppearanceProvider";
import { DESKTOP_SKINS } from "./skins";
import type { TranslationKey } from "../../shared/i18n";
import "./settings.css";

const errorKeys: Record<string, TranslationKey> = {
  invalidImage: "settings.appearance.invalidImage",
  imageTooLarge: "settings.appearance.imageTooLarge",
  storageFailed: "settings.appearance.storageFailed",
  unavailable: "settings.appearance.loadFailed"
};

export function SkinSettings() {
  const { t } = useI18n();
  const appearance = useAppearance();
  const { skin, skinSettings, skinLoadState, skinSaving, resolvedTheme } = appearance;
  const [error, setError] = useState<TranslationKey | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageUrl = appearance.background?.imageUrl;
  const imageFailed = Boolean(imageUrl && failedImageUrl === imageUrl);
  const disabled = skinSaving || skinLoadState !== "ready";
  async function perform(operation: () => Promise<unknown>) {
    setError(null);
    try { await operation(); }
    catch (reason) {
      setError(errorKeys[reason instanceof Error ? reason.message : ""] ?? "settings.appearance.storageFailed");
    }
  }
  return (
    <div className="desktop-skin-settings">
      <div className="desktop-skin-heading"><strong id="desktop-skin-label">{t("settings.appearance.skin")}</strong>
        <span>{t("settings.appearance.skinDescription")}</span></div>
      <div className="desktop-skin-options" role="group" aria-labelledby="desktop-skin-label">
        {DESKTOP_SKINS.map((option) => {
          const preview = option.backgrounds?.[resolvedTheme];
          const name = t(option.id === "mist" ? "settings.appearance.skinMist" : "settings.appearance.skinDefault");
          return <button key={option.id} type="button" className="desktop-skin-option" data-skin-option={option.id}
            aria-label={name} aria-pressed={skin.id === option.id} disabled={disabled}
            onClick={() => { if (skin.id !== option.id) void perform(() => appearance.setSkinId(option.id)); }}>
            <span className="desktop-skin-sample" aria-hidden="true" style={{
              ...option.tokens[resolvedTheme],
              backgroundImage: preview ? `url(${JSON.stringify(preview.imageUrl)})` : undefined
            } as CSSProperties} data-sample-skin={option.id}>
              <span className="desktop-skin-sample-sidebar"><i /><i /><i /></span>
              <span className="desktop-skin-sample-content"><i /><i /><b /></span>
            </span>
            <span className="desktop-skin-option-label">{name}<span aria-hidden="true">{skin.id === option.id ? "✓" : ""}</span></span>
          </button>;
        })}
      </div>
      <div className="desktop-background-setting">
        <div className="desktop-background-sample" aria-hidden="true">
          {appearance.background && !imageFailed
            ? <img key={imageUrl} src={imageUrl} alt="" onError={() => setFailedImageUrl(imageUrl ?? null)} />
            : <span />}
        </div>
        <div className="desktop-background-copy"><strong>{t("settings.appearance.background")}</strong>
          <span className="desktop-background-name" title={skinSettings.background?.name}>
            {skinSettings.background?.name || t("settings.appearance.bundledBackground")}
          </span>
          <span>{t("settings.appearance.backgroundDescription")}</span>
          <div className="desktop-background-actions">
            <Button disabled={disabled} onClick={() => void perform(appearance.importBackground)}>
              {t(skinSettings.background ? "settings.appearance.replaceBackground" : "settings.appearance.importBackground")}
            </Button>
            {skinSettings.background && <Button disabled={disabled} onClick={() => void perform(appearance.resetBackground)}>
              {t("settings.appearance.resetBackground")}
            </Button>}
          </div>
        </div>
      </div>
      <div className="desktop-skin-status" aria-live="polite">
        {skinLoadState === "loading" && <span>{t("settings.appearance.loading")}</span>}
        {skinSaving && <span>{t("settings.appearance.saving")}</span>}
        {skinLoadState === "error" && <div role="alert">{t("settings.appearance.loadFailed")}
          <Button size="small" onClick={() => void appearance.refreshAppearanceFromCanonical()}>{t("settings.appearance.retry")}</Button>
        </div>}
        {skinSettings.background && (!skinSettings.backgroundDataUrl || imageFailed) &&
          <span role="status">{t("settings.appearance.backgroundMissing")}</span>}
        {error && <span className="desktop-skin-error" role="alert">{t(error)}</span>}
      </div>
    </div>
  );
}
