import { useI18n } from "../../i18n/useI18n";
import { PRODUCT_NAME } from "../../../shared/generated/brand";

export function EnvImportOverlay({
  onImport,
  errorMessage,
  busy
}: {
  onImport: () => Promise<void>;
  errorMessage: string;
  busy: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="env-import-overlay">
      <div className="env-import-backdrop" aria-hidden="true" />

      <div className="env-import-card">
        <div className="brand-logo-wrapper">
          <img
            src="/brand-icon.png"
            width="80"
            height="80"
            className="brand-logo-image"
            aria-label={`${PRODUCT_NAME} Logo`}
          />
        </div>

        <h1 className="env-import-title">{t("startup.envImport.title")}</h1>
        <p className="env-import-desc">
          {t("startup.envImport.descriptionPrefix")} <code>env.zip</code> {t("startup.envImport.descriptionSuffix")}
        </p>

        {errorMessage ? (
          <div className="env-import-error">
            {errorMessage}
          </div>
        ) : null}

        <button
          type="button"
          className="env-import-btn"
          disabled={busy}
          onClick={onImport}
        >
          {busy ? (
            <>
              <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" style={{
                width: "14px",
                height: "14px",
                border: "2px solid currentColor",
                borderRightColor: "transparent",
                borderRadius: "50%",
                display: "inline-block",
                animation: "spin 1s linear infinite"
              }} />
              <span>{t("startup.envImport.importing")}</span>
            </>
          ) : (
            t("startup.envImport.action")
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
