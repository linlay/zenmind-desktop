import { useI18n } from "../i18n/useI18n";

export function EmptyContentSurface() {
  const { t } = useI18n();

  return (
    <section
      className="empty-content-surface"
      aria-labelledby="empty-content-surface-title"
      aria-live="polite"
    >
      <div className="empty-content-surface-content">
        <span
          className="empty-content-surface-loader"
          role="status"
          aria-label={t("emptyContent.surface.loadingAria")}
        />
        <h1 id="empty-content-surface-title">{t("emptyContent.surface.loading")}</h1>
      </div>
    </section>
  );
}
