import { useRef, useState, type CSSProperties } from "react";
import { Button, Checkbox } from "antd";
import { DeleteOutlined, LoadingOutlined } from "@ant-design/icons";
import { useI18n } from "../i18n/useI18n";
import { useAppearance } from "./AppearanceProvider";
import { DESKTOP_SKINS } from "./skins";
import type { TranslationKey } from "../../shared/i18n";
import { isInstalledDesktopSkinId, type BuiltinDesktopSkinId } from "../../shared/desktop-appearance";
import "./settings.css";

const skinNameKeys: Record<string, TranslationKey> = {
  default: "settings.appearance.skinDefault",
  mist: "settings.appearance.skinMist",
  ocean: "settings.appearance.skinOcean",
  violet: "settings.appearance.skinViolet"
} satisfies Record<BuiltinDesktopSkinId, TranslationKey>;

const errorKeys: Record<string, TranslationKey> = {
  invalidImage: "settings.appearance.invalidImage",
  imageTooLarge: "settings.appearance.imageTooLarge",
  storageFailed: "settings.appearance.storageFailed",
  unavailable: "settings.appearance.loadFailed",
  runtimeOutdated: "settings.appearance.runtimeOutdated",
  invalidPackage: "settings.appearance.invalidPackage",
  unsupportedPackageVersion: "settings.appearance.unsupportedPackageVersion",
  packageTooLarge: "settings.appearance.packageTooLarge",
  packageExists: "settings.appearance.packageExists",
  tooManySkins: "settings.appearance.tooManySkins"
};

