import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol,
} from "../../shared/auth-bridge";
import { getServiceDisplayName } from "../service-display";

type PluginPageProps = {
  hostTheme: "light" | "dark";
  pluginId?: string;
  active?: boolean;
};

const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "zenmind:agent-app-clipboard:request";
const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "zenmind:agent-app-clipboard:response";

export function PluginPage({ hostTheme, pluginId: pluginIdProp, active }: PluginPageProps) {
  const { pluginId: routePluginId } = useParams<{ pluginId: string }>();
  const pluginId = pluginIdProp ?? routePluginId ?? "";
  const { services } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const serviceDisplayName = service ? getServiceDisplayName(service.id, service.name) : "";
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [iframeInstanceKey, setIframeInstanceKey] = useState(0);
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
  const embeddedUrl = useMemo(() => {
    return buildPluginEmbeddedUrl(service?.id, webUrl, { hostTheme });
  }, [hostTheme, service?.id, webUrl]);

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

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

  useEffect(() => {
    if (service?.status !== "running" || !embeddedUrl) {
      return;
    }
    setIframeInstanceKey((current) => current + 1);
  }, [embeddedUrl, service?.status]);

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

  if (service.frontendMode === "none" || !webUrl) {
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
          <iframe
            key={`${service?.id ?? "service"}:${iframeInstanceKey}:${embeddedUrl}`}
            ref={iframeRef}
            src={embeddedUrl}
            title={serviceDisplayName}
            className="pan-frame"
          />
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
