import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

const staticNavItems = [
  { to: "/control-center", label: "控制中心" },
  { to: "/assistant", label: "小宅助理" },
  { to: "/agents", label: "智能体" }
];

const tailNavItems = [
  { to: "/market", label: "插件市场" },
  { to: "/help", label: "帮助" }
];

export function Header() {
  const { services } = useServices();
  const pluginNavItems = services
    .filter((s) => s.kind === "plugin" && s.hasFrontend && s.status === "running")
    .map((s) => ({ to: `/plugin/${s.id}`, label: s.name }));

  const navItems = [...staticNavItems, ...pluginNavItems, ...tailNavItems];

  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-kicker">ZENMIND</span>
        <span className="brand-title">Desktop Control Shell</span>
      </div>
      <nav className="app-nav" aria-label="Main Navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
