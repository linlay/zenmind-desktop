import { DeleteOutlined, ExportOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { useEffect, useRef, useState } from "react";
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
  const previousAnnotationCountRef = useRef(session.annotations.length);
  const [activeAnnotationId, setActiveAnnotationId] = useState(
    session.annotations[session.annotations.length - 1]?.id ?? "",
  );
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
    const activeExists = session.annotations.some(
      (annotation) => annotation.id === activeAnnotationId,
    );
    if (
      session.annotations.length > previousAnnotationCountRef.current ||
      (!activeExists && session.annotations.length > 0)
    ) {
      setActiveAnnotationId(session.annotations[session.annotations.length - 1]?.id ?? "");
    }
    if (session.annotations.length === 0 && activeAnnotationId) setActiveAnnotationId("");
    previousAnnotationCountRef.current = session.annotations.length;
  }, [session.annotations.length]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    const textarea = listRef.current?.querySelector<HTMLTextAreaElement>(
      ".chat-work-panel-review-annotation.is-active textarea",
    );
    if (!textarea) return;
    textarea.focus();
    textarea.scrollIntoView({ block: "nearest" });
  }, [activeAnnotationId, session.annotations.length]);

  return (
    <>
      {session.kind === "image" ? (
        <div className="chat-work-panel-review-toolbar">
          <span className="chat-work-panel-review-tool-label">
            {t("chatWorkPanel.review.imageTool")}
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
      ) : null}
      <aside
        className={`chat-work-panel-review-panel is-${session.kind}`}
        aria-label={t("chatWorkPanel.review.panel")}
      >
        <header className="chat-work-panel-review-panel-header">
          <div>
            <strong>
              {session.kind === "html"
                ? t("chatWorkPanel.review.htmlTool")
                : t("chatWorkPanel.review.panel")}
              <span className="chat-work-panel-review-header-count">
                {session.annotations.length}/{WORK_PANEL_REVIEW_MAX_ANNOTATIONS}
              </span>
            </strong>
            <span>{session.kind === "html"
              ? t("chatWorkPanel.review.htmlHint")
              : t("chatWorkPanel.review.runtimeOnly")}</span>
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
              className={`chat-work-panel-review-annotation${annotation.id === activeAnnotationId ? " is-active" : ""}${annotation.invalidReason ? " is-invalid" : ""}`}
            >
              <header>
                <button
                  type="button"
                  className="chat-work-panel-review-target-trigger"
                  aria-expanded={annotation.id === activeAnnotationId}
                  onClick={() => setActiveAnnotationId(annotation.id)}
                >
                  <span className="chat-work-panel-review-number">{annotation.number}</span>
                  <span className="chat-work-panel-review-target">
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
                      <>
                        <span className="chat-work-panel-review-element-title">
                          {annotation.tagName ? `<${annotation.tagName}>` : annotation.fullXPath}
                        </span>
                        <code title={annotation.fullXPath}>{annotation.fullXPath}</code>
                      </>
                    )}
                  </span>
                  {annotation.requirement.trim() ? (
                    <span className="chat-work-panel-review-requirement-preview">
                      {annotation.requirement.trim()}
                    </span>
                  ) : null}
                </button>
                <Button
                  size="small"
                  type="text"
                  danger
                  aria-label={t("chatWorkPanel.review.remove", { number: annotation.number })}
                  icon={<DeleteOutlined />}
                  onClick={() => onRemove(annotation.id)}
                />
              </header>
              {annotation.id === activeAnnotationId && annotation.kind === "html-element" && annotation.textExcerpt ? (
                <div className="chat-work-panel-review-element-summary">
                  {annotation.textExcerpt}
                </div>
              ) : null}
              {annotation.id === activeAnnotationId && annotation.invalidReason ? (
                <div className="chat-work-panel-review-invalid-copy">
                  {t("chatWorkPanel.review.invalidTarget")}: {invalidReason(annotation.invalidReason)}
                </div>
              ) : null}
              {annotation.id === activeAnnotationId ? (
                <Input.TextArea
                  value={annotation.requirement}
                  maxLength={WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS}
                  showCount
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  aria-label={t("chatWorkPanel.review.requirementLabel", {
                    number: annotation.number,
                  })}
                  placeholder={t("chatWorkPanel.review.requirementPlaceholder")}
                  onChange={(event) => onRequirementChange(annotation.id, event.target.value)}
                />
              ) : null}
            </article>
          ))}
        </div>
        {session.kind === "html" ? (
          <footer className="chat-work-panel-review-panel-footer">
            <span>{t("chatWorkPanel.review.runtimeOnly")}</span>
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
          </footer>
        ) : null}
      </aside>
    </>
  );
}
