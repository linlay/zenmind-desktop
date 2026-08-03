import type { ShutdownProgress } from "../../shared/shutdown";
import type { TranslateFunction } from "../../shared/i18n";

type DesktopShutdownOverlayProps = {
  progress: ShutdownProgress | null;
  version: string;
  t: TranslateFunction;
};

const phaseMessageKeys = {
  preparing: "shutdown.progress.preparing",
  stopping: "shutdown.progress.stopping",
  forcing: "shutdown.progress.forcing",
  verifying: "shutdown.progress.verifying",
  complete: "shutdown.progress.complete",
  failed: "shutdown.progress.failed"
} as const;

export function DesktopShutdownOverlay({ progress, version, t }: DesktopShutdownOverlayProps) {
  if (!progress) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  const message = progress.message || t(phaseMessageKeys[progress.phase]);

  return (
    <div className="desktop-shutdown-overlay" role="dialog" aria-modal="true" aria-labelledby="desktop-shutdown-title">
      <section className="desktop-shutdown-card">
        {version ? <span className="desktop-shutdown-version">{version}</span> : null}
        <div className="desktop-shutdown-brand-mark" aria-hidden="true" />
        <div className="desktop-shutdown-copy">
          <h2 id="desktop-shutdown-title">{t("shutdown.progress.title")}</h2>
          <p aria-live="polite">{message}</p>
        </div>
        <div
          className="desktop-shutdown-progress"
          role="progressbar"
          aria-label={t("shutdown.progress.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="desktop-shutdown-percent" aria-hidden="true">{percent}%</div>
      </section>
    </div>
  );
}
