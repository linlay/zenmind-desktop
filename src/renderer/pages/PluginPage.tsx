import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { registerAssistantPageContextProvider } from "../services/assistantPageContext";
import {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol,
} from "../../shared/auth-bridge";
import { getServiceDisplayName } from "../service-display";
import type { AssistantPageContext } from "../../shared/contracts";

type PluginPageProps = {
  hostTheme: "light" | "dark";
  pluginId?: string;
  active?: boolean;
};

const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "zenmind:agent-app-clipboard:request";
const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "zenmind:agent-app-clipboard:response";
const MAX_PLUGIN_PAGE_CONTEXT_HEADINGS = 24;
const MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT = 40000;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function buildPluginIframeFallbackContext(
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string
): AssistantPageContext {
  const normalizedName = normalizeWhitespace(serviceDisplayName || "内嵌应用");
  const fallbackUrl = embeddedUrl || webUrl || window.location.href;
  return {
    url: fallbackUrl,
    title: normalizedName || "内嵌应用",
    selectedText: "",
    metaDescription: "",
    headings: [],
    bodyText: [
      `当前左侧区域是内嵌应用「${normalizedName || "内嵌应用"}」。`,
      "宿主当前无法直接读取这个 iframe 内部的列表、卡片或正文文本。",
      "如果用户追问左侧区域里具体有什么，请明确说明当前看不到其内部细节，不要猜测网站、应用名称或列表项。"
    ].join(" ")
  };
}

function tryReadPluginIframePageContext(
  iframe: HTMLIFrameElement | null,
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string
): AssistantPageContext | null {
  const frameWindow = iframe?.contentWindow;
  if (!frameWindow) {
    return null;
  }

  try {
    const frameDocument = frameWindow.document;
    const frameLocation = frameWindow.location;
    const title = normalizeWhitespace(frameDocument.title || serviceDisplayName || "内嵌应用");
    const selectedText = normalizeWhitespace(frameWindow.getSelection?.()?.toString() ?? "");
    const metaDescription = normalizeWhitespace(
      frameDocument.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""
    );
    const headings = Array.from(frameDocument.querySelectorAll("h1, h2, h3"))
      .map((heading) => normalizeWhitespace(heading.textContent ?? ""))
      .filter(Boolean)
      .slice(0, MAX_PLUGIN_PAGE_CONTEXT_HEADINGS);
    const bodyText = normalizeWhitespace(frameDocument.body?.innerText || frameDocument.body?.textContent || "")
      .slice(0, MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT);

    return {
      url: frameLocation.href || embeddedUrl || webUrl || window.location.href,
      title,
      selectedText,
      metaDescription,
      headings,
      bodyText
    };
  } catch {
    return null;
  }
}

