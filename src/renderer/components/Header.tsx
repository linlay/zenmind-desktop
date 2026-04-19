import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

const staticNavItems = [
  { to: "/control-center", label: "控制中心" },
  { to: "/assistant", label: "小宅助理" }
];

const tailNavItems = [
  { to: "/market", label: "插件市场" },
  { to: "/help", label: "帮助" }
];

type HeaderProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
};

export function Header({ themeMode, onToggleTheme }: HeaderProps) {
  const { services } = useServices();
  const serviceNavItems = services
    .filter((s) => s.id !== "agent-webclient" && s.frontendMode === "standalone" && s.status === "running")
    .map((s) => ({ to: `/plugin/${s.id}`, label: s.name }));

  const navItems = [...staticNavItems, ...serviceNavItems, ...tailNavItems];

  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-kicker">Zenmind Desktop</span>
        {/* <span className="brand-title">Desktop Control Shell</span> */}
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
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={themeMode === "light" ? "切换到黑版" : "切换到白版"}
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            {themeMode === "light" ? "◐" : "◑"}
          </span>
          <span>{themeMode === "light" ? "黑版" : "白版"}</span>
        </button>
      </nav>
    </header>
  );
}
