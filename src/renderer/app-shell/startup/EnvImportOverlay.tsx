import { useI18n } from "../../i18n/useI18n";

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
        <div className="zenmind-logo-wrapper">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 400 400"
            width="80"
            height="80"
            className="zenmind-logo-svg"
            role="img"
            aria-label="ZenMind Logo"
          >
            <defs>
              <mask id="mask-white-hollow" x="0" y="0" width="400" height="400" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
                <rect width="400" height="400" fill="white" />
                <g fill="black" transform="translate(0, -20)">
                  <path d="M 120 135 Q 200 92 280 135 Q 200 132 120 135 Z" />
                  <path d="M 60 180 Q 200 102 340 180 Q 200 173 60 180 Z" />
                  <polygon points="231.5,190 278.5,190 168.5,290 121.5,290" />
                  <rect x="115" y="290" width="170" height="25" />
                </g>
              </mask>
            </defs>
            <path
              d="M 344.889 238.823
                 A 90 90 0 0 1 238.798 344.982
                 A 90 90 0 0 1 93.909 306.159
                 A 90 90 0 0 1 55.111 161.177
                 A 90 90 0 0 1 161.202 55.018
                 A 90 90 0 0 1 306.091 93.841
                 A 90 90 0 0 1 344.889 238.823 Z"
              fill="currentColor"
              mask="url(#mask-white-hollow)"
            />
          </svg>
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
