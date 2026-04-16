import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol,
} from "../../shared/auth-bridge";

export function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const { services } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const [bridgeError, setBridgeError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const webUrl = service?.healthMeta.webUrl ?? "";
  const bridgeProtocol = useMemo(
    () => getPluginAuthBridgeProtocol(service?.id),
    [service?.id],
  );
  const embeddedUrl = useMemo(() => {
    return buildPluginEmbeddedUrl(service?.id, webUrl);
  }, [service?.id, webUrl]);

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

  useEffect(() => {
    if (!bridgeProtocol) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
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

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [bridgeProtocol]);

  if (!service) {
    return (
      <section className="empty-state">
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
      <section className="empty-state">
        <p className="eyebrow">PLUGIN</p>
        <h1>{service.name} 暂未就绪</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to="/control-center">
          前往控制中心
        </Link>
      </section>
    );
  }

  if (service.frontendMode === "none" || !webUrl) {
    return (
      <section className="empty-state">
        <h1>{service.name}</h1>
        <p>该服务没有前端页面。</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  if (bridgeError) {
    return (
      <section className="empty-state">
        <p className="eyebrow">PLUGIN</p>
        <h1>{service.name}</h1>
        <p>认证桥接失败：{bridgeError}</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  return (
    <section className="pan-page">
      <div className="pan-frame-shell">
        <iframe
          ref={iframeRef}
          src={embeddedUrl}
          title={service.name}
          className="pan-frame"
        />
      </div>
    </section>
  );
}
