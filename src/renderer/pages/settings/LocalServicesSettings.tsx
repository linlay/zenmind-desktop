import { useEffect, useState } from "react";
import { Button, Tag } from "antd";
import { CopyOutlined, ReloadOutlined, GlobalOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { useI18n } from "../../i18n/useI18n";
import { PageFeedbackStack, type PageFeedbackItem } from "../../components/PageFeedbackStack";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";
import type { BrowserWebclientState, ServiceStatus } from "../../../shared/contracts";
import type { TranslationKey } from "../../../shared/i18n";
import { localServiceBaseUrl, platformConnectionExamples } from "./localServiceAccess";
import "./LocalServicesSettings.css";

const STATUS_KEYS: Record<ServiceStatus, TranslationKey> = {
  running: "controlCenter.status.running",
  stopped: "controlCenter.status.stopped",
  error: "controlCenter.status.error",
  "not-installed": "controlCenter.status.notInstalled",
  "initialization-required": "controlCenter.status.initializationRequired",
  "config-required": "controlCenter.status.configRequired",
  "dependency-missing": "controlCenter.status.dependencyMissing"
};

export function LocalServicesSettings({ isWindows }: { isWindows: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { services, loading, error, refresh } = useServices();
  const [browser, setBrowser] = useState<BrowserWebclientState>({ running: false, url: "" });
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState("");
  const [browserRevision, setBrowserRevision] = useState(0);
  useEffect(() => {
    let live = true;
    const update = async () => {
      try {
        const state = await window.electronAPI.services.getBrowserWebclient();
        if (live) { setBrowser(state); setBrowserError(""); }
      } catch {
        if (live) { setBrowser({ running: false, url: "" }); setBrowserError(t("settings.localServices.browserStateFailed")); }
      }
    };
    void update();
    const remove = window.electronAPI.onServicesChanged(() => void update());
    window.addEventListener("focus", update);
    return () => { live = false; remove(); window.removeEventListener("focus", update); };
  }, [browserRevision, t]);
  async function browserAction(stop = false) {
    setBrowserBusy(true);
    try {
      const result = await (stop ? window.electronAPI.services.stopBrowserWebclient() : window.electronAPI.services.openBrowserWebclient());
      setBrowser({ running: result.running, url: result.url });
      setBrowserError("");
      setFeedback({ id: Date.now(), tone: result.ok ? "success" : "error", message: result.ok
        ? t(stop ? "settings.localServices.browserStopped" : "settings.localServices.browserOpened")
        : result.message || t("settings.localServices.browserOpenFailed") });
    } catch {
      setFeedback({ id: Date.now(), tone: "error", message: t("settings.localServices.browserOpenFailed") });
    } finally { setBrowserBusy(false); setBrowserRevision(value => value + 1); }
  }
  const platformReady = !error && !loading && services.some(service => service.id === "agent-platform" && service.status === "running");
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<PageFeedbackItem | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy(value: string) {
    try {
      const result = await window.electronAPI.clipboard.writeText(value);
      if (!result.ok) throw new Error(result.message || t("settings.localServices.copyFailed"));
      setFeedback({ id: Date.now(), tone: "success", message: t("settings.localServices.copied") });
    } catch {
      setFeedback({ id: Date.now(), tone: "error", message: t("settings.localServices.copyFailed") });
    }
  }

  function address(label: string, value: string) {
    return <div className="local-services-address">
      <span>{label}</span>
      <code>{value || t("settings.localServices.unavailable")}</code>
      <Button type="text" icon={<CopyOutlined />} disabled={!value} onClick={() => void copy(value)}
        aria-label={`${t("settings.localServices.copyAddress")}: ${label}`}>
        {t("settings.localServices.copyAddress")}
      </Button>
    </div>;
  }

  return <div className="local-services-settings">
    <PageFeedbackStack items={feedback ? [{ ...feedback, onDismiss: () => setFeedback(null) }] : []} />
    <div className="local-services-toolbar">
      <p>{t("settings.localServices.lifecycle")}</p>
      <Button icon={<ReloadOutlined />} loading={loading || refreshing} onClick={async () => {
        setRefreshing(true);
        try { await refresh(); setBrowserRevision(value => value + 1); } finally { setRefreshing(false); }
      }}>{t("common.refresh")}</Button>
    </div>
    {error ? <p role="alert" className="settings-section-read-error">{error}</p> : null}
    {(["agent-webclient", "agent-platform"] as const).map((id) => {
      const service = services.find((entry) => entry.id === id);
      // A failed snapshot read must not leave copyable endpoints from an old snapshot.
      const baseUrl = error || loading ? "" : localServiceBaseUrl(service);
      const platform = id === "agent-platform";
      const examples = platform && baseUrl ? platformConnectionExamples(baseUrl, isWindows) : null;
      return <section className="settings-item-card local-services-card" key={id} aria-labelledby={`${id}-access-title`}>
        <header className="settings-item-header">
          <div>
            <h2 id={`${id}-access-title`}>{t(platform ? "settings.localServices.platform" : "settings.localServices.webclient")}</h2>
            <p>{t(platform ? "settings.localServices.platformDescription" : "settings.localServices.webclientDescription")}</p>
          </div>
          <Tag color={!error && service?.status === "running" ? "success" : "default"}>
            {loading ? t("common.loading") : error || !service ? t("settings.localServices.unknown") : t(STATUS_KEYS[service.status])}
          </Tag>
        </header>
        <div className="local-services-body">
          {platform ? address(t("settings.localServices.httpAddress"), baseUrl)
            : address(t("settings.localServices.browserAddress"), browser.url)}
          {platform ? address(t("settings.localServices.wsAddress"), examples?.wsUrl || "") : null}
          {service?.status !== "running" && service?.message ? <p>{service.message}</p> : null}
          {!platform ? <div className="local-services-browser">
            <Tag color={browser.running ? "success" : "default"}>{t(browser.running ? "controlCenter.status.running" : "controlCenter.status.stopped")}</Tag>
            <p>{t("settings.localServices.browserDescription")}</p>
            <p>{t("settings.localServices.browserSession")}</p>
            {browserError ? <p role="alert">{browserError}</p> : null}
            {!platformReady || !baseUrl ? <p>{t("settings.localServices.browserDependencies")}</p> : null}
            <div className="local-services-browser-actions">
              <Button type="primary" icon={<GlobalOutlined />} loading={browserBusy} disabled={!platformReady || !baseUrl}
                onClick={() => void browserAction()}>{t(browser.running ? "settings.localServices.browserOpen" : "settings.localServices.browserStart")}</Button>
              <Button disabled={!browser.running || browserBusy} onClick={() => void browserAction(true)}>{t("settings.localServices.browserStop")}</Button>
            </div>
          </div> : <details className="local-services-examples">
            <summary>{t("settings.localServices.usage")}</summary>
            <h3>{t("settings.localServices.authTitle")}</h3>
            <p>{t("settings.localServices.authNote")}</p>
            <p>{t("settings.localServices.exampleNote")}</p>
            {examples ? ([
              [t("settings.localServices.httpExample"), examples.http],
              [t("settings.localServices.wsExample"), examples.websocket]
            ] as const).map(([label, code]) => <div className="local-services-example" key={label}>
              <div className="local-services-example-header">
                <h3>{label}</h3>
                <Button type="text" icon={<CopyOutlined />} onClick={() => void copy(code)}
                  aria-label={`${t("settings.localServices.copyExample")}: ${label}`}>{t("settings.localServices.copyExample")}</Button>
              </div>
              <pre><code>{code}</code></pre>
            </div>) : <p>{t("settings.localServices.unavailable")}</p>}
            <p>{t("settings.localServices.protocolNote")}</p>
          </details>}
          <Button onClick={() => navigate(`${buildSettingsSectionPath("control")}?serviceId=${id}`)}>
            {t("settings.localServices.manage")}
          </Button>
        </div>
      </section>;
    })}
  </div>;
}
