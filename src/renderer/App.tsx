import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { PanPage } from "./pages/PanPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { ServicesProvider } from "./services/ServicesContext";

export function App() {
  return (
    <ServicesProvider>
      <div className="app-shell">
        <Header />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/control-center" replace />} />
            <Route path="/control-center" element={<ControlCenterPage />} />
            <Route
              path="/assistant"
              element={
                <PlaceholderPage
                  title="小宅助理"
                  description="这里会承接后续的小宅助理桌面入口。本期先完成服务宿主、控制中心和网盘装配。"
                />
              }
            />
            <Route
              path="/agents"
              element={
                <PlaceholderPage
                  title="智能体"
                  description="智能体工作台会在后续核心能力接入后启用。当前先保留独立页面和导航位置。"
                />
              }
            />
            <Route path="/pan" element={<PanPage />} />
            <Route
              path="/market"
              element={
                <PlaceholderPage
                  title="插件市场"
                  description="插件下载、安装与部署联通能力已预留扩展点，本期页面先做占位。"
                />
              }
            />
            <Route
              path="/help"
              element={
                <PlaceholderPage
                  title="帮助"
                  description="帮助中心后续可承载安装指导、日志说明、服务依赖说明与常见问题。"
                />
              }
            />
          </Routes>
        </main>
      </div>
    </ServicesProvider>
  );
}
