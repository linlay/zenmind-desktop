import { FullscreenExitOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";

export function WorkPanelFullscreenControls({ isMac, isWindows, onExit }: {
  isMac: boolean;
  isWindows: boolean;
  onExit(): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(true);
  const shortcut = isMac ? "⌘⇧F" : isWindows ? "Ctrl+Shift+F" : "";

  useEffect(() => {
    const controls = ref.current;
    if (!controls) return;
    controls.setAttribute("popover", "manual");
    // Cover both ordinary items and the separately mounted canonical WebApp layer.
    // Guest HTML fullscreen can cover host UI; the Main shortcut remains available.
    controls.showPopover();
    const timeout = window.setTimeout(() => setShowHint(false), 3000);
    return () => {
      window.clearTimeout(timeout);
      controls.hidePopover();
    };
  }, []);

  return (
    <div ref={ref} className={`work-panel-fullscreen-controls${showHint ? " is-hint-visible" : ""}`}>
      <button
        type="button"
        className="work-panel-fullscreen-exit"
        aria-keyshortcuts={isMac ? "Meta+Shift+F" : isWindows ? "Control+Shift+F" : undefined}
        onClick={onExit}
      >
        <FullscreenExitOutlined />
        <span>{t("chatWorkPanel.tabContextMenu.exitFullscreen")}</span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>
      {showHint && <div className="work-panel-fullscreen-hint" role="status">
        {t("chatWorkPanel.fullscreen.hint", { shortcut })}
      </div>}
    </div>
  );
}
