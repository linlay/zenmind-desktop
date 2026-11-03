import { useI18n } from "../i18n/useI18n";

export function WorkPanelResizeGuide({ direction, left }: { direction: "expand" | "collapse"; left: number }) {
  const { t } = useI18n();
  return (
    <div className="main-chat-resize-guide" style={{ left }} role="status">
      <span>{t(direction === "expand" ? "chatWorkPanel.resize.expandChat" : "chatWorkPanel.resize.collapseChat")}</span>
    </div>
  );
}
