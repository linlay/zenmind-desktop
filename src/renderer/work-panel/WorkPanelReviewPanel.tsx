import { DeleteOutlined, ExportOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { useEffect, useRef } from "react";
import {
  WORK_PANEL_REVIEW_MAX_ANNOTATIONS,
  WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS,
  isWorkPanelReviewReadyForComposer,
  type WorkPanelReviewSession,
} from "../../shared/work-panel-review";
import { useI18n } from "../i18n/useI18n";

type WorkPanelReviewPanelProps = {
  session: WorkPanelReviewSession;
  busy: boolean;
  error: string;
  onExit(): void;
  onDiscard(): void;
  onHandoff(): void;
  onRemove(annotationId: string): void;
  onRequirementChange(annotationId: string, requirement: string): void;
};

export function WorkPanelReviewPanel({
  session,
  busy,
  error,
  onExit,
  onDiscard,
  onHandoff,
  onRemove,
  onRequirementChange,
}: WorkPanelReviewPanelProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const invalidReason = (reason: string) => {
    if (reason === "source_revision_changed") {
      return t("chatWorkPanel.review.reason.sourceRevisionChanged");
    }
    if (reason === "xpath_unresolved") {
      return t("chatWorkPanel.review.reason.xpathUnresolved");
    }
    if (reason === "preview_reloaded") {
      return t("chatWorkPanel.review.reason.previewReloaded");
    }
    return t("chatWorkPanel.review.reason.unknown");
  };

  useEffect(() => {
    const textareas = listRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? [];
    const last = textareas[textareas.length - 1];
    if (last && !last.value) {
      last.focus();
      last.scrollIntoView({ block: "nearest" });
    }
  }, [session.annotations.length]);

  return (
    <>
      <div className="chat-work-panel-review-toolbar">
        <span className="chat-work-panel-review-tool-label">
          {session.kind === "image"
            ? t("chatWorkPanel.review.imageTool")
            : t("chatWorkPanel.review.htmlTool")}
        </span>
        <span className="chat-work-panel-review-limit">
          {session.annotations.length}/{WORK_PANEL_REVIEW_MAX_ANNOTATIONS}
        </span>
        <Button size="small" icon={<LogoutOutlined />} onClick={onExit}>
          {t("chatWorkPanel.review.exit")}
        </Button>
        <Button
          size="small"
          type="primary"
          icon={<ExportOutlined />}
          loading={busy}
          disabled={busy || !isWorkPanelReviewReadyForComposer(session)}
          onClick={onHandoff}
        >
          {t("chatWorkPanel.review.handoff")}
        </Button>
      </div>
      <aside className="chat-work-panel-review-panel" aria-label={t("chatWorkPanel.review.panel") }>
        <header className="chat-work-panel-review-panel-header">
          <div>
            <strong>{t("chatWorkPanel.review.panel")}</strong>
            <span>{t("chatWorkPanel.review.runtimeOnly")}</span>
          </div>
          {session.annotations.length > 0 ? (
            <Button size="small" type="text" danger onClick={onDiscard}>
              {t("chatWorkPanel.review.discard")}
            </Button>
          ) : null}
        </header>
        {session.invalidReason ? (
          <div className="chat-work-panel-review-error" role="alert">
            {t("chatWorkPanel.review.invalid")}: {invalidReason(session.invalidReason)}
          </div>
        ) : null}
        {error ? (
          <div className="chat-work-panel-review-error" role="alert">{error}</div>
        ) : null}
        <div ref={listRef} className="chat-work-panel-review-list">
          {session.annotations.length === 0 ? (
            <div className="chat-work-panel-review-empty">
              {session.kind === "image"
                ? t("chatWorkPanel.review.imageEmpty")
                : t("chatWorkPanel.review.htmlEmpty")}
            </div>
          ) : session.annotations.map((annotation) => (
            <article
              key={annotation.id}
              className={`chat-work-panel-review-annotation${annotation.invalidReason ? " is-invalid" : ""}`}
            >
              <header>
                <span className="chat-work-panel-review-number">{annotation.number}</span>
                <div className="chat-work-panel-review-target">
                  {annotation.kind === "image-region" ? (
                    <code>
                      [{[
                        annotation.rect.x,
                        annotation.rect.y,
                        annotation.rect.width,
                        annotation.rect.height,
                      ].map((value) => Math.round(value)).join(", ")}]
                    </code>
                  ) : (
                    <code title={annotation.fullXPath}>{annotation.fullXPath}</code>
                  )}
                </div>
                <Button
                  size="small"
                  type="text"
                  danger
                  aria-label={t("chatWorkPanel.review.remove", { number: annotation.number })}
                  icon={<DeleteOutlined />}
                  onClick={() => onRemove(annotation.id)}
                />
              </header>
              {annotation.kind === "html-element" && (annotation.tagName || annotation.textExcerpt) ? (
                <div className="chat-work-panel-review-element-summary">
                  {annotation.tagName ? `<${annotation.tagName}>` : ""}
                  {annotation.textExcerpt ? ` ${annotation.textExcerpt}` : ""}
                </div>
              ) : null}
              {annotation.invalidReason ? (
                <div className="chat-work-panel-review-invalid-copy">
                  {t("chatWorkPanel.review.invalidTarget")}: {invalidReason(annotation.invalidReason)}
                </div>
              ) : null}
              <Input.TextArea
                value={annotation.requirement}
                maxLength={WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS}
                showCount
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder={t("chatWorkPanel.review.requirementPlaceholder")}
                onChange={(event) => onRequirementChange(annotation.id, event.target.value)}
              />
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}
