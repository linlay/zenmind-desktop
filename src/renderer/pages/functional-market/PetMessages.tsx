import { useEffect } from "react";
import { ConfigProvider, message } from "antd";
import { useI18n } from "../../i18n/useI18n";
import type { MarketPetFlowRuntime } from "./useMarketPetFlow";

export function PetMessages({ runtime }: { runtime: MarketPetFlowRuntime }) {
  return <ConfigProvider theme={{ components: { Message: { zIndexPopup: 900 } } }}><Messages runtime={runtime} /></ConfigProvider>;
}
function Messages({ runtime }: { runtime: MarketPetFlowRuntime }) {
  const { t } = useI18n();
  const [api, holder] = message.useMessage({ top: 80, maxCount: 3 });
  const progress = runtime.activity ? t(runtime.activity.action === "import" ? "settings.desktopPet.import.pending"
    : runtime.activity.action === "remove" ? "market.action.uninstalling" : "market.action.installing") : "";
  useEffect(() => {
    if (runtime.error) void api.open({ key: "error", type: "error", content: runtime.error, duration: 5 });
    else api.destroy("error");
  }, [api, runtime.error]);
  useEffect(() => {
    if (runtime.notice) void api.open({ key: "notice", type: "success", content: t(runtime.notice.text), duration: 3 });
    else api.destroy("notice");
  }, [api, runtime.notice]);
  useEffect(() => {
    if (runtime.stateError) void api.open({ key: "state", type: "warning", content: runtime.stateError, duration: 5 });
    else api.destroy("state");
  }, [api, runtime.stateError]);
  useEffect(() => {
    if (progress && runtime.activity?.action !== "use") void api.open({ key: "progress", type: "loading", content: progress, duration: 0 });
    else api.destroy("progress");
  }, [api, progress, runtime.activity?.action]);
  useEffect(() => () => { api.destroy(); }, [api]);
  return holder;
}
