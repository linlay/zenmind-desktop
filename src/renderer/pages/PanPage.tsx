import { Link } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

export function PanPage() {
  const { services } = useServices();
  const panService = services.find((service) => service.id === "pan-webclient");

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
          key={panService.healthMeta.webUrl}
          src={panService.healthMeta.webUrl}
          title="ZenMind Pan"
          className="pan-frame"
        />
      </div>
    </section>
  );
}