export function SkinSettings() {
  const { t } = useI18n();
  const appearance = useAppearance();
  const { skinSettings, skinLoadState, skinSaving, resolvedTheme } = appearance;
  const [error, setError] = useState<TranslationKey | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [keepBackground, setKeepBackground] = useState(false);
  const [importedId, setImportedId] = useState<string | undefined>();
  const lastOperation = useRef<(() => Promise<unknown>) | null>(null);
  const imageUrl = appearance.background?.imageUrl;
  const imageFailed = Boolean(imageUrl && failedImageUrl === imageUrl);
  const disabled = skinSaving || skinLoadState !== "ready";
  async function perform(operation: () => Promise<unknown>) {
    setError(null);
    lastOperation.current = operation;
    try { await operation(); }
    catch (reason) {
      setError(errorKeys[reason instanceof Error ? reason.message : ""] ?? "settings.appearance.storageFailed");
    }
  }
  return (
    <div className="desktop-skin-settings">
      <div className="desktop-skin-heading">
        <div className="desktop-skin-title">
          <strong id="desktop-skin-label">{t("settings.appearance.skin")}</strong>
          <span className="desktop-skin-saving" role="status" aria-live="polite" title={skinSaving ? t("settings.appearance.saving") : undefined}>
            {skinSaving && <><LoadingOutlined aria-hidden="true" /><span className="desktop-skin-saving-label">{t("settings.appearance.saving")}</span></>}
          </span>
        </div>
        <div className="desktop-skin-import">
          <Button disabled={disabled || !appearance.skinPackagesAvailable} onClick={() => void perform(async () => {
            const id = await appearance.importSkinPackage();
            if (id) setImportedId(id);
          })}>{t("settings.appearance.importPackage")}</Button>
        </div>
      </div>
      {skinLoadState === "ready" && !appearance.skinPackagesAvailable && <p className="desktop-skin-status" role="status">{t("settings.appearance.runtimeOutdated")}</p>}
      <div className="desktop-skin-options" role="group" aria-labelledby="desktop-skin-label">
        {DESKTOP_SKINS.map((option) => {
          const preview = option.backgrounds?.[resolvedTheme];
          const name = t(skinNameKeys[option.id]);
          return <button key={option.id} type="button" className="desktop-skin-option" data-skin-option={option.id}
            aria-label={name} aria-pressed={skinSettings.skinId === option.id} disabled={disabled}
            onClick={() => { if (skinSettings.skinId !== option.id) void perform(() => appearance.setSkinId(option.id)); }}>
            <span className="desktop-skin-sample" aria-hidden="true" style={{
              ...option.tokens[resolvedTheme],
              backgroundImage: preview ? `url(${JSON.stringify(preview.imageUrl)})` : undefined
            } as CSSProperties} data-sample-skin={option.id}>
              <span className="desktop-skin-sample-sidebar"><i /><i /><i /></span>
              <span className="desktop-skin-sample-content"><i /><i /><b /></span>
            </span>
            <span className="desktop-skin-option-label">{name}<span aria-hidden="true">{skinSettings.skinId === option.id ? "✓" : ""}</span></span>
          </button>;
        })}
      </div>
      {Boolean(skinSettings.installedSkins?.length) && <>
        <div className="desktop-skin-heading"><strong>{t("settings.appearance.installedPackages")}</strong></div>
        {skinSettings.background && <Checkbox checked={keepBackground} disabled={disabled} onChange={(event) => setKeepBackground(event.target.checked)}>
          {t("settings.appearance.keepBackground")}
        </Checkbox>}
        <div className="desktop-skin-options desktop-installed-skins" role="group" aria-label={t("settings.appearance.installedPackages")}>
          {skinSettings.installedSkins!.map((option) => <div className="desktop-installed-skin" key={option.id}>
            <button type="button" className="desktop-skin-option" data-skin-option={option.id}
              aria-label={option.name} aria-pressed={skinSettings.skinId === option.id} disabled={disabled}
              onClick={() => void perform(async () => { await appearance.setSkinId(option.id, { keepBackground }); setImportedId(undefined); })}>
              <span className="desktop-skin-sample" aria-hidden="true">
                {option.previewDataUrl && <img src={option.previewDataUrl} alt="" />}
                {!option.previewDataUrl && <span className="desktop-skin-no-preview">{option.name.slice(0, 1)}</span>}
              </span>
              <span className="desktop-skin-option-label">{option.name}<span aria-hidden="true">{skinSettings.skinId === option.id ? "✓" : ""}</span></span>
              <span className="desktop-skin-package-meta">v{option.version}{option.author ? ` · ${option.author}` : ""}</span>
            </button>
            <Button className="desktop-skin-remove" type="text" size="small" danger icon={<DeleteOutlined />} disabled={disabled}
              title={t("settings.appearance.removePackage")} aria-label={t("settings.appearance.removePackageNamed", { name: option.name })}
              onClick={() => void perform(async () => { await appearance.removeSkinPackage(option.id); if (importedId === option.id) setImportedId(undefined); })} />
          </div>)}
        </div>
      </>}
      <div className="desktop-background-setting">
        <div className="desktop-background-sample" aria-hidden="true">
          {appearance.background && !imageFailed
            ? <img key={imageUrl} src={imageUrl} alt="" onError={() => setFailedImageUrl(imageUrl ?? null)} />
            : <span />}
        </div>
        <div className="desktop-background-copy"><strong>{t("settings.appearance.background")}</strong>
          <span className="desktop-background-name" title={skinSettings.background?.name}>
            {t(skinSettings.background ? "settings.appearance.customBackground"
              : appearance.background ? "settings.appearance.bundledBackground" : "settings.appearance.noBackground")}
          </span>
        </div>
        <div className="desktop-background-actions">
          <Button disabled={disabled} title={t("settings.appearance.backgroundDescription")} onClick={() => void perform(appearance.importBackground)}>
            {t(skinSettings.background ? "settings.appearance.replaceBackground" : "settings.appearance.importBackground")}
          </Button>
          {skinSettings.background && <Button disabled={disabled} onClick={() => void perform(appearance.resetBackground)}>
            {t("settings.appearance.resetBackground")}
          </Button>}
        </div>
      </div>
      <div className="desktop-skin-status" aria-live="polite">
        {skinLoadState === "loading" && <span>{t("settings.appearance.loading")}</span>}
        {importedId && skinSettings.installedSkins?.some((option) => option.id === importedId) && <span>{t("settings.appearance.packageImported")}</span>}
        {isInstalledDesktopSkinId(skinSettings.skinId) && !skinSettings.installedSkin && <span role="status">{t("settings.appearance.packageMissing")}</span>}
        {skinLoadState === "error" && <div role="alert">{t("settings.appearance.loadFailed")}
          <Button size="small" onClick={() => void appearance.refreshAppearanceFromCanonical()}>{t("settings.appearance.retry")}</Button>
        </div>}
        {skinSettings.background && (!skinSettings.backgroundDataUrl || imageFailed) &&
          <span role="status">{t("settings.appearance.backgroundMissing")}</span>}
        {error && <div className="desktop-skin-error" role="alert">{t(error)}
          {error !== "settings.appearance.runtimeOutdated" && <Button size="small" disabled={skinSaving} onClick={() => { if (lastOperation.current) void perform(lastOperation.current); }}>{t("settings.appearance.retry")}</Button>}
          <Button size="small" disabled={skinSaving} onClick={() => void perform(async () => {
            await appearance.refreshAppearanceFromCanonical();
            if (appearance.getAppearanceSnapshot().skinLoadState !== "ready") throw new Error("unavailable");
          })}>{t("settings.appearance.reloadAppearance")}</Button>
        </div>}
      </div>
    </div>
  );
}
