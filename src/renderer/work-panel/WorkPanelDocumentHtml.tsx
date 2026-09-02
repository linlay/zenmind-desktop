import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Segmented, Space } from "antd";
import type { WorkPanelDocumentHtmlSelection } from "../../shared/work-panel-document-html";
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

type ViewMode = "source" | "preview" | "split";

function annotatedHtml(source: string, token: string) {
  const bootstrap = `<script>(function(){var enabled=false;function cssPath(el){var parts=[];while(el&&el.nodeType===1){if(el.id){parts.unshift('#'+CSS.escape(el.id));break;}var part=el.tagName.toLowerCase();var parent=el.parentElement;if(parent){var same=Array.from(parent.children).filter(function(x){return x.tagName===el.tagName});if(same.length>1)part+=':nth-of-type('+(same.indexOf(el)+1)+')';}parts.unshift(part);el=parent;}return parts.join(' > ');}function xpath(el){var parts=[];while(el&&el.nodeType===1){var name=el.tagName.toLowerCase();var index=1;var sibling=el.previousElementSibling;while(sibling){if(sibling.tagName===el.tagName)index++;sibling=sibling.previousElementSibling;}parts.unshift(name+'['+index+']');el=el.parentElement;}return '/'+parts.join('/');}window.addEventListener('message',function(e){if(e.data&&e.data.type==='zenmind-html-annotation-mode'&&e.data.token==='${token}')enabled=!!e.data.enabled;});document.addEventListener('click',function(e){if(!enabled)return;var el=e.target;if(!(el instanceof Element))return;e.preventDefault();e.stopPropagation();var r=el.getBoundingClientRect();parent.postMessage({type:'zenmind-html-annotation',token:'${token}',selector:cssPath(el),xpath:xpath(el),text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,240),rect:{x:r.x,y:r.y,width:r.width,height:r.height}},'*');},true);})();</script>`;
  const relocationBootstrap = `<script>(function(){window.addEventListener('message',function(e){var data=e.data;if(!data||data.type!=='zenmind-html-annotation-locate'||data.token!=='${token}'||!Array.isArray(data.items))return;var results=data.items.slice(0,64).map(function(item){var id=typeof item.id==='string'?item.id.slice(0,128):'';var selector=typeof item.selector==='string'?item.selector.slice(0,512):'';var el=null;try{if(selector)el=document.querySelector(selector);}catch(_error){}if(!(el instanceof Element))return{id:id,valid:false};var r=el.getBoundingClientRect();return{id:id,valid:true,text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,240),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};});parent.postMessage({type:'zenmind-html-annotation-located',token:'${token}',items:results},'*');});})();</script>`;
  const injectedBootstrap = `${bootstrap}${relocationBootstrap}`;
  return source.includes("<head")
    ? source.replace(/<head([^>]*)>/iu, `<head$1>${injectedBootstrap}`)
    : `${injectedBootstrap}${source}`;
}

