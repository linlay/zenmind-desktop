import { useEffect } from "react";
import { ConfigProvider, message } from "antd";
import { useI18n } from "../../i18n/useI18n";
import type { MarketSkinFlowRuntime } from "./useMarketSkinFlow";
export function SkinMessages({ runtime }: {
    runtime: MarketSkinFlowRuntime;
}) {
    return <ConfigProvider theme={{ components: { Message: { zIndexPopup: 900 } } }}><Messages runtime={runtime}/></ConfigProvider>;
}
function Messages({ runtime }: {
    runtime: MarketSkinFlowRuntime;
}) {
    const { t } = useI18n();
    const [api, holder] = message.useMessage({ top: 80, maxCount: 3 });
    // Import opens the native picker first; the toolbar owns its pending state.
    const progress = runtime.activity?.action === "install" ? t("market.action.installing")
        : runtime.activity?.action === "remove" ? t("market.action.uninstalling") : "";
    useEffect(() => {
        if (runtime.error)
            void api.open({ key: "error", type: "error", content: runtime.error, duration: 5 });
        else
            api.destroy("error");
    }, [api, runtime.error]);
    useEffect(() => {
        if (runtime.notice)
            void api.open({ key: "notice", type: "success", content: t(runtime.notice.text), duration: 3 });
        else
            api.destroy("notice");
    }, [api, runtime.notice]);
    useEffect(() => {
        if (runtime.stateError)
            void api.open({ key: "state", type: "warning", content: runtime.stateError, duration: 5 });
        else
            api.destroy("state");
    }, [api, runtime.stateError]);
    useEffect(() => {
        if (progress)
            void api.open({ key: "progress", type: "loading", content: progress, duration: 0 });
        else
            api.destroy("progress");
    }, [api, progress]);
    useEffect(() => () => { api.destroy(); }, [api]);
    return holder;
}
