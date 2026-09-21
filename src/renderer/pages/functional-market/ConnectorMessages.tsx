import { useEffect } from "react";
import { ConfigProvider, message } from "antd";
import type { TranslationKey } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";
import type { MarketConnectorFlowRuntime } from "./useMarketConnectorFlow";

export function ConnectorMessages({ runtime }: { runtime: MarketConnectorFlowRuntime }) {
  return <ConfigProvider theme={{ components: { Message: { zIndexPopup: 900 } } }}><Messages runtime={runtime} /></ConfigProvider>;
}
function Messages({ runtime }: { runtime: MarketConnectorFlowRuntime }) {
  const { t } = useI18n();
  const [api, holder] = message.useMessage({ top: 80, maxCount: 3 });
  const translate = (value: string) => value.startsWith("market.") ? t(value as TranslationKey) : value;
  const error = runtime.error ? `${runtime.errorItem ? `${runtime.errorItem.name} · ` : ""}${translate(runtime.error)}` : "";
  const notice = translate(runtime.notice);
  const warning = runtime.stateError ? `${t("market.connector.flow.stateUnavailable")} · ${runtime.stateError}` : "";
  const progress = runtime.busy && runtime.flow && !["credentials", "authorizing"].includes(runtime.flow.phase)
    ? `${runtime.flow.item.name} · ${t(`market.connector.flow.phase.${runtime.flow.phase}` as TranslationKey)}` : "";
  const noticeType = runtime.notice === "market.connector.flow.remoteFailed" ? "warning"
    : ["market.connector.flow.phase.complete", "market.connector.flow.updated"].includes(runtime.notice) ? "success" : "info";
  useEffect(() => {
    if (error) void api.open({ key: "error", type: "error", content: error, duration: 5 });
    else api.destroy("error");
  }, [api, error]);
  useEffect(() => {
    if (notice) void api.open({ key: "notice", type: noticeType, content: notice, duration: 3 });
    else api.destroy("notice");
  }, [api, notice, noticeType]);
  useEffect(() => {
    if (warning) void api.open({ key: "state", type: "warning", content: warning, duration: 5 });
    else api.destroy("state");
  }, [api, warning]);
  useEffect(() => {
    if (progress) void api.open({ key: "progress", type: "loading", content: progress, duration: 0 });
    else api.destroy("progress");
  }, [api, progress]);
  const redirect = t("market.connector.flow.redirectAuthorization");
  useEffect(() => {
    if (runtime.authRedirectKey) void api.open({ key: "redirect", type: "info", content: redirect, duration: 3 });
  }, [api, runtime.authRedirectKey, redirect]);
  useEffect(() => { if (!runtime.busy || runtime.error) api.destroy("redirect"); }, [api, runtime.busy, runtime.error]);
  useEffect(() => () => { api.destroy(); }, [api]);
  return holder;
}
