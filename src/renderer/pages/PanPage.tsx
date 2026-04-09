import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PanAuthStatus } from "@shared/contracts";
import { useServices } from "../services/ServicesContext";

function buildDesktopPanUrl(webUrl: string) {
  const url = new URL(webUrl);
  url.searchParams.set("desktopApp", "1");
  return url.toString();
}

export function PanPage() {
  const { services } = useServices();
  const panService = services.find((service) => service.id === "pan-webclient");
  const [sessionState, setSessionState] = useState<"checking" | "ready" | "error">("checking");
  const [sessionMessage, setSessionMessage] = useState("正在建立 Desktop 网盘会话...");
  const [panAuthStatus, setPanAuthStatus] = useState<PanAuthStatus | null>(null);
  const [iframeVersion, setIframeVersion] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!panService) {
      setSessionState("checking");
      setSessionMessage("网盘服务未注册。");
      return;
    }

    if (panService.status !== "running") {
      setSessionState("checking");
      setSessionMessage("正在等待网盘服务启动...");
      return;
    }

    let disposed = false;

    async function syncSession(reloadOnRefresh: boolean) {
      if (disposed || inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;
      try {
        const [status, result] = await Promise.all([
          window.electronAPI.panAuth.getStatus(),
          window.electronAPI.panAuth.ensureSession(panService.healthMeta.webUrl)
        ]);

        if (disposed) {
          return;
        }

        setPanAuthStatus(status);
        setSessionMessage(result.message);
        if (result.ok) {
          setSessionState("ready");
          if (reloadOnRefresh && result.refreshed) {
            setIframeVersion((current) => current + 1);
          }
          return;
        }

        setSessionState("error");
      } catch (reason) {
        if (disposed) {
          return;
        }

        setSessionState("error");
        setSessionMessage(reason instanceof Error ? reason.message : String(reason));
      } finally {
        inFlightRef.current = false;
      }
    }

    void syncSession(false);

    const interval = window.setInterval(() => {
      void syncSession(true);
    }, 30_000);
    const handleFocus = () => {
      void syncSession(true);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncSession(true);
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [panService?.healthMeta.webUrl, panService?.status]);

  if (!panService) {
    return (
      <section className="empty-state">
        <h1>网盘服务未注册</h1>
        <p>请回到控制中心确认内置服务是否已正确装配。</p>
      </section>
    );
  }

  if (panService.status !== "running") {
    return (
      <section className="empty-state">
        <p className="eyebrow">PAN WORKSPACE</p>
        <h1>网盘暂未就绪</h1>
        <p>{panService.message}</p>
        <div className="inline-actions">
          <Link className="primary-link" to="/control-center">
            前往控制中心
          </Link>
          <span className="muted-inline">目标入口：{panService.healthMeta.webUrl}</span>
        </div>
      </section>
    );
  }

  if (sessionState === "checking") {
    return (
      <section className="pan-page">
        <div className="page-head compact">
          <div>
            <p className="eyebrow">PAN WORKSPACE</p>
            <h1>网盘</h1>
          </div>
          <span className="status-pill warning">正在连接</span>
        </div>
        <div className="loading-box pan-session-box">{sessionMessage}</div>
      </section>
    );
  }

  if (sessionState === "error") {
    return (
      <section className="empty-state">
        <p className="eyebrow">PAN WORKSPACE</p>
        <h1>Desktop 会话未建立</h1>
        <p>{sessionMessage}</p>
        <div className="inline-actions">
          <Link className="primary-link" to="/control-center">
            前往控制中心导入私钥
          </Link>
          <span className="muted-inline">私钥路径：{panAuthStatus?.path || "读取失败"}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="pan-page">
      <div className="page-head compact">
        <div>
          <p className="eyebrow">PAN WORKSPACE</p>
          <h1>网盘</h1>
        </div>
        <span className="status-pill running">本地服务在线</span>
      </div>
      <div className="pan-frame-shell">
        <iframe
          key={`${buildDesktopPanUrl(panService.healthMeta.webUrl)}:${iframeVersion}`}
          src={buildDesktopPanUrl(panService.healthMeta.webUrl)}
          title="ZenMind Pan"
          className="pan-frame"
        />
      </div>
    </section>
  );
}
