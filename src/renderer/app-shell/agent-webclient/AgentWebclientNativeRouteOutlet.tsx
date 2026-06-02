import { App as AntdApp, ConfigProvider, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import type { AgentWebclientResolvedRoute } from "../../../shared/agent-webclient-routes";
import { useI18n } from "../../i18n/useI18n";
import { AgentsPage } from "./AgentsPage";
import { AutomationsPage } from "./AutomationsPage";

export function AgentWebclientNativeRouteOutlet({
  route,
  hostTheme
}: {
  route: AgentWebclientResolvedRoute | null;
  hostTheme: "light" | "dark";
}) {
  const { locale } = useI18n();

  if (route?.mode !== "native") {
    return null;
  }

  const nativePage =
    route.key === "agents" ? (
      <AgentsPage />
    ) : route.key === "schedules" ? (
      <AutomationsPage />
    ) : null;

  if (!nativePage) {
    return null;
  }

  return (
    <ConfigProvider
      locale={locale === "en-US" ? enUS : zhCN}
      theme={{
        algorithm: hostTheme === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          borderRadius: 6,
          colorPrimary: "#2f6fed",
          fontFamily: "inherit"
        }
      }}
    >
      <AntdApp>
        <section className="agent-webclient-native">{nativePage}</section>
      </AntdApp>
    </ConfigProvider>
  );
}
