import { EditOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { forwardRef, useImperativeHandle, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Popover } from "antd";
import { WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, WORK_PANEL_DOCUMENT_HTML_REVIEW_EVENT, type WorkPanelDocumentHtmlSelection, type WorkPanelDocumentHtmlPreviewResult } from "../../shared/work-panel-document-html";
import { WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS } from "../../shared/work-panel-review";
import { useI18n } from "../i18n/useI18n";


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

export type HtmlDocumentController = { reload(): void; toggleReview(): void; isAnnotating(): boolean };
type Props = {
  ownerChatId: string;
  rendererGeneration: string;
  document: WorkPanelDocumentHtmlSelection;
  active: boolean;
  preloadUrl: string;
  onHandoff(annotations: HtmlAnnotation[]): Promise<boolean>;
};

export const WorkPanelDocumentHtml = forwardRef<HtmlDocumentController, Props>(function WorkPanelDocumentHtml({
  ownerChatId, rendererGeneration, document, active, preloadUrl, onHandoff,
}, ref) {
  const { t } = useI18n();
  const [modal, modalContext] = Modal.useModal();
  const frameRef = useRef<Electron.WebviewTag | null>(null);
  const readyRef = useRef(false);
  const refreshRequestRef = useRef(0);
  const [preview, setPreview] = useState<WorkPanelDocumentHtmlPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<HtmlAnnotation[]>([]);
  const [annotationListOpen, setAnnotationListOpen] = useState(false);
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingHtmlAnnotation | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [error, setError] = useState("");
  const sendReview = useCallback((data: unknown) => {
    if (!readyRef.current) return;
    try { frameRef.current?.send(WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, data); } catch { /* guest closed */ }
  }, []);
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
      const result = await window.electronAPI.chatWorkPanel.documentHtml.preview(handleRequest);
      if (requestId !== refreshRequestRef.current) return;
      if (!result.ok || !result.url || !result.partition) {
        setError(result.message || t("chatWorkPanel.document.htmlReadFailed"));
        setLoading(false);
        return;
      }
      setPreview(result);
      setAnnotations((current) => current.map((item) => ({ ...item, valid: false })));
      if (frameRef.current) {
        readyRef.current = false;
        frameRef.current.reload();
      }

    } catch {
      if (requestId === refreshRequestRef.current) {
        setError(t("chatWorkPanel.document.htmlReadFailed"));
        setLoading(false);
      }
    }
  }, [handleRequest, t]);

  useEffect(() => {
    setPreview(null);
    readyRef.current = false;
    setAnnotating(false);
    setAnnotations([]);
    setAnnotationListOpen(false);
    setPendingAnnotation(null);
    setPendingNote("");
    void refreshPreview();
    return () => { refreshRequestRef.current += 1; };
  }, [refreshPreview]);

  const revisionRef = useRef(document.revision);
  useEffect(() => {
    if (revisionRef.current === document.revision) return;
    revisionRef.current = document.revision;
    void refreshPreview();
  }, [document.revision, refreshPreview]);

  useEffect(() => {
    if (active) sendReview({ type: "resize" });
  }, [active, sendReview]);

  useEffect(() => {
    sendReview({ type: "zenmind-html-annotation-mode", enabled: annotating });
  }, [annotating, sendReview]);

  useEffect(() => {
    sendReview({
      type: "zenmind-html-annotation-locate",
      items: annotations.slice(0, 64).map(({ id, selector }, index) => ({
        id,
        selector,
        number: index + 1,
      })),
    });
  }, [annotations, sendReview]);

  useEffect(() => {
    const guest = frameRef.current;
    if (!guest) return;
    const listener = (message: Electron.IpcMessageEvent) => {
      if (message.channel !== WORK_PANEL_DOCUMENT_HTML_REVIEW_EVENT || !message.args[0]) return;
      const event = { data: message.args[0] };
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
        setAnnotations((current) => {
          let changed = false;
          const next = current.map((annotation) => {
            const located = locatedById.get(annotation.id);
            if (!located) return annotation;
            const updated = {
              ...annotation,
              valid: located.valid,
              text: located.text ?? annotation.text,
              rect: located.rect ?? annotation.rect,
            };
            if (JSON.stringify(updated) === JSON.stringify(annotation)) return annotation;
            changed = true;
            return updated;
          });
          return changed ? next : current;
        });
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
      if (!selector || !xpath || pendingAnnotation || annotations.length >= 64) return;
      setPendingAnnotation({
        selector, xpath, text, rect, valid: true,
      });
      setPendingNote("");
    };
    const ready = () => {
      readyRef.current = true;
      setLoading(false);
      setError("");
      sendReview({ type: "zenmind-html-annotation-mode", enabled: annotating });
      sendReview({ type: "zenmind-html-annotation-locate", items: annotations.slice(0, 64).map(({ id, selector }, index) => ({ id, selector, number: index + 1 })) });
      if (active) sendReview({ type: "resize" });
    };
    const failed = (event: Electron.DidFailLoadEvent) => {
      if (!event.isMainFrame || event.errorCode === -3) return;
      readyRef.current = false;
      setLoading(false);
      setError(t("chatWorkPanel.document.htmlReadFailed"));
    };
    const gone = () => { readyRef.current = false; setLoading(false); setError(t("chatWorkPanel.document.htmlReadFailed")); };
    guest.addEventListener("ipc-message", listener);
    guest.addEventListener("dom-ready", ready);
    guest.addEventListener("did-fail-load", failed);
    guest.addEventListener("render-process-gone", gone);
    return () => {
      guest.removeEventListener("ipc-message", listener);
      guest.removeEventListener("dom-ready", ready);
      guest.removeEventListener("did-fail-load", failed);
      guest.removeEventListener("render-process-gone", gone);
    };
  }, [preview?.url, preloadUrl, pendingAnnotation, annotating, annotations, active, sendReview, t]);

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
    const reload = () => {
      setAnnotationListOpen(false);
      cancelPendingAnnotation();
      return refreshPreview();
    };
    if (annotations.length || pendingAnnotation) {
      modal.confirm({ title: t("common.refresh"), content: t("chatWorkPanel.document.htmlReloadConfirm"),
        okText: t("common.confirm"), cancelText: t("common.cancel"), onOk: reload });
    } else void reload();
  };

  useImperativeHandle(ref, () => ({
    reload: refreshCurrentPreview,
    toggleReview: () => { if (!loading && !error) setAnnotating((current) => !current); },
    isAnnotating: () => annotating,
  }));

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
      data-work-panel-document-dirty={annotations.length > 0 || pendingAnnotation ? "true" : "false"}
    >
      {modalContext}
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
        {preview?.url && preview.partition && preloadUrl ? (
          <webview
            ref={frameRef}
            title={document.fileName}
            src={preview.url}
            partition={preview.partition}
            preload={preloadUrl}
            webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes"
          />
        ) : null}
        {loading || error ? (
          <div className={`work-panel-document-html-status${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
            {error || t("common.loading")}
          </div>
        ) : null}

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
});
