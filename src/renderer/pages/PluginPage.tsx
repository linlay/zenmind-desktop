import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

function buildDesktopAgentUrl(webUrl: string) {
  const url = new URL(webUrl);
  url.pathname = "/appagent";
  url.searchParams.set("desktopApp", "1");
  return url.toString();
}

export function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const { services } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const needsSession = service?.id === "pan-webclient" && service.status === "running" && service.frontendMode !== "none";
  const supportsAgentBridge =
    service?.id === "agent-webclient"
    && service.status === "running"
    && service.frontendMode !== "none";
  const webUrl = service?.healthMeta.webUrl ?? "";
  const embeddedUrl = useMemo(() => {
    if (!webUrl) {
      return "";
    }
    return service?.id === "agent-webclient" ? buildDesktopAgentUrl(webUrl) : webUrl;
  }, [service?.id, webUrl]);

  useEffect(() => {
    if (!needsSession) {
      setSessionError("");
      setSessionReady(true);
      return;
    }
    if (!webUrl) {
      setSessionError("");
      setSessionReady(false);
      return;
    }
    let cancelled = false;
    window.electronAPI.panAuth.ensureSession(webUrl).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSessionReady(true);
      } else {
        setSessionError(result.message);
      }
    });
    return () => { cancelled = true; };
  }, [needsSession, webUrl]);

  useEffect(() => {
    if (!supportsAgentBridge) {
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
      if (!payload || payload.type !== "zenmind:agent-app-auth:request" || !payload.requestId) {
        return;
      }
      if (payload.action !== "getAccessToken" && payload.action !== "refreshAccessToken") {
        return;
      }

      window.electronAPI.agentAuth
        .issueAccessToken(payload.reason === "unauthorized" ? "unauthorized" : "missing")
        .then((result) => {
          const targetOrigin =
            event.origin && event.origin !== "null" ? event.origin : "*";
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "zenmind:agent-app-auth:response",
              requestId: payload.requestId,
              token: result.ok ? result.token : null,
            },
            targetOrigin,
          );
          if (!result.ok) {
            setSessionError(result.message);
          }
        })
        .catch((reason) => {
          setSessionError(reason instanceof Error ? reason.message : String(reason));
        });
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [supportsAgentBridge]);

  if (!service) {
    return (
      <section className="empty-state">
        <h1>服务未注册</h1>
        <p>未找到 ID 为 {pluginId} 的服务。</p>
        <Link className="primary-link" to="/control-center">返回控制中心</Link>
      </section>
    );
  }

  if (service.status !== "running") {
    return (
      <section className="empty-state">
        <p className="eyebrow">PLUGIN</p>
        <h1>{service.name} 暂未就绪</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to="/control-center">前往控制中心</Link>
      </section>
    );
  }

  if (service.frontendMode === "none" || !webUrl) {
    return (
      <section className="empty-state">
        <h1>{service.name}</h1>
        <p>该服务没有前端页面。</p>
        <Link className="primary-link" to="/control-center">返回控制中心</Link>
      </section>
    );
  }

  if (sessionError) {
    return (
      <section className="empty-state">
        <p className="eyebrow">PLUGIN</p>
        <h1>{service.name}</h1>
        <p>会话建立失败：{sessionError}</p>
        <Link className="primary-link" to="/control-center">返回控制中心</Link>
      </section>
    );
  }

  if (!sessionReady) {
    return (
      <section className="pan-page">
        <div className="loading-box pan-session-box">正在建立 {service.name} 会话…</div>
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
