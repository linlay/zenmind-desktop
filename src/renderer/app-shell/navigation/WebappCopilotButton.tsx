import { PRODUCT_NAME } from "../../../shared/brand";
import { SidebarActionIcon } from "../../components/BrandMark";
import { useI18n } from "../../i18n/useI18n";

export function WebappCopilotButton({ open, onToggle }: {
  open: boolean;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const label = t(open ? "sidebar.copilot.close" : "sidebar.copilot.open", {
    appName: PRODUCT_NAME,
  });
  return (
    <button
      type="button"
      className="webapp-copilot-button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={onToggle}
    >
      <SidebarActionIcon kind="sidebar_left" className="sidebar-right-panel-icon" />
    </button>
  );
}
