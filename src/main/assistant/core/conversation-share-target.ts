import type { App } from "electron";
import { isDesktopDevelopmentRuntime } from "../../development-runtime";
import { t } from "../../i18n/main-i18n";
import { readDesktopSsoSiteAccessToken } from "../../sso-site-token";
import { deriveTunnelHubRegistrationApiOrigin } from "../../tunnel-hub-registration";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname,
} from "../../tunnel-hub-url-policy";

export type ConversationShareTarget = {
  origin: string;
  accessToken: string;
};

export function resolveConversationShareTarget(app: App):
  | { ok: true; target: ConversationShareTarget }
  | { ok: false; message: string } {
  const accessToken = readDesktopSsoSiteAccessToken(app);
  if (!accessToken) {
    return { ok: false, message: t("assistant.chatShareLoginRequired") };
  }
  const origin = resolveConversationTunnelOrigin(app, true);
  if (!origin.ok) {
    return origin;
  }
  return {
    ok: true,
    target: {
      origin: origin.origin,
      accessToken,
    },
  };
}

export function resolveConversationAssetOrigin(app: App):
  | { ok: true; origin: string }
  | { ok: false; message: string } {
  return resolveConversationTunnelOrigin(app, false);
}

function resolveConversationTunnelOrigin(
  app: App,
  requireEnabled: boolean,
):
  | { ok: true; origin: string }
  | { ok: false; message: string } {
  const settings = readTunnelHubSettings(app);
  if (!settings.relayUrl || (requireEnabled && !settings.enabled)) {
    return { ok: false, message: t("assistant.chatShareTunnelRequired") };
  }
  try {
    const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
    const developmentLoopbackOrigin = isDesktopDevelopmentRuntime(app) &&
      isLoopbackHttpOrigin(origin);
    if (!isAllowedHttpsTunnelOrigin(origin) && !developmentLoopbackOrigin) {
      throw new Error("Tunnel share API must use HTTPS.");
    }
    return { ok: true, origin };
  } catch (error) {
    return {
      ok: false,
      message: t("assistant.chatShareTunnelUrlInvalid", {
        message: messageFromError(error),
      }),
    };
  }
}

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" &&
      value === parsed.origin &&
      isTunnelHubLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedHttpsTunnelOrigin(value: string): boolean {
  const parsed = new URL(value);
  return parsed.protocol === "https:" &&
    value === parsed.origin &&
    !isTunnelHubForbiddenHostname(parsed.hostname);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
