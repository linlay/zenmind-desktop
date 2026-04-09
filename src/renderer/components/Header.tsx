import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/control-center", label: "控制中心" },
  { to: "/assistant", label: "小宅助理" },
  { to: "/agents", label: "智能体" },
  { to: "/pan", label: "网盘" },
  { to: "/market", label: "插件市场" },
  { to: "/help", label: "帮助" }
];

export function Header() {
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
