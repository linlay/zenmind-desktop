import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

export function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const { services } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState("");

  const needsSession = service?.id === "pan-webclient" && service.status === "running" && service.hasFrontend;
  const webUrl = service?.healthMeta.webUrl ?? "";

  useEffect(() => {
    if (!needsSession) {
      setSessionReady(true);
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

  if (!service) {
    return (
      <section className="empty-state">
        <h1>插件未注册</h1>
        <p>未找到 ID 为 {pluginId} 的插件服务。</p>
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

  if (!service.hasFrontend || !webUrl) {
    return (
      <section className="empty-state">
        <h1>{service.name}</h1>
        <p>该插件没有前端页面。</p>
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
      <section className="empty-state">
        <p className="eyebrow">PLUGIN</p>
        <h1>{service.name}</h1>
        <p>正在建立会话…</p>
      </section>
    );
  }

  return (
    <section className="pan-page">
      <div className="page-head compact">
        <div>
          <p className="eyebrow">PLUGIN</p>
          <h1>{service.name}</h1>
        </div>
        <span className="status-pill running">运行中</span>
      </div>
      <div className="pan-frame-shell">
        <iframe
          src={webUrl}
          title={service.name}
          className="pan-frame"
        />
      </div>
    </section>
  );
}
