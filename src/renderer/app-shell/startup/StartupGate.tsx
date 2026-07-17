import type { StartupSurfaceMode } from "../../../shared/startup-gate";
import { useI18n } from "../../i18n/useI18n";

type StartupSurfaceProps = {
  mode: StartupSurfaceMode | "empty";
  overlay?: boolean;
  onOpenControlCenter: () => void;
};

export function StartupRoutePlaceholder({
  mode,
  onOpenControlCenter
}: Omit<StartupSurfaceProps, "overlay">) {
  return <StartupSurface mode={mode} onOpenControlCenter={onOpenControlCenter} />;
}

export function StartupSurface({
  mode,
  overlay = false,
  onOpenControlCenter
}: StartupSurfaceProps) {
  const { t } = useI18n();
  const loading = mode === "loading" || mode === "slow";
  const title = mode === "loading"
    ? t("startup.surface.loading")
    : mode === "slow"
      ? t("startup.surface.slow")
      : mode === "failed"
        ? t("startup.surface.failed")
        : t("startup.surface.empty");
  const showRecoveryAction = mode === "failed" || mode === "empty";
  const titleId = overlay ? "startup-surface-overlay-title" : "startup-surface-title";

  return (
    <section
      className={[
        "startup-surface",
        overlay ? "is-overlay" : "",
        `is-${mode}`
      ].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      aria-live="polite"
    >
      <div className="startup-surface-content">
        {loading ? (
          <span
            className="startup-surface-loader"
            role="status"
            aria-label={t("startup.surface.loadingAria")}
          />
        ) : null}
        <h1 id={titleId}>{title}</h1>
        {showRecoveryAction ? (
          <button type="button" className="action-button" onClick={onOpenControlCenter}>
            {t("startup.action.openControlCenter")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
