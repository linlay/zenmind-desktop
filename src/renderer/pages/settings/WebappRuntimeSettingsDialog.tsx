import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Input, Modal, Select, Spin, Tabs } from "antd";
import type { WebappEntry, WebappRuntimeSettings } from "../../../shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import "./WebappRuntimeSettingsDialog.css";

type RuntimeName = Extract<NonNullable<WebappEntry["backend"]>["command"], { type: "runtime" }>["runtime"];

// Keep runtime choices in one place; the application page always has one settings entry.
const RUNTIME_OPTIONS: { key: RuntimeName; label: string }[] = [
  { key: "java", label: "Java" },
  { key: "python", label: "Python" }
];

export function getWebappRuntimeLabel(runtime: string) {
  return RUNTIME_OPTIONS.find((item) => item.key === runtime)?.label ?? runtime;
}

function runtimeApps(items: WebappEntry[], runtime: RuntimeName) {
  return items.filter((item) => item.backend?.command.type === "runtime" && item.backend.command.runtime === runtime);
}

export function WebappRuntimeSettingsDialog({
  items,
  initialWebappId,
  isWindows,
  isMac,
  onClose,
  onSaved
}: {
  items: WebappEntry[];
  initialWebappId?: string;
  isWindows: boolean;
  isMac: boolean;
  onClose: () => void;
  onSaved: (settings: WebappRuntimeSettings, webappId: string) => void;
}) {
  const { t } = useI18n();
  const initialApp = items.find((item) => item.id === initialWebappId);
  const initialRuntime = initialApp?.backend?.command.type === "runtime" ? initialApp.backend.command.runtime : "java";
  const [runtime, setRuntime] = useState<RuntimeName>(initialRuntime);
  const [selectedAppId, setSelectedAppId] = useState(initialWebappId ?? "");
  const [settings, setSettings] = useState<WebappRuntimeSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const mountedRef = useRef(true);
  const triggerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const apps = runtimeApps(items, runtime);
  const selectedApp = apps.find((item) => item.id === selectedAppId) ?? apps[0] ?? null;
  const bindingKey = selectedApp ? `${selectedApp.id}:${runtime}` : "";
  const executablePath = bindingKey ? drafts[bindingKey] ?? settings?.runtimeExecutables[bindingKey] ?? "" : "";
  const runtimeLabel = getWebappRuntimeLabel(runtime);
  const command = selectedApp?.backend?.command;
  const minimumVersion = command?.type === "runtime" ? command.minimumVersion : undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReadError("");
    void window.electronAPI.webs.webapps.getRuntimeSettings()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.message);
        setSettings(result.settings);
      })
      .catch((reason) => {
        if (!cancelled) setReadError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [readRevision]);

  function isAbsoluteExecutablePath(value: string) {
    if (isWindows) {
      const windowsPath = value.replace(/\//gu, "\\");
      return /^[a-zA-Z]:\\/u.test(windowsPath) || /^\\\\[^\\]+\\[^\\]+/u.test(windowsPath);
    }
    if (isMac) {
      return value.startsWith("/");
    }
    return value.startsWith("/");
  }

  function close() {
    onClose();
    // This dialog unmounts to discard drafts; restore focus after React removes its portal.
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected && document.activeElement === document.body) {
        trigger.focus({ preventScroll: true });
      }
    });
  }

  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedApp || loading || saving || readError || !settings) return;
    const nextPath = executablePath.trim();
    if (nextPath && !isAbsoluteExecutablePath(nextPath)) {
      setSaveError(t("settings.webapps.runtimePathInvalid"));
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      // The API replaces the map. Read fresh settings and change only this app's binding.
      const latest = await window.electronAPI.webs.webapps.getRuntimeSettings();
      if (!latest.ok) throw new Error(latest.message);
      const runtimeExecutables = { ...latest.settings.runtimeExecutables };
      if (nextPath) runtimeExecutables[bindingKey] = nextPath;
      else delete runtimeExecutables[bindingKey];
      const result = await window.electronAPI.webs.webapps.saveRuntimeSettings({ runtimeExecutables });
      if (!result.ok) throw new Error(result.message);
      if (!mountedRef.current) return;
      onSaved(result.settings, selectedApp.id);
      close();
    } catch (reason) {
      if (mountedRef.current) setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  const panel = (
    <form id="webapp-runtime-settings-form" className="webapp-runtime-form" onSubmit={(event) => void save(event)}>
      <div className="webapp-runtime-heading">
        <h2>{t("settings.webapps.runtimeLanguageTitle", { runtime: runtimeLabel })}</h2>
        <p>{t("settings.webapps.runtimeLanguageDescription", { runtime: runtimeLabel })}</p>
      </div>
      {loading ? (
        <div className="webapp-runtime-loading" role="status"><Spin size="small" />{t("settings.webapps.runtimeSettingsLoading")}</div>
      ) : readError ? (
        <div className="webapp-runtime-read-error">
          <Alert type="error" showIcon message={readError} />
          <Button onClick={() => setReadRevision((current) => current + 1)}>{t("settings.webapps.runtimeSettingsRetry")}</Button>
        </div>
      ) : selectedApp ? (
        <>
          <div className="webapp-runtime-field">
            <label htmlFor="webapp-runtime-app">{t("settings.webapps.runtimeApp")}</label>
            <Select
              id="webapp-runtime-app"
              value={selectedApp.id}
              disabled={saving}
              options={apps.map((item) => ({ value: item.id, label: item.label }))}
              onChange={(id) => { setSelectedAppId(id); setSaveError(""); }}
              aria-label={t("settings.webapps.runtimeApp")}
            />
          </div>
          <div className="webapp-runtime-field">
            <label htmlFor="webapp-runtime-path">{t("settings.webapps.runtimeExecutable")}</label>
            <Input
              id="webapp-runtime-path"
              className="webapp-runtime-path"
              value={executablePath}
              disabled={saving}
              placeholder={isWindows
                ? (runtime === "java" ? "C:\\Program Files\\Java\\jdk\\bin\\java.exe" : "C:\\Python\\python.exe")
                : (runtime === "java" ? "/path/to/jdk/bin/java" : "/path/to/python/bin/python3")}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((current) => ({ ...current, [bindingKey]: value }));
                setSaveError("");
              }}
              aria-describedby="webapp-runtime-path-hint"
            />
            <p id="webapp-runtime-path-hint">{t("settings.webapps.runtimePathHint")}</p>
            {minimumVersion ? <p>{t("settings.webapps.runtimeMinimumVersion", { runtime: runtimeLabel, version: minimumVersion })}</p> : null}
          </div>
          <p className="webapp-runtime-restart-hint">{t("settings.webapps.runtimeRestartHint")}</p>
          {saveError ? <Alert type="error" showIcon message={saveError} /> : null}
        </>
      ) : (
        <div className="webapp-runtime-empty">
          <strong>{t("settings.webapps.runtimeEmpty", { runtime: runtimeLabel })}</strong>
          <p>{t("settings.webapps.runtimeEmptyHint")}</p>
        </div>
      )}
    </form>
  );

  return (
    <Modal
      open
      className="webapp-runtime-dialog"
      title={t("settings.webapps.runtimeSettingsAction")}
      centered
      width={640}
      maskClosable={!saving}
      closable={!saving}
      keyboard={!saving}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
      onCancel={close}
      footer={[
        <Button key="cancel" disabled={saving} onClick={close}>{t("settings.websites.cancel")}</Button>,
        ...(selectedApp ? [
          <Button key="save" type="primary" htmlType="submit" form="webapp-runtime-settings-form" loading={saving} disabled={loading || !!readError || !settings}>
            {t("settings.webapps.runtimeSettingsSave")}
          </Button>
        ] : [])
      ]}
    >
      <Tabs
        activeKey={runtime}
        destroyOnHidden
        onChange={(key) => {
          setRuntime(key as RuntimeName);
          setSelectedAppId("");
          setSaveError("");
        }}
        items={RUNTIME_OPTIONS.map((item) => ({ key: item.key, label: item.label, disabled: saving, children: item.key === runtime ? panel : null }))}
      />
    </Modal>
  );
}
