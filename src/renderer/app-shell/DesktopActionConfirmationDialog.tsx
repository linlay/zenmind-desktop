import { useEffect, useRef, useState } from "react";
import type {
  DesktopActionConfirmationDecision,
  DesktopActionConfirmationRequest
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

type DesktopActionConfirmationDialogProps = {
  request: DesktopActionConfirmationRequest | null;
  onDecision: (decision: DesktopActionConfirmationDecision) => void;
};

export function DesktopActionConfirmationDialog({
  request,
  onDecision
}: DesktopActionConfirmationDialogProps) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const defaultButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDetailsOpen(false);
    if (!request) {
      return;
    }
    window.setTimeout(() => {
      defaultButtonRef.current?.focus();
    }, 0);
  }, [request?.requestId]);

  useEffect(() => {
    if (!request) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDecision(request.cancelDecision);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onDecision, request]);

  if (!request) {
    return null;
  }

  const titleId = `desktop-action-confirmation-title-${request.requestId}`;
  const defaultDecision = request.defaultDecision;

  return (
    <div className="desktop-action-confirmation-layer" role="presentation">
      <section
        className="desktop-action-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="desktop-action-confirmation-head">
          <h2 id={titleId}>{request.title}</h2>
        </header>
        <div className="desktop-action-confirmation-body">
          <p className="desktop-action-confirmation-summary">{request.summary}</p>
          {request.description ? (
            <p className="desktop-action-confirmation-description">{request.description}</p>
          ) : null}
          <dl className="desktop-action-confirmation-fields">
            {request.fields.map((field) => (
              <div key={field.label} className="desktop-action-confirmation-field">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
          <details
            className="desktop-action-confirmation-details"
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary>
              {detailsOpen
                ? t("desktopAction.confirmHideDetails")
                : t("desktopAction.confirmShowDetails")}
            </summary>
            <pre>{request.details}</pre>
          </details>
        </div>
        <footer className="desktop-action-confirmation-actions">
          {request.buttons.map((button) => (
            <button
              key={button.decision}
              ref={button.decision === defaultDecision ? defaultButtonRef : undefined}
              type="button"
              className={[
                "desktop-action-confirmation-button",
                `is-${button.variant}`
              ].join(" ")}
              onClick={() => onDecision(button.decision)}
            >
              {button.label}
            </button>
          ))}
        </footer>
      </section>
    </div>
  );
}
