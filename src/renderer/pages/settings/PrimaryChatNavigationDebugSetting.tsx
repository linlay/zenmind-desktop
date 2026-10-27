import { Switch } from "antd";
import { useI18n } from "../../i18n/useI18n";

export function PrimaryChatNavigationDebugSetting({ enabled, onChange }: {
  enabled: boolean; onChange?: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  return <div className="data-root-card settings-debug-panel">
    <div className="settings-appearance-row">
      <div className="settings-appearance-row-copy">
        <strong id="primary-chat-navigation-label">{t("settings.debug.primaryChats.title")}</strong>
        <span id="primary-chat-navigation-description">{t("settings.debug.primaryChats.description")}</span>
      </div>
      <Switch checked={enabled} disabled={!onChange} onChange={onChange}
        aria-labelledby="primary-chat-navigation-label" aria-describedby="primary-chat-navigation-description" />
    </div>
  </div>;
}
