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
import {
  EXTRACT_STRUCTURED_SCRIPT,
  READ_PAGE_DATA_SCRIPT,
  buildInteractElementScript,
  type EmbeddedWebInteractAction,
  type EmbeddedWebReadInclude,
  type EmbeddedWebStructuredTarget
} from "../../shared/embedded-web-scripts";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";

type PluginPageProps = {
  hostTheme: "light" | "dark";
  pluginId?: string;
  active?: boolean;
  embedPath?: string;
  surfaceLabel?: string;
  skipContextRegistration?: boolean;
};

const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "zenmind:agent-app-clipboard:request";
const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "zenmind:agent-app-clipboard:response";
const MAX_PLUGIN_PAGE_CONTEXT_HEADINGS = 24;
const MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT = 40000;
const EMBEDDED_WEB_SCRIPT_MAX_BYTES = 256 * 1024;
const EMBEDDED_WEB_READ_INCLUDES = new Set<EmbeddedWebReadInclude>(["forms", "links", "images"]);
const EMBEDDED_WEB_STRUCTURED_TARGETS = new Set<EmbeddedWebStructuredTarget>(["tables", "lists", "forms", "links"]);
const EMBEDDED_WEB_INTERACT_ACTIONS = new Set<EmbeddedWebInteractAction>(["click", "fill", "scroll", "focus", "select"]);

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function readAllowedValues<T extends string>(
  value: unknown,
  allowedValues: Set<T>
) {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return rawValues
    .map((item) => String(item).trim())
    .filter((item): item is T => allowedValues.has(item as T));
}

function filterReadPageDataResult(result: unknown, includes: EmbeddedWebReadInclude[]) {
  if (!result || typeof result !== "object" || includes.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  if (!includes.includes("forms")) {
    delete filtered.forms;
    delete filtered.fields;
  }
  if (!includes.includes("links")) {
    delete filtered.links;
  }
  if (!includes.includes("images")) {
    delete filtered.images;
  }
  return filtered;
}

function filterStructuredResult(result: unknown, targets: EmbeddedWebStructuredTarget[]) {
  if (!result || typeof result !== "object" || targets.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  const keys: EmbeddedWebStructuredTarget[] = ["tables", "lists", "forms", "links"];
  for (const key of keys) {
    if (!targets.includes(key)) {
      delete filtered[key];
    }
  }
  return filtered;
}

function buildPluginIframeFallbackContext(
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string,
  surfaceId: string,
  surfaceLabel: string
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
      "可通过 desktop.embeddedWeb.* 工具实时读取或操作这个 iframe 页面。"
    ].join(" "),
    browserTarget: fallbackUrl
      ? {
          kind: "iframe",
          frameMatchUrl: fallbackUrl,
          surfaceId,
          surfaceLabel,
          currentUrl: fallbackUrl
        }
      : undefined
  };
}

function tryReadPluginIframePageContext(
  iframe: HTMLIFrameElement | null,
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string,
  surfaceId: string,
  surfaceLabel: string
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
      bodyText,
      browserTarget: {
        kind: "iframe",
        frameMatchUrl: embeddedUrl || frameLocation.href || webUrl,
        surfaceId,
        surfaceLabel,
        currentUrl: frameLocation.href || embeddedUrl || webUrl
      }
    };
  } catch {
    return null;
  }
}