export function PluginPage({ hostTheme, pluginId: pluginIdProp, active }: PluginPageProps) {
  const { pluginId: routePluginId } = useParams<{ pluginId: string }>();
  const pluginId = pluginIdProp ?? routePluginId ?? "";
  const { services, refresh: refreshServices } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const agentPlatformService = service?.id === "agent-webclient"
    ? services.find((s) => s.id === "agent-platform")
    : null;
  const serviceDisplayName = service ? getServiceDisplayName(service.id, service.name) : "";
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [iframeRetryNonce, setIframeRetryNonce] = useState(0);
  const [iframeLoadError, setIframeLoadError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const surfaceVisibilityProps = active === undefined
    ? {}
    : {
        hidden: !active,
        "aria-hidden": !active
      };

  const webUrl = service?.healthMeta.webUrl ?? "";
  const bridgeProtocol = useMemo(
    () => getPluginAuthBridgeProtocol(service?.id),
    [service?.id],
  );
  const iframeReloadKey = [
    service?.healthMeta.pid ?? "",
    service?.id === "agent-webclient" ? agentPlatformService?.status ?? "" : "",
    service?.id === "agent-webclient" ? agentPlatformService?.healthMeta.pid ?? "" : ""
  ].join(":");
  const embeddedUrl = useMemo(() => {
    return buildPluginEmbeddedUrl(service?.id, webUrl, {
      hostTheme,
      desktopAuthContext: service?.id === "agent-webclient" ? iframeReloadKey : undefined,
      baseUrl: service?.healthMeta.port ? `http://127.0.0.1:${service.healthMeta.port}` : undefined
    });
  }, [hostTheme, iframeReloadKey, service?.healthMeta.port, service?.id, webUrl]);
  const iframeBaseKey = useMemo(
    () => [service?.id ?? "service", iframeReloadKey, embeddedUrl].join(":"),
    [embeddedUrl, iframeReloadKey, service?.id]
  );
  const iframeRenderKey = useMemo(
    () => [iframeBaseKey, iframeRetryNonce].join(":"),
    [iframeBaseKey, iframeRetryNonce]
  );

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

  useEffect(() => {
    setIframeRetryNonce(0);
    setIframeLoadError(false);
  }, [iframeBaseKey, service?.status]);

  useEffect(() => {
    setBridgeReady(false);

    if (!bridgeProtocol) {
      setBridgeReady(true);
      return;
    }

    const isMessageFromEmbeddedFrame = (event: MessageEvent) => {
      if (event.source === iframeRef.current?.contentWindow) {
        return true;
      }
      if (!embeddedUrl || !event.origin || event.origin === "null") {
        return false;
      }
      try {
        return event.origin === new URL(embeddedUrl).origin;
      } catch {
        return false;
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (!isMessageFromEmbeddedFrame(event)) {
        return;
      }

      const payload = event.data as {
        type?: string;
        requestId?: string;
        action?: string;
        reason?: "missing" | "unauthorized";
      } | null;
      if (
        !payload ||
        payload.type !== bridgeProtocol.requestType ||
        !payload.requestId
      ) {
        return;
      }
      if (
        payload.action !== "getAccessToken" &&
        payload.action !== "refreshAccessToken"
      ) {
        return;
      }

      window.electronAPI.agentAuth
        .issueAccessToken(
          payload.reason === "unauthorized" ? "unauthorized" : "missing",
        )
        .then((result) => {
          const targetOrigin =
            event.origin && event.origin !== "null" ? event.origin : "*";
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: bridgeProtocol.responseType,
              requestId: payload.requestId,
              token: result.ok ? result.token : null,
            },
            targetOrigin,
          );
          if (!result.ok) {
            setBridgeError(result.message);
          }
        })
        .catch((reason) => {
          setBridgeError(
            reason instanceof Error ? reason.message : String(reason),
          );
        });
    };

    const handleClipboardMessage = (event: MessageEvent) => {
      if (!isMessageFromEmbeddedFrame(event)) {
        return;
      }

      const payload = event.data as {
        type?: string;
        requestId?: string;
        text?: string;
      } | null;
      if (
        !payload ||
        payload.type !== AGENT_APP_CLIPBOARD_REQUEST_TYPE ||
        !payload.requestId
      ) {
        return;
      }

      void window.electronAPI.clipboard
        .writeText(typeof payload.text === "string" ? payload.text : "")
        .then((result) => {
          const targetOrigin =
            event.origin && event.origin !== "null" ? event.origin : "*";
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
              requestId: payload.requestId,
              ok: result.ok,
              message: result.message ?? ""
            },
            targetOrigin,
          );
        })
        .catch((reason) => {
          const targetOrigin =
            event.origin && event.origin !== "null" ? event.origin : "*";
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
              requestId: payload.requestId,
              ok: false,
              message: reason instanceof Error ? reason.message : String(reason)
            },
            targetOrigin,
          );
        });
    };

    window.addEventListener("message", handleMessage);
    window.addEventListener("message", handleClipboardMessage);
    setBridgeReady(true);
    return () => {
      setBridgeReady(false);
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("message", handleClipboardMessage);
    };
  }, [bridgeProtocol, embeddedUrl]);

  function frameLoadedChromeErrorPage() {
    try {
      return iframeRef.current?.contentWindow?.location.href.startsWith("chrome-error://") ?? false;
    } catch {
      return false;
    }
  }

  function handleIframeLoad() {
    if (!frameLoadedChromeErrorPage()) {
      setIframeLoadError(false);
      return;
    }

    setIframeLoadError(true);
    void refreshServices();
    if (iframeRetryNonce >= 2 || service?.status !== "running") {
      return;
    }

    window.setTimeout(() => {
      setIframeRetryNonce((current) => (current === iframeRetryNonce ? current + 1 : current));
    }, 450);
  }

  useEffect(() => {
    if (active === false || service?.status !== "running") {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      const iframeContext = tryReadPluginIframePageContext(
        iframeRef.current,
        serviceDisplayName,
        embeddedUrl,
        webUrl
      );
      if (iframeContext) {
        return iframeContext;
      }

      return buildPluginIframeFallbackContext(serviceDisplayName, embeddedUrl, webUrl);
    });
  }, [active, embeddedUrl, service?.status, serviceDisplayName, webUrl]);

  if (!service) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>服务未注册</h1>
        <p>未找到 ID 为 {pluginId} 的服务。</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  if (service.status !== "running") {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName} 暂未就绪</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to="/control-center">
          前往控制中心
        </Link>
      </section>
    );
  }

  if (service.frontendMode === "none" || !webUrl || !embeddedUrl) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>{serviceDisplayName}</h1>
        <p>该服务没有前端页面。</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  if (bridgeError) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName}</h1>
        <p>认证桥接失败：{bridgeError}</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  return (
    <section className="pan-page pan-page-embedded" {...surfaceVisibilityProps}>
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="pan-frame-shell">
        {bridgeReady ? (
          <>
            {iframeLoadError ? (
              <section className="empty-state embedded-plugin-error" aria-live="polite">
                <p className="eyebrow">PLUGIN</p>
                <h1>{serviceDisplayName}</h1>
                <p>智能助理服务正在恢复，页面会自动重新加载。</p>
              </section>
            ) : null}
            <iframe
              key={iframeRenderKey}
              ref={iframeRef}
              src={embeddedUrl}
              title={serviceDisplayName}
              className="pan-frame"
              onLoad={handleIframeLoad}
            />
          </>
        ) : (
          <section className="empty-state">
            <p className="eyebrow">PLUGIN</p>
            <h1>{serviceDisplayName}</h1>
            <p>正在准备认证上下文…</p>
          </section>
        )}
      </div>
    </section>
  );
}
