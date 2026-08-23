import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopActionConfirmationDecision,
  DesktopActionConfirmationRequest
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

type DesktopActionConfirmationDialogProps = {
  request: DesktopActionConfirmationRequest | null;
  onDecision: (decision: DesktopActionConfirmationDecision) => void;
};

function getDialogFocusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("summary, button:not([disabled]), [tabindex]:not([tabindex='-1'])")
  ).filter((element) => element !== dialog && !element.hasAttribute("hidden"));
}

function isNativeEnterTarget(dialog: HTMLElement, element: Element | null) {
  return element instanceof HTMLElement &&
    dialog.contains(element) &&
    element.matches(
      "summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [contenteditable='true']"
    );
}

export function DesktopActionConfirmationDialog({
  request,
  onDecision
}: DesktopActionConfirmationDialogProps) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const defaultButtonRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    setDetailsOpen(false);
    if (!request) {
      return;
    }
    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusDefaultDecision = () => {
      const focusTarget = defaultButtonRef.current ?? dialogRef.current;
      focusTarget?.focus({ preventScroll: true });
    };
    focusDefaultDecision();
    window.addEventListener("focus", focusDefaultDecision);

    return () => {
      window.removeEventListener("focus", focusDefaultDecision);
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, [request?.defaultDecision, request?.requestId]);

  useEffect(() => {
    if (!request) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDecision(request.cancelDecision);
        return;
      }
      const dialog = dialogRef.current;
      if (event.key === "Enter") {
        if (dialog && isNativeEnterTarget(dialog, document.activeElement)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (
          !event.isComposing &&
          !event.repeat &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          defaultButtonRef.current?.click();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      if (!dialog) {
        return;
      }
      const focusableElements = getDialogFocusableElements(dialog);
      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);
      if (!firstElement || !lastElement) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
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
        ref={dialogRef}
        className="desktop-action-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="desktop-action-confirmation-head">
          <h2 id={titleId}>{request.title}</h2>
        </header>
        <div className="desktop-action-confirmation-body">
          <p className="desktop-action-confirmation-summary">{request.summary}</p>
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
            <pre>{request.details}</pre>
          </details>
        </div>
        <footer className="desktop-action-confirmation-actions">
          <p className="desktop-action-confirmation-settings-hint">
            {t("desktopAction.confirmSettingsHint")}
          </p>
          <div className="desktop-action-confirmation-buttons">
            {request.buttons.map((button) => (
              <button
                key={button.decision}
                ref={button.decision === defaultDecision ? defaultButtonRef : undefined}
                type="button"
                data-decision={button.decision}
                className={[
                  "desktop-action-confirmation-button",
                  `is-${button.variant}`
                ].join(" ")}
                onClick={() => onDecision(button.decision)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </footer>
      </section>
    </div>
  );
}
