import { useI18n } from "../i18n/useI18n";

export function WorkPanelResizeHint({ direction }: { direction: "expand" | "collapse" | null }) {
  const { t } = useI18n();
  if (!direction) return null;
  return (
    <div className="main-chat-resize-hint" role="status">
      <span>{t(direction === "expand" ? "chatWorkPanel.resize.expandChat" : "chatWorkPanel.resize.collapseChat")}</span>
    </div>
  );
}
