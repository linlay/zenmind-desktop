import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { getServiceDisplayName, shouldShowServiceNavigationTab } from "../service-display";
import { PRODUCT_NAME } from "../../shared/generated/brand";
import { useI18n } from "../i18n/useI18n";

type HeaderProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
};

export function Header({ themeMode, onToggleTheme }: HeaderProps) {
  const { t } = useI18n();
  const { services } = useServices();
  const serviceNavItems = services
    .filter(shouldShowServiceNavigationTab)
    .map((s) => ({ to: `/service/${s.id}`, label: getServiceDisplayName(s.id, s.name, t) }));

  const staticNavItems = [
    { to: "/control-center", label: t("nav.controlCenter") }
  ];
  const tailNavItems = [
    { to: "/market", label: t("nav.market") },
    { to: "/help", label: t("nav.help") }
  ];
  const navItems = [...staticNavItems, ...serviceNavItems, ...tailNavItems];

  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-kicker">{PRODUCT_NAME}</span>
        {/* <span className="brand-title">Desktop Control Shell</span> */}
      </div>
      <nav className="app-nav" aria-label={t("nav.main")}>
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
          aria-label={themeMode === "light" ? t("settings.appearance.switchToDark") : t("settings.appearance.switchToLight")}
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            {themeMode === "light" ? "◐" : "◑"}
          </span>
          <span>{themeMode === "light" ? t("settings.appearance.dark") : t("settings.appearance.light")}</span>
        </button>
      </nav>
    </header>
  );
}
