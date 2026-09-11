import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../i18n/useI18n";

const allMenuIds = ["file", "edit", "view", "help"] as const;

export function WindowsApplicationMenu({ disabled, helpEnabled }: { disabled: boolean; helpEnabled: boolean }) {
  const menuIds = allMenuIds.filter((menu) => menu !== "help" || helpEnabled);
  const { t } = useI18n();
  const [active, setActive] = useState<string | null>(null);

  async function openMenu(menu: typeof menuIds[number], button: HTMLButtonElement) {
    if (disabled || active) return;
    const rect = button.getBoundingClientRect();
    setActive(menu);
    try {
      await window.electronAPI.desktopShell.popupApplicationMenu({ menu, x: rect.left, y: rect.bottom });
    } finally {
      setActive(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void openMenu(menuIds[index], event.currentTarget).catch(() => undefined);
    } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuIds.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : menuIds.length - 1)) % menuIds.length;
      event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
    }
  }

  return (
    <nav className="app-system-bar-primary-actions app-system-bar-menus" aria-label={t("menu.application")}>
      {menuIds.map((menu, index) => (
        <button key={menu} type="button"
          className={`app-system-bar-action app-system-bar-menu${active === menu ? " is-active" : ""}`}
          aria-haspopup="menu" aria-expanded={active === menu} disabled={disabled}
          onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
          onClick={(event) => { void openMenu(menu, event.currentTarget).catch(() => undefined); }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >{t(`menu.${menu}`)}</button>
      ))}
    </nav>
  );
}