export function PluginPage({
  hostTheme,
  pluginId: pluginIdProp,
  active,
  embedPath,
  surfaceLabel,
  skipContextRegistration
}: PluginPageProps) {
  const { pluginId: routePluginId } = useParams<{ pluginId: string }>();
  const pluginId = pluginIdProp ?? routePluginId ?? "";
  const { services, refresh: refreshServices } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const agentPlatformService = service?.id === "agent-webclient"
    ? services.find((s) => s.id === "agent-platform")
    : null;
  const serviceDisplayName = surfaceLabel || (service ? getServiceDisplayName(service.id, service.name) : "");
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
      embedPath: service?.id === "agent-webclient" ? embedPath : undefined,
      baseUrl: service?.healthMeta.port ? `http://127.0.0.1:${service.healthMeta.port}` : undefined
    });
  }, [embedPath, hostTheme, iframeReloadKey, service?.healthMeta.port, service?.id, webUrl]);
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
    if (active === false || service?.status !== "running" || skipContextRegistration) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      const iframeContext = tryReadPluginIframePageContext(
        iframeRef.current,
        serviceDisplayName,
        embeddedUrl,
        webUrl,
        pluginId,
        serviceDisplayName
      );
      if (iframeContext) {
        return iframeContext;
      }

      return buildPluginIframeFallbackContext(serviceDisplayName, embeddedUrl, webUrl, pluginId, serviceDisplayName);
    });
  }, [active, embeddedUrl, pluginId, service?.status, serviceDisplayName, skipContextRegistration, webUrl]);

  useEffect(() => {
    if (active === false || service?.status !== "running" || !embeddedUrl || skipContextRegistration) {
      return undefined;
    }

    function embeddedError(code: string, message: string, details?: unknown) {
      return {
        ok: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(targetSurfaceId && targetSurfaceId !== pluginId);
    }

    async function readPluginPageContext() {
      return tryReadPluginIframePageContext(
        iframeRef.current,
        serviceDisplayName,
        embeddedUrl,
        webUrl,
        pluginId,
        serviceDisplayName
      ) ?? buildPluginIframeFallbackContext(serviceDisplayName, embeddedUrl, webUrl, pluginId, serviceDisplayName);
    }

    async function executeFrameScript(args: Record<string, unknown>, script: string) {
      if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
        return embeddedError("script_too_large", "脚本超过内嵌网页执行大小限制。");
      }
      const result = await window.electronAPI.embeddedWeb.executeInFrame({
        frameMatchUrl: embeddedUrl,
        script
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error ?? {
            code: "iframe_execution_failed",
            message: "主进程未能执行 iframe 脚本。"
          }
        };
      }
      return { ok: true, result: result.result };
    }

    return registerDesktopActionProviderForScope("embeddedWeb", async (request) => {
      if (active === false || service?.status !== "running") {
        return null;
      }
      const args = request.args ?? {};
      if (requestTargetsDifferentSurface(args)) {
        return null;
      }

      switch (request.action) {
        case "desktop.embeddedWeb.getActiveSurface":
          return {
            ok: true,
            result: {
              surface: {
                id: pluginId,
                label: serviceDisplayName,
                url: embeddedUrl,
                active: active !== false,
                currentUrl: embeddedUrl,
                title: serviceDisplayName,
                frameMatchUrl: embeddedUrl
              },
              tabs: [],
              activeTab: null
            }
          };
        case "desktop.embeddedWeb.getPageContext":
          return { ok: true, result: await readPluginPageContext() };
        case "desktop.embeddedWeb.readPageData": {
          const response = await executeFrameScript(args, READ_PAGE_DATA_SCRIPT);
          if (!response.ok) {
            return response;
          }
          return {
            ok: true,
            result: filterReadPageDataResult(
              response.result,
              readAllowedValues(args.include, EMBEDDED_WEB_READ_INCLUDES)
            )
          };
        }
        case "desktop.embeddedWeb.extractStructured": {
          const response = await executeFrameScript(args, EXTRACT_STRUCTURED_SCRIPT);
          if (!response.ok) {
            return response;
          }
          return {
            ok: true,
            result: filterStructuredResult(
              response.result,
              readAllowedValues(args.targets, EMBEDDED_WEB_STRUCTURED_TARGETS)
            )
          };
        }
        case "desktop.embeddedWeb.interactElement": {
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          const action = typeof args.action === "string" ? args.action.trim() : "";
          if (!selector || !EMBEDDED_WEB_INTERACT_ACTIONS.has(action as EmbeddedWebInteractAction)) {
            return embeddedError("invalid_args", "selector 和有效的 action 是必填项。", args);
          }
          return executeFrameScript(args, buildInteractElementScript({
            selector,
            action: action as EmbeddedWebInteractAction,
            value: typeof args.value === "string" ? args.value : args.value == null ? undefined : String(args.value)
          }));
        }
        case "desktop.embeddedWeb.executeScript": {
          const script = typeof args.script === "string" ? args.script : "";
          if (!script.trim()) {
            return embeddedError("invalid_script", "script 是必填项。");
          }
          return executeFrameScript(args, script);
        }
        default:
          return null;
      }
    });
  }, [active, embeddedUrl, pluginId, service?.status, serviceDisplayName, skipContextRegistration, webUrl]);

  if (!service) {
    if (pluginId === "agent-webclient") {
      return (
        <section className="empty-state" {...surfaceVisibilityProps}>
          <h1>智能助理服务未注册</h1>
          <p>未找到 agent-webclient 内置服务。请确认 Desktop 已同步完整内置资源，或在控制中心安装 agent-webclient 发布包。</p>
          <Link className="primary-link" to="/control-center">
            前往控制中心
          </Link>
        </section>
      );
    }

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
