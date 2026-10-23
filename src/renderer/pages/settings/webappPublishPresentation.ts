import type { WebappPublishInfo, WebappPublishState, WebappRuntimeState } from "../../../shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";

export function getWebappPublishPresentation(
  state: WebappPublishState | null | undefined,
  info: WebappPublishInfo | null | undefined,
  runtime: WebappRuntimeState | null | undefined
): { label: TranslationKey; className: string } {
  if (state === undefined) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  if (!state?.active) return { label: "settings.webapps.publishStatusNotPublished", className: "idle" };
  if (runtime === undefined) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  if (runtime?.status !== "running") return { label: "settings.webapps.publishAppStopped", className: "warning" };
  if (!info) return { label: "settings.webapps.publishStatusChecking", className: "loading" };
  return info.tunnelConnected
    ? { label: "settings.webapps.publishStatusTunnelConnected", className: "running" }
    : { label: "settings.webapps.publishTunnelOffline", className: "warning" };
}
