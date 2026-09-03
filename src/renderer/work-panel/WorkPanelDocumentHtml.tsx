import { EditOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Popover } from "antd";
import type { WorkPanelDocumentHtmlSelection } from "../../shared/work-panel-document-html";
import { WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS } from "../../shared/work-panel-review";
import { useI18n } from "../i18n/useI18n";
import documentHtmlReviewScriptSource from "./work-panel-document-html-review.js?raw";

export type HtmlAnnotation = {
  id: string;
  selector: string;
  xpath: string;
  text: string;
  note: string;
  rect: { x: number; y: number; width: number; height: number };
  valid: boolean;
};

type PendingHtmlAnnotation = Omit<HtmlAnnotation, "id" | "note">;

function annotatedHtml(source: string, token: string) {
  const injectedBootstrap = `<script data-zenmind-review-token="${token}">${documentHtmlReviewScriptSource.trim()}</script>`;
  return source.includes("<head")
    ? source.replace(/<head([^>]*)>/iu, `<head$1>${injectedBootstrap}`)
    : `${injectedBootstrap}${source}`;
}

export function WorkPanelDocumentHtml({
  ownerChatId,
  rendererGeneration,
  document,
  onHandoff,
}: {
  ownerChatId: string;
  rendererGeneration: string;
  document: WorkPanelDocumentHtmlSelection;
  onHandoff(annotations: HtmlAnnotation[]): Promise<boolean>;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const refreshRequestRef = useRef(0);
  const [previewSource, setPreviewSource] = useState("");
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<HtmlAnnotation[]>([]);
  const [annotationListOpen, setAnnotationListOpen] = useState(false);
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingHtmlAnnotation | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [error, setError] = useState("");
  const token = useMemo(() => globalThis.crypto.randomUUID().replace(/-/gu, ""), [document.handleId]);
  const displayUrl = document.displayUrl || `${document.sourceKind}:///${document.fileName}`;
  const displayPath = useMemo(() => {
    try {
      const url = new URL(displayUrl);
      return `${url.pathname}${url.search}${url.hash}` || displayUrl;
    } catch {
      return displayUrl;
    }
  }, [displayUrl]);
  const handleRequest = useMemo(() => ({
    ownerChatId,
    rendererGeneration,
    handleId: document.handleId,
  }), [document.handleId, ownerChatId, rendererGeneration]);

  const refreshPreview = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await window.electronAPI.chatWorkPanel.documentHtml.read(handleRequest);
      if (requestId !== refreshRequestRef.current) return;
      if (!result.ok || result.text === undefined) {
        setError(result.message || t("chatWorkPanel.document.htmlReadFailed"));
        return;
      }
      const previewResult = await window.electronAPI.chatWorkPanel.documentHtml.preview({
        ...handleRequest,
        text: result.text,
      });
      if (requestId !== refreshRequestRef.current) return;
      setPreviewSource(previewResult.ok && previewResult.text !== undefined
        ? previewResult.text
        : result.text);
      setFrameGeneration((current) => current + 1);
    } catch {
      if (requestId === refreshRequestRef.current) {
        setError(t("chatWorkPanel.document.htmlReadFailed"));
      }
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [handleRequest, t]);

  useEffect(() => {
    setPreviewSource("");
    setAnnotating(false);
    setAnnotations([]);
    setAnnotationListOpen(false);
    setPendingAnnotation(null);
    setPendingNote("");
    void refreshPreview();
    return () => { refreshRequestRef.current += 1; };
  }, [document.revision, refreshPreview]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "zenmind-html-annotation-mode",
      token,
      enabled: annotating,
    }, "*");
  }, [annotating, token]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "zenmind-html-annotation-locate",
      token,
      items: annotations.slice(0, 64).map(({ id, selector }, index) => ({
        id,
        selector,
        number: index + 1,
      })),
    }, "*");
  }, [annotations, token]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        !event.data || event.data.token !== token
      ) return;
      if (event.data.type === "zenmind-html-annotation-located") {
        const locatedItems = Array.isArray(event.data.items) ? event.data.items.slice(0, 64) : [];
        const locatedById = new Map<string, { valid: boolean; text?: string; rect?: HtmlAnnotation["rect"] }>();
        for (const item of locatedItems) {
          if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
          const rawRect = item.rect && typeof item.rect === "object" ? item.rect : {};
          locatedById.set(item.id.slice(0, 128), {
            valid: item.valid === true,
            text: typeof item.text === "string" ? item.text.slice(0, 240) : undefined,
            rect: item.valid === true ? {
              x: Number.isFinite(rawRect.x) ? Math.max(0, Number(rawRect.x)) : 0,
              y: Number.isFinite(rawRect.y) ? Math.max(0, Number(rawRect.y)) : 0,
              width: Number.isFinite(rawRect.width) ? Math.max(1, Number(rawRect.width)) : 1,
              height: Number.isFinite(rawRect.height) ? Math.max(1, Number(rawRect.height)) : 1,
            } : undefined,
          });
        }
        setAnnotations((current) => current.map((annotation) => {
          const located = locatedById.get(annotation.id);
          if (!located) return annotation;
          return {
            ...annotation,
            valid: located.valid,
            text: located.text ?? annotation.text,
            rect: located.rect ?? annotation.rect,
          };
        }));
        return;
      }
      if (event.data.type !== "zenmind-html-annotation") return;
      const selector = typeof event.data.selector === "string" ? event.data.selector.slice(0, 512) : "";
      const xpath = typeof event.data.xpath === "string" ? event.data.xpath.slice(0, 1_024) : "";
      const text = typeof event.data.text === "string" ? event.data.text.slice(0, 240) : "";
      const rawRect = event.data.rect && typeof event.data.rect === "object" ? event.data.rect : {};
      const rect = {
        x: Number.isFinite(rawRect.x) ? Math.max(0, Number(rawRect.x)) : 0,
        y: Number.isFinite(rawRect.y) ? Math.max(0, Number(rawRect.y)) : 0,
        width: Number.isFinite(rawRect.width) ? Math.max(1, Number(rawRect.width)) : 1,
        height: Number.isFinite(rawRect.height) ? Math.max(1, Number(rawRect.height)) : 1,
      };
      if (!selector || !xpath || pendingAnnotation) return;
      setPendingAnnotation({
        selector, xpath, text, rect, valid: true,
      });
      setPendingNote("");
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [pendingAnnotation, token]);

  const cancelPendingAnnotation = () => {
    setPendingAnnotation(null);
    setPendingNote("");
  };

  const confirmPendingAnnotation = () => {
    const note = pendingNote.trim();
    if (!pendingAnnotation || !note) return;
    setAnnotations((current) => [...current, {
      ...pendingAnnotation,
      id: globalThis.crypto.randomUUID(),
      note,
    }]);
    cancelPendingAnnotation();
  };

  const refreshCurrentPreview = () => {
    setAnnotationListOpen(false);
    cancelPendingAnnotation();
    void refreshPreview();
  };

  const annotationList = (
    <div className="work-panel-document-html-annotations">
      {annotations.length === 0 ? (
        <div className="work-panel-document-html-annotations-empty">
          {t("chatWorkPanel.review.htmlEmpty")}
        </div>
      ) : annotations.map((annotation, index) => (
        <div className="work-panel-document-html-annotation" key={annotation.id}>
          <code className={annotation.valid ? "" : "is-invalid"}>
            {annotation.selector}{annotation.valid ? "" : ` (${t("chatWorkPanel.document.invalidAnnotation")})`}
          </code>
          <Input
            value={annotation.note}
            disabled={!annotation.valid}
            maxLength={WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS}
            placeholder={annotation.text || t("chatWorkPanel.document.annotationNumber", { number: index + 1 })}
            onChange={(event) => setAnnotations((current) => current.map((item) =>
              item.id === annotation.id ? { ...item, note: event.target.value } : item))}
          />
          <Button danger onClick={() => setAnnotations((current) => current.filter((item) => item.id !== annotation.id))}>
            {t("chatWorkPanel.document.removeAnnotation")}
          </Button>
        </div>
      ))}
      <div className="work-panel-document-html-annotation-actions">
        <Button
          type="primary"
          disabled={!annotations.some((annotation) => annotation.valid && annotation.note.trim())}
          onClick={() => void onHandoff(annotations.filter(
            (annotation) => annotation.valid && annotation.note.trim(),
          )).then((ok) => {
            if (ok) {
              setAnnotations([]);
              setAnnotating(false);
              setAnnotationListOpen(false);
            }
          })}
        >
          {t("chatWorkPanel.document.handoff")}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className={`work-panel-document-html${annotating ? " is-annotating" : ""}`}
      data-work-panel-document-dirty={annotations.length > 0 ? "true" : "false"}
    >
      <div className="work-panel-document-html-toolbar" role="toolbar" aria-label={t("chatWorkPanel.review.htmlTool")}>
        {annotating ? (
          <>
            <Button onClick={() => {
              setAnnotating(false);
              setAnnotationListOpen(false);
              cancelPendingAnnotation();
            }}>
              {t("chatWorkPanel.review.returnPreview")}
            </Button>
            <span className="work-panel-document-html-hint">{t("chatWorkPanel.review.htmlHint")}</span>
            <Popover
              trigger="click"
              placement="bottomRight"
              open={annotationListOpen}
              onOpenChange={setAnnotationListOpen}
              classNames={{ root: "work-panel-document-html-annotations-popover" }}
              content={annotationList}
            >
              <Button
                type="text"
                className="work-panel-document-html-count"
                aria-label={t("chatWorkPanel.review.annotationCount", { count: annotations.length })}
              >
                {t("chatWorkPanel.review.annotationCount", { count: annotations.length })}
              </Button>
            </Popover>
            <Button
              icon={<ReloadOutlined />}
              disabled={loading}
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              onClick={refreshCurrentPreview}
            />
          </>
        ) : (
          <>
            <div className="work-panel-document-html-location" title={displayUrl}>
              <LinkOutlined aria-hidden="true" />
              <input
                readOnly
                spellCheck={false}
                value={displayPath}
                aria-label={displayUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                onCopy={(event) => {
                  event.preventDefault();
                  event.clipboardData.setData("text/plain", displayUrl);
                }}
              />
            </div>
            <Button
              icon={<ReloadOutlined />}
              disabled={loading}
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              onClick={refreshCurrentPreview}
            />
            <Button
              icon={<EditOutlined />}
              disabled={loading || Boolean(error)}
              aria-label={t("chatWorkPanel.review.panel")}
              title={t("chatWorkPanel.review.panel")}
              onClick={() => setAnnotating(true)}
            />
          </>
        )}
      </div>
      <div className="work-panel-document-html-body">
        {loading ? (
          <div className="work-panel-document-html-status">{t("common.loading")}</div>
        ) : error ? (
          <div className="work-panel-document-html-status is-error" role="alert">{error}</div>
        ) : (
          <iframe
            key={frameGeneration}
            ref={frameRef}
            title={document.fileName}
            sandbox="allow-forms allow-modals allow-scripts"
            srcDoc={annotatedHtml(previewSource, token)}
            onLoad={() => {
              frameRef.current?.contentWindow?.postMessage({
                type: "zenmind-html-annotation-mode", token, enabled: annotating,
              }, "*");
              if (annotations.length) {
                frameRef.current?.contentWindow?.postMessage({
                  type: "zenmind-html-annotation-locate",
                  token,
                  items: annotations.slice(0, 64).map(({ id, selector }, index) => ({
                    id,
                    selector,
                    number: index + 1,
                  })),
                }, "*");
              }
            }}
          />
        )}
      </div>
      <Modal
        open={Boolean(pendingAnnotation)}
        title={t("chatWorkPanel.document.addAnnotation")}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !pendingNote.trim() }}
        onOk={confirmPendingAnnotation}
        onCancel={cancelPendingAnnotation}
        destroyOnHidden
      >
        {pendingAnnotation ? (
          <div className="work-panel-document-html-annotation-dialog">
            <code title={pendingAnnotation.xpath}>{pendingAnnotation.selector}</code>
            {pendingAnnotation.text ? <p>{pendingAnnotation.text}</p> : null}
            <Input.TextArea
              autoFocus
              value={pendingNote}
              maxLength={WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS}
              showCount
              autoSize={{ minRows: 3, maxRows: 7 }}
              aria-label={t("chatWorkPanel.review.requirementPlaceholder")}
              placeholder={t("chatWorkPanel.review.requirementPlaceholder")}
              onChange={(event) => setPendingNote(event.target.value)}
              onPressEnter={(event) => {
                if ((event.metaKey || event.ctrlKey) && pendingNote.trim()) confirmPendingAnnotation();
              }}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
