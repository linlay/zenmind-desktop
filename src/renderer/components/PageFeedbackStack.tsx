import { useI18n } from "../i18n/useI18n";

export type PageFeedbackItem = {
  id: number | string;
  tone: "success" | "error";
  message: string;
  onDismiss?: () => void;
};

type PageFeedbackStackProps = {
  items: PageFeedbackItem[];
};

export function PageFeedbackStack({ items }: PageFeedbackStackProps) {
  const { t } = useI18n();
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="page-feedback-anchor">
      <div className="page-feedback-layer" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={item.tone === "error" ? "feedback-banner warning-banner page-feedback-toast" : "feedback-banner page-feedback-toast"}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <span className="page-feedback-message">{item.message}</span>
            {item.onDismiss ? (
              <button
                type="button"
                className="page-feedback-dismiss"
                aria-label={t("pageFeedback.close")}
                onClick={item.onDismiss}
              >
                {t("pageFeedback.dismiss")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