export function WorkPanelDocumentHtml({
  ownerChatId,
  rendererGeneration,
  document,
  onCommitted,
  onHandoff,
}: {
  ownerChatId: string;
  rendererGeneration: string;
  document: WorkPanelDocumentHtmlSelection;
  onCommitted(document: WorkPanelDocumentHtmlSelection): void;
  onHandoff(annotations: HtmlAnnotation[]): Promise<boolean>;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [source, setSource] = useState("");
  const [previewSource, setPreviewSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [revision, setRevision] = useState(document.revision);
  const [mode, setMode] = useState<ViewMode>("split");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<HtmlAnnotation[]>([]);
  const [error, setError] = useState("");
  const token = useMemo(() => globalThis.crypto.randomUUID().replace(/-/gu, ""), [document.handleId]);
  const dirty = source !== savedSource;
  const handleRequest = useMemo(() => ({
    ownerChatId,
    rendererGeneration,
    handleId: document.handleId,
  }), [document.handleId, ownerChatId, rendererGeneration]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    void window.electronAPI.chatWorkPanel.documentHtml.read(handleRequest).then((result) => {
      if (disposed) return;
      if (!result.ok || result.text === undefined) {
        setError(result.message || t("chatWorkPanel.document.htmlReadFailed"));
        return;
      }
      setSource(result.text);
      setSavedSource(result.text);
      setRevision(result.revision || document.revision);
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [document.revision, handleRequest]);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void window.electronAPI.chatWorkPanel.documentHtml.preview({
        ...handleRequest,
        text: source,
      }).then((result) => {
        if (!disposed) setPreviewSource(result.ok && result.text !== undefined ? result.text : source);
      });
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [handleRequest, source]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "zenmind-html-annotation-mode",
      token,
      enabled: annotating,
    }, "*");
  }, [annotating, mode, source, token]);

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
      if (!selector || !xpath) return;
      setAnnotations((current) => [...current, {
        id: globalThis.crypto.randomUUID(), selector, xpath, text, note: "", rect, valid: true,
      }]);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [token]);

  const save = async (saveMode: "overwrite" | "new-artifact") => {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await window.electronAPI.chatWorkPanel.documentHtml.commit({
        ...handleRequest,
        mode: saveMode,
        expectedRevision: revision,
        text: source,
      });
      if (!result.ok) {
        setError(result.message || (result.conflict
          ? t("chatWorkPanel.document.revisionConflict")
          : t("chatWorkPanel.document.saveFailed")));
        return;
      }
      if (result.document) {
        if (result.created) {
          // The edited bytes now belong to a new Artifact and a new stable Tab.
          // Restore this source Tab to its original clean contents before opening it.
          setSource(savedSource);
          setAnnotations([]);
        } else {
          setSavedSource(source);
          setRevision(result.document.revision);
        }
        onCommitted(result.document);
      }
    } finally {
      setSaving(false);
    }
  };

  const preview = (
    <iframe
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
            items: annotations.slice(0, 64).map(({ id, selector }) => ({ id, selector })),
          }, "*");
        }
      }}
      style={{ width: "100%", height: "100%", border: 0, background: "white" }}
    />
  );

  return (
    <div
      className="work-panel-document-html"
      data-work-panel-document-dirty={dirty ? "true" : "false"}
      data-work-panel-document-busy={saving ? "true" : "false"}
      style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", padding: 8, borderBottom: "1px solid var(--border-color)" }}>
        <Space>
          <Segmented<ViewMode>
            value={mode}
            options={[
              { value: "source", label: t("chatWorkPanel.document.source") },
              { value: "preview", label: t("chatWorkPanel.document.preview") },
              { value: "split", label: t("chatWorkPanel.document.split") },
            ]}
            onChange={setMode}
          />
          <Button type={annotating ? "primary" : "default"} onClick={() => setAnnotating((value) => !value)}>
            {annotating
              ? t("chatWorkPanel.document.finishAnnotation")
              : t("chatWorkPanel.document.annotateDom")}
          </Button>
        </Space>
        <Space>
          {document.sourceKind === "artifact" ? (
            <Button disabled={!dirty || saving} onClick={() => void save("overwrite")}>
              {t("chatWorkPanel.document.overwriteArtifact")}
            </Button>
          ) : null}
          <Button
            type="primary"
            loading={saving}
            disabled={!dirty || saving}
            onClick={() => void save(document.sourceKind === "workspace-file" ? "overwrite" : "new-artifact")}
          >
            {document.sourceKind === "workspace-file"
              ? t("chatWorkPanel.document.save")
              : t("chatWorkPanel.document.saveNewArtifact")}
          </Button>
        </Space>
      </div>
      {error ? <div role="alert" style={{ color: "#cf1322", padding: "6px 10px" }}>{error}</div> : null}
      {loading ? <div style={{ padding: 16 }}>{t("common.loading")}</div> : (
        <div style={{ display: "grid", gridTemplateColumns: mode === "split" ? "1fr 1fr" : "1fr", flex: 1, minHeight: 0 }}>
          {mode !== "preview" ? (
            <Input.TextArea
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setAnnotations((current) => current.map((annotation) => ({
                  ...annotation,
                  valid: false,
                })));
              }}
              spellCheck={false}
              style={{ resize: "none", border: 0, borderRadius: 0, minHeight: 0, fontFamily: "var(--font-mono)" }}
            />
          ) : null}
          {mode !== "source" ? <div style={{ minHeight: 0, borderLeft: mode === "split" ? "1px solid var(--border-color)" : 0 }}>{preview}</div> : null}
        </div>
      )}
      {annotations.length ? (
        <div style={{ maxHeight: 180, overflow: "auto", borderTop: "1px solid var(--border-color)", padding: 8 }}>
          {annotations.map((annotation, index) => (
            <div key={annotation.id} style={{ display: "grid", gridTemplateColumns: "160px 1fr auto", gap: 8, marginBottom: 6 }}>
              <code style={{ color: annotation.valid ? undefined : "#cf1322" }}>
                {annotation.selector}{annotation.valid ? "" : ` (${t("chatWorkPanel.document.invalidAnnotation")})`}
              </code>
              <Input
                value={annotation.note}
                disabled={!annotation.valid}
                placeholder={annotation.text || t("chatWorkPanel.document.annotationNumber", { number: index + 1 })}
                onChange={(event) => setAnnotations((current) => current.map((item) =>
                  item.id === annotation.id ? { ...item, note: event.target.value } : item))}
              />
              <Button danger onClick={() => setAnnotations((current) => current.filter((item) => item.id !== annotation.id))}>
                {t("chatWorkPanel.document.removeAnnotation")}
              </Button>
            </div>
          ))}
          <Button
            type="primary"
            disabled={!annotations.some((annotation) => annotation.valid && annotation.note.trim())}
            onClick={() => void onHandoff(annotations.filter((annotation) => annotation.valid)).then((ok) => { if (ok) setAnnotations([]); })}
          >
            {t("chatWorkPanel.document.handoff")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
