import { useEffect, useState } from "react";
import { Button, Tag } from "antd";
import { CopyOutlined, GlobalOutlined, SettingOutlined } from "@ant-design/icons";
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
  const { services, loading, error } = useServices();
  const [browser, setBrowser] = useState<BrowserWebclientState>({ running: false, url: "" });
  const [browserLoading, setBrowserLoading] = useState(true);
  const [copyingExample, setCopyingExample] = useState(false);
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
      } finally { if (live) setBrowserLoading(false); }
    };
    void update();
    const remove = window.electronAPI.onServicesChanged(() => void update());
    window.addEventListener("focus", update);
    return () => { live = false; remove(); window.removeEventListener("focus", update); };
  }, [browserRevision, t]);
  async function browserAction(action: "start" | "stop" | "open") {
    setBrowserBusy(true);
    try {
      const result = await (action === "stop" ? window.electronAPI.services.stopBrowserWebclient() : action === "start" ? window.electronAPI.services.startBrowserWebclient() : window.electronAPI.services.openBrowserWebclient());
      setBrowser({ running: result.running, url: result.url });
      setBrowserError("");
      setFeedback({ id: Date.now(), tone: result.ok ? "success" : "error", message: result.ok
        ? t(action === "stop" ? "settings.localServices.browserStopped" : action === "start" ? "settings.localServices.browserStarted" : "settings.localServices.browserOpened")
        : result.message || t("settings.localServices.browserOpenFailed") });
    } catch {
      setFeedback({ id: Date.now(), tone: "error", message: t("settings.localServices.browserOpenFailed") });
    } finally { setBrowserBusy(false); setBrowserRevision(value => value + 1); }
  }
  const platformReady = !error && !loading && services.some(service => service.id === "agent-platform" && service.status === "running");
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

  async function copyExample(baseUrl: string, kind: "http" | "websocket") {
    setCopyingExample(true);
    try {
      const result = await window.electronAPI.agentAuth.issueAccessToken("missing");
      if (!result.ok || !result.token) throw new Error("Token unavailable");
      const examples = platformConnectionExamples(baseUrl, isWindows, result.token);
      const copied = await window.electronAPI.clipboard.writeText(examples[kind]);
      if (!copied.ok) throw new Error("Copy failed");
      setFeedback({ id: Date.now(), tone: "success", message: t("settings.localServices.exampleCopied", {
        expires: new Date(examples.expiresAtMs!).toLocaleString()
      }) });
    } catch {
      setFeedback({ id: Date.now(), tone: "error", message: t("settings.localServices.exampleCopyFailed") });
    } finally { setCopyingExample(false); }
  }

  function address(label: string, value: string) {
    return <div className="local-services-address">
      <span>{label}</span>
      <code>{value || t("settings.localServices.unavailable")}</code>
      <Button type="text" icon={<CopyOutlined />} disabled={!value} onClick={() => void copy(value)}
        title={t("settings.localServices.copyAddress")} aria-label={`${t("settings.localServices.copyAddress")}: ${label}`} />
    </div>;
  }

  return <div className="local-services-settings">
    <PageFeedbackStack items={feedback ? [{ ...feedback, onDismiss: () => setFeedback(null) }] : []} />
    {error ? <p role="alert" className="settings-section-read-error">{error}</p> : null}
    {(["agent-webclient", "agent-platform"] as const).map((id) => {
      const service = services.find((entry) => entry.id === id);
      const baseUrl = localServiceBaseUrl(service);
      const dependenciesReady = platformReady && service?.status === "running";
      const platform = id === "agent-platform";
      const examples = platform && baseUrl ? platformConnectionExamples(baseUrl, isWindows) : null;
      return <section className="settings-item-card local-services-card" key={id} aria-labelledby={`${id}-access-title`}>
        <header className="settings-item-header">
          <div className="local-services-heading">
            <h2 id={`${id}-access-title`}>{t(platform ? "settings.localServices.platform" : "settings.localServices.webclient")}</h2>
            <Tag color={(platform ? !error && service?.status === "running" : !browserError && browser.running) ? "success" : "default"}>
              {platform
                ? loading ? t("common.loading") : error || !service ? t("settings.localServices.unknown") : t(STATUS_KEYS[service.status])
                : browserLoading ? t("common.loading") : browserError ? t("settings.localServices.unknown") : t(browser.running ? "controlCenter.status.running" : "controlCenter.status.stopped")}
            </Tag>
          </div>
          <div className="local-services-actions">
            {!platform ? <>
              <Button type={browser.running ? "default" : "primary"} loading={browserBusy}
                disabled={browserLoading || (!browser.running && !dependenciesReady)}
                onClick={() => void browserAction(browser.running ? "stop" : "start")}>
                {t(browser.running ? "settings.localServices.browserStop" : "settings.localServices.browserStart")}
              </Button>
              <Button icon={<GlobalOutlined />} disabled={!browser.running || browserBusy || !dependenciesReady}
                onClick={() => void browserAction("open")}>{t("settings.localServices.browserOpen")}</Button>
            </> : null}
            <Button type="text" icon={<SettingOutlined />} title={t("settings.localServices.manage")}
              aria-label={t("settings.localServices.manage")} onClick={() => navigate(`${buildSettingsSectionPath("control")}?serviceId=${id}`)} />
          </div>
        </header>
        <div className="local-services-body">
          {platform ? address(t("settings.localServices.httpAddress"), baseUrl)
            : address(t("settings.localServices.browserAddress"), browser.url || "http://127.0.0.1:7081")}
          {platform && service?.status !== "running" && service?.message ? <p>{service.message}</p> : null}
          {!platform ? <>
            {browserError ? <p role="alert">{browserError}</p> : null}
            {!loading && !error && !dependenciesReady ? <p>{t("settings.localServices.browserDependencies")}</p> : null}
          </> : <details className="local-services-examples">
            <summary>{t("settings.localServices.usage")}</summary>
            {address(t("settings.localServices.wsAddress"), examples?.wsUrl || "")}
            <p>{t("settings.localServices.exampleNote")}</p>
            {examples ? ([
              [t("settings.localServices.httpExample"), examples.http, "http"],
              [t("settings.localServices.wsExample"), examples.websocket, "websocket"]
            ] as const).map(([label, code, kind]) => <div className="local-services-example" key={label}>
              <div className="local-services-example-header">
                <h3>{label}</h3>
                <Button type="text" icon={<CopyOutlined />} loading={copyingExample} disabled={!platformReady} onClick={() => void copyExample(baseUrl, kind)}
                  aria-label={`${t("settings.localServices.copyExample")}: ${label}`}>{t("settings.localServices.copyExample")}</Button>
              </div>
              <pre><code>{code}</code></pre>
            </div>) : <p>{t("settings.localServices.unavailable")}</p>}
          </details>}
        </div>
      </section>;
    })}
  </div>;
}
