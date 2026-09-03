import { ArrowLeftOutlined, EditOutlined, LinkOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "antd";
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

function annotatedHtml(source: string, token: string) {
  const injectedBootstrap = `<script>(function(){
    var TOKEN='${token}';
    var ROOT_ID='__zenmind_native_html_review_overlay__';
    var enabled=false;
    var hoverBox=null;
    var markerItems=[];
    var previousCursor='';
    var renderFrame=0;
    function root(){
      var existing=document.getElementById(ROOT_ID);
      if(existing)return existing;
      var value=document.createElement('div');
      value.id=ROOT_ID;
      Object.assign(value.style,{position:'fixed',inset:'0',zIndex:'2147483646',pointerEvents:'none',overflow:'visible'});
      (document.body||document.documentElement).appendChild(value);
      return value;
    }
    function createBox(rect,label,dashed){
      var box=document.createElement('div');
      box.dataset.zenmindReviewBox='true';
      Object.assign(box.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:Math.max(0,rect.width)+'px',height:Math.max(0,rect.height)+'px',boxSizing:'border-box',border:'2px '+(dashed?'dashed':'solid')+' #ff4d4f',background:dashed?'rgba(255,77,79,.08)':'rgba(255,77,79,.05)',pointerEvents:'none'});
      if(label){
        var badge=document.createElement('span');
        badge.textContent=String(label);
        Object.assign(badge.style,{position:'absolute',top:'-11px',left:'-11px',display:'grid',placeItems:'center',width:'22px',height:'22px',borderRadius:'999px',background:'#ff4d4f',color:'#fff',fontSize:'11px',fontWeight:'700',lineHeight:'1',boxShadow:'0 2px 8px rgba(0,0,0,.24)'});
        box.appendChild(badge);
      }
      return box;
    }
    function removeMarkerBoxes(){
      var value=document.getElementById(ROOT_ID);
      if(!value)return;
      Array.from(value.querySelectorAll('[data-zenmind-review-marker]')).forEach(function(node){node.remove();});
    }
    function query(selector){
      try{return selector?document.querySelector(selector):null;}catch(_error){return null;}
    }
    function renderMarkers(){
      removeMarkerBoxes();
      if(!enabled)return;
      var value=root();
      markerItems.forEach(function(item,index){
        var element=query(item.selector);
        if(!(element instanceof Element))return;
        var rect=element.getBoundingClientRect();
        if(rect.width<=0||rect.height<=0)return;
        var box=createBox(rect,item.number||index+1,false);
        box.dataset.zenmindReviewMarker='true';
        value.appendChild(box);
      });
    }
    function scheduleRender(){
      if(renderFrame)return;
      renderFrame=window.requestAnimationFrame(function(){renderFrame=0;renderMarkers();});
    }
    function targetAtPoint(x,y){
      var elements=document.elementsFromPoint(x,y);
      return elements.find(function(element){return !element.closest('#'+ROOT_ID);})||null;
    }
    function cssPath(element){
      var parts=[];
      var current=element;
      while(current&&current.nodeType===1){
        if(current.id&&window.CSS&&typeof window.CSS.escape==='function'){
          parts.unshift('#'+window.CSS.escape(current.id));
          break;
        }
        var part=current.tagName.toLowerCase();
        var owner=current.parentElement;
        if(owner){
          var same=Array.from(owner.children).filter(function(candidate){return candidate.tagName===current.tagName;});
          if(same.length>1)part+=':nth-of-type('+(same.indexOf(current)+1)+')';
        }
        parts.unshift(part);
        current=owner;
      }
      return parts.join(' > ');
    }
    function fullXPath(element){
      var parts=[];
      var current=element;
      while(current&&current.nodeType===1){
        var name=current.tagName.toLowerCase();
        if(name==='html'){parts.unshift('html');break;}
        var owner=current.parentElement;
        if(!owner)return '';
        var same=Array.from(owner.children).filter(function(candidate){return candidate.tagName===current.tagName;});
        parts.unshift(name+'['+(same.indexOf(current)+1)+']');
        current=owner;
      }
      return '/'+parts.join('/');
    }
    function textExcerpt(element){return (element.textContent||'').replace(/\\s+/g,' ').trim().slice(0,240);}
    function setEnabled(next){
      if(next===enabled)return;
      enabled=next;
      if(enabled){
        previousCursor=document.documentElement.style.cursor;
        document.documentElement.style.cursor='crosshair';
        renderMarkers();
      }else{
        document.documentElement.style.cursor=previousCursor;
        hoverBox&&hoverBox.remove();
        hoverBox=null;
        removeMarkerBoxes();
      }
    }
    window.addEventListener('message',function(event){
      var data=event.data;
      if(!data||data.token!==TOKEN)return;
      if(data.type==='zenmind-html-annotation-mode'){
        setEnabled(!!data.enabled);
        return;
      }
      if(data.type!=='zenmind-html-annotation-locate'||!Array.isArray(data.items))return;
      markerItems=data.items.slice(0,64).map(function(item,index){return{id:typeof item.id==='string'?item.id.slice(0,128):'',selector:typeof item.selector==='string'?item.selector.slice(0,512):'',number:Number.isSafeInteger(item.number)&&item.number>0?item.number:index+1};});
      renderMarkers();
      var results=markerItems.map(function(item){
        var element=query(item.selector);
        if(!(element instanceof Element))return{id:item.id,valid:false};
        var rect=element.getBoundingClientRect();
        return{id:item.id,valid:rect.width>0&&rect.height>0,text:textExcerpt(element),rect:{x:rect.left+window.scrollX,y:rect.top+window.scrollY,width:rect.width,height:rect.height}};
      });
      parent.postMessage({type:'zenmind-html-annotation-located',token:TOKEN,items:results},'*');
    });
    document.addEventListener('pointermove',function(event){
      if(!enabled)return;
      var element=targetAtPoint(event.clientX,event.clientY);
      hoverBox&&hoverBox.remove();
      hoverBox=null;
      if(!(element instanceof Element))return;
      var rect=element.getBoundingClientRect();
      if(rect.width<=0||rect.height<=0)return;
      hoverBox=createBox(rect,0,true);
      root().appendChild(hoverBox);
    },true);
    document.addEventListener('pointerdown',function(event){
      if(!enabled||event.button!==0)return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },true);
    document.addEventListener('pointerup',function(event){
      if(!enabled||event.button!==0)return;
      var element=targetAtPoint(event.clientX,event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
      if(!(element instanceof Element))return;
      var selector=cssPath(element);
      var xpath=fullXPath(element);
      var rect=element.getBoundingClientRect();
      if(!selector||!xpath||rect.width<=0||rect.height<=0)return;
      parent.postMessage({type:'zenmind-html-annotation',token:TOKEN,selector:selector,xpath:xpath,text:textExcerpt(element),rect:{x:rect.left+window.scrollX,y:rect.top+window.scrollY,width:rect.width,height:rect.height}},'*');
    },true);
    document.addEventListener('click',function(event){if(enabled){event.preventDefault();event.stopImmediatePropagation();}},true);
    document.addEventListener('submit',function(event){if(enabled){event.preventDefault();event.stopImmediatePropagation();}},true);
    window.addEventListener('resize',scheduleRender);
    window.addEventListener('scroll',scheduleRender,true);
  })();</script>`;
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
  const [previewSource, setPreviewSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<HtmlAnnotation[]>([]);
  const [error, setError] = useState("");
  const token = useMemo(() => globalThis.crypto.randomUUID().replace(/-/gu, ""), [document.handleId]);
  const displayUrl = document.displayUrl || `${document.sourceKind}:///${document.fileName}`;
  const handleRequest = useMemo(() => ({
    ownerChatId,
    rendererGeneration,
    handleId: document.handleId,
  }), [document.handleId, ownerChatId, rendererGeneration]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    setPreviewSource("");
    setAnnotating(false);
    setAnnotations([]);
    void (async () => {
      try {
        const result = await window.electronAPI.chatWorkPanel.documentHtml.read(handleRequest);
        if (disposed) return;
        if (!result.ok || result.text === undefined) {
          setError(result.message || t("chatWorkPanel.document.htmlReadFailed"));
          return;
        }
        const previewResult = await window.electronAPI.chatWorkPanel.documentHtml.preview({
          ...handleRequest,
          text: result.text,
        });
        if (disposed) return;
        setPreviewSource(previewResult.ok && previewResult.text !== undefined
          ? previewResult.text
          : result.text);
      } catch {
        if (!disposed) setError(t("chatWorkPanel.document.htmlReadFailed"));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, [document.revision, handleRequest]);

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
      if (!selector || !xpath) return;
      setAnnotations((current) => [...current, {
        id: globalThis.crypto.randomUUID(), selector, xpath, text, note: "", rect, valid: true,
      }]);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [token]);

  return (
    <div
      className={`work-panel-document-html${annotating ? " is-annotating" : ""}`}
      data-work-panel-document-dirty={annotations.length > 0 ? "true" : "false"}
    >
      <div className="work-panel-document-html-toolbar" role="toolbar" aria-label={t("chatWorkPanel.review.htmlTool")}>
        {annotating ? (
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => setAnnotating(false)}>
              {t("chatWorkPanel.image.done")}
            </Button>
            <span className="work-panel-document-html-hint">{t("chatWorkPanel.review.htmlHint")}</span>
            <span className="work-panel-document-html-count">
              {t("chatWorkPanel.review.annotationCount", { count: annotations.length })}
            </span>
          </>
        ) : (
          <>
            <div className="work-panel-document-html-location" title={displayUrl}>
              <LinkOutlined aria-hidden="true" />
              <span>{displayUrl}</span>
            </div>
            <Button
              icon={<EditOutlined />}
              disabled={loading || Boolean(error)}
              onClick={() => setAnnotating(true)}
            >
              {t("chatWorkPanel.review.panel")}
            </Button>
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
      {annotating && annotations.length ? (
        <div className="work-panel-document-html-annotations">
          {annotations.map((annotation, index) => (
            <div className="work-panel-document-html-annotation" key={annotation.id}>
              <code className={annotation.valid ? "" : "is-invalid"}>
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
          <div className="work-panel-document-html-annotation-actions">
            <Button
              type="primary"
              disabled={!annotations.some((annotation) => annotation.valid && annotation.note.trim())}
              onClick={() => void onHandoff(annotations.filter((annotation) => annotation.valid)).then((ok) => {
                if (ok) {
                  setAnnotations([]);
                  setAnnotating(false);
                }
              })}
            >
              {t("chatWorkPanel.document.handoff")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
