import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { getServiceDisplayName } from "../../service-display";
import { useI18n } from "../../i18n/useI18n";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";
import {
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  type ServiceWebviewBridgeMessage
} from "../../../shared/service-webview-bridge";
import { handleServiceWebviewBridgeMessage } from "../../services/serviceWebviewBridgeHost";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { useSingleWebviewSurfaceRegistration } from "../../services/useSingleWebviewSurfaceRegistration";
import { createPluginSettingsSurfaceIdentity } from "../../../shared/surface-identity";

type PluginSettingsPageProps = {
  hostTheme: "light" | "dark";
};

function readEventString(event: Event, key: string) {
  const value = (event as Event & Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function PluginSettingsPage({ hostTheme }: PluginSettingsPageProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { pluginId: routePluginId } = useParams();
  const pluginId = routePluginId ?? "";
  const { services } = useServices();
  const service = services.find((item) => item.id === pluginId);
  const serviceDisplayName = service ? getServiceDisplayName(service.id, service.name, t) : pluginId;
  const pluginsSettingsPath = buildSettingsSectionPath("plugins");
  const [settingsUrl, setSettingsUrl] = useState("");
  const [preloadUrl, setPreloadUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  const webviewUrl = useMemo(() => {
    if (!settingsUrl) {
      return "";
    }
    try {
      const url = new URL(settingsUrl);
      url.searchParams.set("hostTheme", hostTheme);
      return url.toString();
    } catch {
      return settingsUrl;
    }
  }, [hostTheme, settingsUrl]);

  useSingleWebviewSurfaceRegistration({
    webviewRef,
    surfaceIdentity: createPluginSettingsSurfaceIdentity(pluginId),
    surfaceIdentityKey: pluginId,
    surfaceType: "service",
    serviceId: pluginId,
    pageRoute: `/plugins/${pluginId}/settings`,
    label: serviceDisplayName,
    url: webviewUrl,
    refreshKey: preloadUrl,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void Promise.all([
      window.electronAPI.services.openPluginSettingsPage(pluginId),
      window.electronAPI.serviceWebview.getPreloadUrl()
    ])
      .then(([result, nextPreloadUrl]) => {
        if (cancelled) return;
        if (!result.ok || !result.url) {
          setError(result.message || t("pluginSettingsPage.unavailable"));
          return;
        }
        setSettingsUrl(result.url);
        setPreloadUrl(nextPreloadUrl);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, t]);

  function sendBridgeMessageToWebview(payload: ServiceWebviewBridgeMessage) {
    try {
      webviewRef.current?.send(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, payload);
    } catch {
      // Ignore bridge delivery while the settings webview is being recreated.
    }
  }

  function handleWebviewBridgeMessage(event: Event) {
    if (readEventString(event, "channel") !== SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL) {
      return;
    }
    const [payload] = ((event as Event & { args?: unknown[] }).args ?? []) as [
      ServiceWebviewBridgeMessage?,
    ];
    if (!payload || !payload.type || !payload.requestId) {
      return;
    }
    handleServiceWebviewBridgeMessage(payload, {
      serviceId: pluginId,
      bridgeProtocol: null,
      sendBridgeMessageToWebview,
      setBridgeError: setError,
      logDebug: (stage, message) => {
        console.info("[plugin-settings-webview]", pluginId, stage, message);
      }
    });
  }

  useEffect(() => {
    const targetWebview = webviewRef.current;
    if (!targetWebview || !webviewUrl || !preloadUrl) {
      return undefined;
    }
    targetWebview.addEventListener("ipc-message", handleWebviewBridgeMessage);
    return () => {
      targetWebview.removeEventListener("ipc-message", handleWebviewBridgeMessage);
    };
  }, [pluginId, webviewUrl, preloadUrl]);

  if (!service) {
    return (
      <section className="empty-state">
        <h1>{t("pluginSettingsPage.pluginMissingTitle")}</h1>
        <p>{t("pluginSettingsPage.pluginMissingMessage", { pluginId })}</p>
        <Link className="primary-link" to={pluginsSettingsPath}>{t("pluginSettingsPage.back")}</Link>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="empty-state" aria-busy="true">
        <p className="eyebrow">PLUGIN SETTINGS</p>
        <h1>{serviceDisplayName}</h1>
        <p>{t("pluginSettingsPage.loading")}</p>
      </section>
    );
  }

  if (error || !webviewUrl || !preloadUrl) {
    return (
      <section className="empty-state">
        <p className="eyebrow">PLUGIN SETTINGS</p>
        <h1>{serviceDisplayName}</h1>
        <p>{error || t("pluginSettingsPage.unavailable")}</p>
        <Link className="primary-link" to={pluginsSettingsPath}>{t("pluginSettingsPage.back")}</Link>
      </section>
    );
  }

  return (
    <section className="embedded-surface-page embedded-surface-page-embedded">
      <button
        className="embedded-back-button"
        onClick={() => navigate(-1)}
        title={t("common.back")}
        aria-label={t("common.back")}
      >
        <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
          <path d="m313-440 224 224-57 57-320-320 320-320 57 57-224 224h487v80H313Z"/>
        </svg>
      </button>
      <div className="embedded-surface-frame-shell">
        {createElement("webview", {
          ref: (node: Electron.WebviewTag | null): void => {
            webviewRef.current = node;
          },
          src: webviewUrl,
          title: t("pluginSettingsPage.titleSuffix", { name: serviceDisplayName }),
          className: "embedded-surface-frame",
          preload: preloadUrl,
          partition: `persist:${STORAGE_NAMESPACE}-plugin-settings-${pluginId}`,
          allowpopups: "true",
          style: { width: "100%", height: "100%", border: "none" },
        })}
      </div>
    </section>
  );
}
