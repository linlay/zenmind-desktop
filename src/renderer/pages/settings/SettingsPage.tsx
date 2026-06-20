import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Card, Checkbox, Form, Input, InputNumber, QRCode, Segmented, Select, Space, Switch, Typography } from "antd";
import { useLocation, useParams } from "react-router-dom";
import { PageFeedbackStack } from "../../components/PageFeedbackStack";
import "./SettingsPage.css";
import type {
  AssistantMemoryItem,
  AssistantMemorySettings,
  AssistantMemorySummary,
  AssistantMemoryStorage,
  AssistantMemoryStats,
  AssistantNavAgentItem,
  AssistantSettingsPublic,
  WebsiteEntry,
  DesktopAppPairingPayloadResult,
  DesktopAppInfo,
  DesktopGeneralSettings,
  DesktopWsProbeResult,
  DesktopPetAgentOption,
  DesktopPetState,
  DesktopRuntimeEnvResetResult,
  DesktopWsServerState,
  IdentityAccessTokenInspection,
  MarketSettings,
  TaskBoardCloudConfig,
  TaskBoardDesktopOnlineResult,
  TaskBoardProject,
  TunnelDebugSnapshot,
  TunnelHubSettings
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  DESKTOP_COPILOT_PAGE_KEYS,
  createDefaultDesktopCopilotPagePreferences,
  type DesktopCopilotPageKey,
  type DesktopCopilotPagePreferences
} from "../../../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../../../shared/page-copilot";
import { getAssistantPageContext } from "../../copilot/page-context/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "../../services/currentPageContext";
import { registerDesktopActionProvider } from "../../services/desktopActionRegistry";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS
} from "../../../shared/desktop-pet";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_REMOTE_WS_URL,
  DESKTOP_WS_URL
} from "../../../shared/desktop-ws";
import {
  buildLocalizedSettingsSections,
  getVisibleSettingsSections,
  type SettingsSectionId
} from "../../settingsPageSections";
import { resolveSettingsSectionId } from "../../settings/settingsRoutes";
import type { SidebarNavOrderItem, SidebarNavOrderItemKey } from "../../app-shell/navigation/sidebarNavOrder";
import { useI18n } from "../../i18n/useI18n";
import type { SupportedLocale, TranslateFunction, TranslationKey } from "../../../shared/i18n";

type ThemePreference = "light" | "dark" | "system";
type TaskBoardConnectionState = "disabled" | "connecting" | "open" | "closed" | "error";

type SettingsPageProps = {
  themeMode: ThemePreference;
  onThemeModeChange: (themeMode: ThemePreference) => void;
  isMac: boolean;
  isWindows: boolean;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  availableSidebarNavOrderItems: SidebarNavOrderItem[];
  onSidebarNavOrderChange: (order: SidebarNavOrderItemKey[]) => void;
  marketEnabled: boolean;
  onMarketEnabledChange?: (enabled: boolean) => void;
  websiteItems: WebsiteEntry[];
  onWebsiteItemsChange: (items: WebsiteEntry[]) => void;
  onAssistantSettingsChange?: (settings: AssistantSettingsPublic) => void;
  debugVisible: boolean;
};

type NoticeTone = "success" | "error";

type SettingsNotice = {
  id: number;
  sectionId: SettingsSectionId;
  tone: NoticeTone;
  message: string;
};

type SectionReadErrorMap = Partial<Record<SettingsSectionId, string>>;

type AboutAppCardProps = {
  runtimeResetPending: boolean;
  runtimeResetResult: DesktopRuntimeEnvResetResult | null;
  onResetRuntimeEnv: () => void | Promise<void>;
};

const THEME_PREFERENCE_OPTIONS: ThemePreference[] = ["light", "dark", "system"];

function getThemePreferenceLabel(themeMode: ThemePreference, t: TranslateFunction) {
  switch (themeMode) {
    case "light":
      return t("settings.appearance.light");
    case "dark":
      return t("settings.appearance.dark");
    default:
      return t("settings.appearance.system");
  }
}

function getTaskBoardProjectOptionLabel(project: TaskBoardProject) {
  const path = project.path.trim();
  if (path && path !== project.name) {
    return `${project.name} · ${path}`;
  }
  return project.name;
}

function sortTaskBoardProjectOptions(projects: TaskBoardProject[]) {
  return [...projects]
    .filter((project) => project.id.trim())
    .sort((left, right) => {
      const leftLabel = left.path || left.name || left.id;
      const rightLabel = right.path || right.name || right.id;
      return leftLabel.localeCompare(rightLabel, "zh-Hans-CN");
    });
}

function formatPairingExpiresAt(value: string, locale: SupportedLocale) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function ThemePreferenceIcon({ themeMode }: { themeMode: ThemePreference }) {
  if (themeMode === "light") {
    return <SunOutlined aria-hidden="true" />;
  }
  if (themeMode === "dark") {
    return <MoonOutlined aria-hidden="true" />;
  }
  return <DesktopOutlined aria-hidden="true" />;
}

function getLocaleLabel(nextLocale: SupportedLocale, t: TranslateFunction) {
  return nextLocale === "zh-CN" ? t("settings.language.zhCN") : t("settings.language.enUS");
}

const SETTINGS_ACTION_PATCH_FIELDS = [
  "desktopHelperAgentKey",
  "quickAssistantEnabled",
  "quickAssistantAgentKey",
  "desktopCopilotPages"
] as const;
const ASSISTANT_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "navigation",
  "assistant",
  "embeddedWebs"
];

const defaultTaskBoardCloudConfig: TaskBoardCloudConfig = {
  serverUrl: "",
  token: "",
  selectedProjectId: "default",
  remoteControlEnabled: false,
  deviceAlias: ""
};

const defaultTaskBoardOnlineSummary: TaskBoardDesktopOnlineResult = {
  ok: false,
  online: false,
  deviceCount: 0,
  sessionCount: 0,
  agentCount: 0,
  devices: []
};

const defaultGeneralSettings: DesktopGeneralSettings = {
  preventSleepWhileRunning: true,
  desktopWsServerEnabled: false
};

function createFallbackDesktopWsServerState(message?: string): DesktopWsServerState {
  return {
    enabled: false,
    running: false,
    host: DESKTOP_WS_HOST,
    port: DESKTOP_WS_PORT,
    path: DESKTOP_WS_PATH,
    url: DESKTOP_WS_URL,
    ...(message ? { message } : {})
  };
}

const defaultTunnelHubSettings: TunnelHubSettings = {
  enabled: false,
  relayUrl: "",
  deviceId: "",
  hasRelayToken: false,
  relayTokenPreview: "",
  hasRegistrationToken: false,
  registrationTokenPreview: "",
  publicHost: "",
  publicUrl: "",
  webSocketUrl: "",
  targetUrl: "",
  tlsInsecureSkipVerify: false,
  reconnectSeconds: 3
};
function isMarketVisible(settings: MarketSettings) {
  return settings.enabled === true;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toAssistantAgentOptions(items: AssistantNavAgentItem[]): DesktopPetAgentOption[] {
  return items.map((agent) => ({
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    role: agent.role,
    icon: agent.icon,
    unreadCount: agent.unreadCount
  }));
}

function readAssistantAgentOptions(
  copilotResult: Awaited<ReturnType<NonNullable<typeof window.electronAPI>["assistant"]["listCopilotAgents"]>>,
  fallbackAgents: DesktopPetAgentOption[]
) {
  if (copilotResult.ok) {
    const copilotAgents = toAssistantAgentOptions(Array.isArray(copilotResult.items) ? copilotResult.items : []);
    if (copilotAgents.length > 0) {
      return copilotAgents;
    }
  }
  return Array.isArray(fallbackAgents) ? fallbackAgents : [];
}

function buildSettingsActionPatch(
  args: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const patchRecord = asRecord(args.patch);
  const fields = args.fields;
  const fieldRecord = Array.isArray(fields)
    ? fields.reduce<Record<string, unknown>>((accumulator, item) => {
        const node = asRecord(item);
        const fieldName = typeof node.name === "string"
          ? node.name.trim()
          : typeof node.field === "string"
            ? node.field.trim()
            : typeof node.key === "string"
              ? node.key.trim()
              : "";
        if (!fieldName) {
          return accumulator;
        }
        accumulator[fieldName] = node.value;
        return accumulator;
      }, {})
    : asRecord(fields);

  for (const fieldName of SETTINGS_ACTION_PATCH_FIELDS) {
    if (fieldName in patchRecord) {
      patch[fieldName] = patchRecord[fieldName];
      continue;
    }
    if (fieldName in fieldRecord) {
      patch[fieldName] = fieldRecord[fieldName];
      continue;
    }
    if (fieldName in args) {
      patch[fieldName] = args[fieldName];
    }
  }

  return patch;
}

function getCopilotPageKeyForSidebarNavOrderItem(itemKey: SidebarNavOrderItemKey): DesktopCopilotPageKey | null {
  if (itemKey === "schedules") {
    return "schedules";
  }
  return null;
}

function getDesktopCopilotPageLabel(pageKey: DesktopCopilotPageKey, t: TranslateFunction) {
  switch (pageKey) {
    case "controlCenter":
      return t("nav.controlCenter");
    case "market":
      return t("nav.market");
    case "help":
      return t("nav.help");
    case "agents":
      return t("nav.agents");
    case "schedules":
      return t("nav.schedules");
    case "memory":
      return t("nav.memory");
    default:
      return pageKey;
  }
}

function getFixedAssistantLabelForSidebarNavOrderItem(itemKey: SidebarNavOrderItemKey, t: TranslateFunction): string | null {
  if (itemKey === "kanban") {
    return t("settings.reservedEntry");
  }
  if (itemKey === "group:assistants" || itemKey === "group:webs") {
    return t("nav.group.fixedEntry");
  }
  if (itemKey.startsWith("custom:")) {
    return t("settings.configuredInEmbeddedWebs");
  }
  if (itemKey.startsWith("service:")) {
    return t("settings.servicePageDefault");
  }
  if (itemKey.startsWith("experimental:")) {
    return t("settings.externalPageDefault");
  }
  return null;
}

type FixedNavigationToolConfig = {
  id: string;
  labelKey: TranslationKey;
  copilotPageKey: DesktopCopilotPageKey | null;
  fixedAssistantLabelKey?: TranslationKey;
};

const fixedNavigationToolRows: FixedNavigationToolConfig[][] = [
  [
    { id: "agents", labelKey: "nav.agents", copilotPageKey: "agents" },
    { id: "market", labelKey: "nav.market", copilotPageKey: "market" }
  ],
  [
    { id: "controlCenter", labelKey: "nav.controlCenter", copilotPageKey: "controlCenter" },
    { id: "settings", labelKey: "nav.settings", copilotPageKey: null, fixedAssistantLabelKey: "settings.defaultAssistant" },
    { id: "help", labelKey: "nav.help", copilotPageKey: "help" }
  ]
];

const fixedNavigationTools = fixedNavigationToolRows.flat();

function formatMemoryTime(value: string | null | undefined, locale: SupportedLocale, t: TranslateFunction) {
  if (!value) {
    return t("common.none");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t("common.none");
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatMemoryStatus(value: AssistantMemoryItem["status"], t: TranslateFunction) {
  switch (value) {
    case "active":
      return t("settings.memory.statusActive");
    case "open":
      return t("settings.memory.statusOpen");
    case "archived":
      return t("settings.memory.statusArchived");
    default:
      return value;
  }
}

function formatMemoryPreview(summary: string, maxLength = 88) {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function formatMemoryAuditSummary(summary: AssistantMemorySummary["recentAudit"], t: TranslateFunction) {
  if (!summary) {
    return t("settings.memory.noActivity");
  }
  return [summary.operation, summary.status, summary.reason].filter(Boolean).join(" / ");
}

function getDesktopPetAppearanceLabel(appearanceId: string, fallback: string, t: TranslateFunction) {
  switch (appearanceId) {
    case "classic":
      return t("settings.desktopPet.appearance.classic.label");
    case "dario":
      return t("settings.desktopPet.appearance.dario.label");
    case "sama":
      return t("settings.desktopPet.appearance.sama.label");
    case "xiao":
      return t("settings.desktopPet.appearance.xiao.label");
    case "pony":
      return t("settings.desktopPet.appearance.pony.label");
    default:
      return fallback;
  }
}

function getDesktopPetAppearanceDescription(appearanceId: string, fallback: string, t: TranslateFunction) {
  switch (appearanceId) {
    case "classic":
      return t("settings.desktopPet.appearance.classic.description");
    case "dario":
      return t("settings.desktopPet.appearance.dario.description");
    case "sama":
      return t("settings.desktopPet.appearance.sama.description");
    case "xiao":
      return t("settings.desktopPet.appearance.xiao.description");
    case "pony":
      return t("settings.desktopPet.appearance.pony.description");
    default:
      return fallback;
  }
}

function WindowsDataRootCard() {
  const { t } = useI18n();
  const [dataRoot, setDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);
  const [dataRootError, setDataRootError] = useState("");

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.settings
      .getDataRoot()
      .then((root) => {
        if (!cancelled) {
          setDataRoot(root);
          setDataRootError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setDataRootError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDataRootLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="data-root-card">
      <div>
        <h2>{t("settings.dataRoot.label")}</h2>
        <p className="page-copy">
          {t("settings.dataRoot.storageDescription")}
        </p>
      </div>
      {dataRootError ? (
        <div className="feedback-banner warning-banner settings-section-read-error" role="alert">
          {dataRootError}
        </div>
      ) : null}
      <div className="data-root-actions">
        <div className="data-root-path">{dataRootLoading ? t("settings.dataRoot.loading") : dataRoot || t("settings.dataRoot.unset")}</div>
      </div>
    </div>
  );
}

function formatDebugJson(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDebugValue(value: unknown, fallback: string) {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function DesktopLogsDebugCard() {
  const { t } = useI18n();
  const [pendingAction, setPendingAction] = useState<"main" | "error" | "folder" | null>(null);
  const [message, setMessage] = useState("");

  async function handleOpenDesktopLog(target: "main" | "error") {
    setPendingAction(target);
    setMessage("");
    try {
      const result = await window.electronAPI.diagnostics.openDesktopLogViewer(target);
      setMessage(result.ok ? t("settings.debug.logs.opened") : t("settings.debug.logs.failed"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRevealDesktopLogFolder() {
    setPendingAction("folder");
    setMessage("");
    try {
      const result = await window.electronAPI.diagnostics.revealDesktopLogFolder();
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="data-root-card settings-debug-panel">
      <div className="settings-debug-panel-head">
        <h2>{t("settings.debug.logs.title")}</h2>
      </div>
      <div className="settings-debug-actions">
        <Button disabled={pendingAction !== null} onClick={() => void handleOpenDesktopLog("main")}>
          {pendingAction === "main" ? t("common.loading") : t("settings.debug.logs.openMain")}
        </Button>
        <Button disabled={pendingAction !== null} onClick={() => void handleOpenDesktopLog("error")}>
          {pendingAction === "error" ? t("common.loading") : t("settings.debug.logs.openError")}
        </Button>
        <Button disabled={pendingAction !== null} onClick={() => void handleRevealDesktopLogFolder()}>
          {pendingAction === "folder" ? t("common.loading") : t("settings.debug.logs.openFolder")}
        </Button>
      </div>
      {message ? (
        <div className="feedback-banner settings-desktop-ws-message" role="status">
          {message}
        </div>
      ) : null}
    </div>
  );
}

function IdentityTokenDebugCard() {
  const { t } = useI18n();
  const [inspection, setInspection] = useState<IdentityAccessTokenInspection | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function handleInspectToken(reason: "missing" | "unauthorized" = "missing") {
    setPending(true);
    setMessage("");
    try {
      const result = await window.electronAPI.diagnostics.inspectIdentityAccessToken({ reason });
      setInspection(result);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function handleCopy(text: string) {
    if (!text) {
      return;
    }
    await window.electronAPI.clipboard.writeText(text);
  }

  const payloadJson = inspection?.payload ? formatDebugJson(inspection.payload) : "";
  const headerJson = inspection?.header ? formatDebugJson(inspection.header) : "";

  return (
    <div className="data-root-card settings-debug-panel">
      <div className="settings-debug-panel-head">
        <h2>{t("settings.debug.identity.title")}</h2>
        <span className={`settings-desktop-ws-status ${inspection?.ok ? "is-running" : inspection ? "is-error" : "is-closed"}`}>
          {inspection?.ok ? t("settings.debug.identity.valid") : inspection ? t("settings.debug.identity.invalid") : t("settings.debug.identity.idle")}
        </span>
      </div>
      <div className="settings-debug-actions">
        <Button type="primary" disabled={pending} onClick={() => void handleInspectToken("missing")}>
          {pending ? t("common.loading") : t("settings.debug.identity.issue")}
        </Button>
        <Button disabled={pending} onClick={() => void handleInspectToken("unauthorized")}>
          {t("settings.debug.identity.refresh")}
        </Button>
        <Button disabled={!inspection?.token} onClick={() => void handleCopy(inspection?.token || "")}>
          {t("settings.debug.identity.copyToken")}
        </Button>
        <Button disabled={!payloadJson} onClick={() => void handleCopy(payloadJson)}>
          {t("settings.debug.identity.copyPayload")}
        </Button>
      </div>
      {message ? (
        <div className={`feedback-banner settings-desktop-ws-message${inspection && !inspection.ok ? " warning-banner" : ""}`} role="status">
          {message}
        </div>
      ) : null}
      {inspection ? (
        <div className="settings-debug-grid">
          <dl className="settings-debug-facts">
            <div>
              <dt>{t("settings.debug.identity.deviceId")}</dt>
              <dd>{formatDebugValue(inspection.claims.deviceId, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.scope")}</dt>
              <dd>{formatDebugValue(inspection.claims.scope, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.subject")}</dt>
              <dd>{formatDebugValue(inspection.claims.subject, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.issuer")}</dt>
              <dd>{formatDebugValue(inspection.claims.issuer, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.audience")}</dt>
              <dd>{formatDebugValue(inspection.claims.audience, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.expiresAt")}</dt>
              <dd>{formatDebugValue(inspection.claims.expiresAt, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.issuedAt")}</dt>
              <dd>{formatDebugValue(inspection.claims.issuedAt, t("settings.debug.empty"))}</dd>
            </div>
            <div>
              <dt>{t("settings.debug.identity.expired")}</dt>
              <dd>{inspection.claims.expired ? t("common.yes") : t("common.no")}</dd>
            </div>
          </dl>
          <label className="settings-debug-field">
            <span>{t("settings.debug.identity.token")}</span>
            <textarea value={inspection.token} readOnly spellCheck={false} />
          </label>
          <label className="settings-debug-field">
            <span>{t("settings.debug.identity.header")}</span>
            <textarea value={headerJson} readOnly spellCheck={false} />
          </label>
          <label className="settings-debug-field">
            <span>{t("settings.debug.identity.payload")}</span>
            <textarea value={payloadJson} readOnly spellCheck={false} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function TunnelDebugCard() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<TunnelDebugSnapshot | null>(null);
  const [probeResult, setProbeResult] = useState<DesktopWsProbeResult | null>(null);
  const [pending, setPending] = useState<"snapshot" | "localDebug" | "remoteUpstream" | null>(null);
  const [message, setMessage] = useState("");

  async function handleRefreshSnapshot() {
    setPending("snapshot");
    setMessage("");
    try {
      const result = await window.electronAPI.diagnostics.getTunnelDebugSnapshot();
      setSnapshot(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  async function handleProbe(target: "localDebug" | "remoteUpstream") {
    setPending(target);
    setMessage("");
    try {
      const result = await window.electronAPI.diagnostics.probeDesktopWs({ target });
      setProbeResult(result);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    void handleRefreshSnapshot();
  }, []);

  const status = snapshot?.status;

  return (
    <div className="data-root-card settings-debug-panel">
      <div className="settings-debug-panel-head">
        <h2>{t("settings.debug.tunnel.title")}</h2>
        <span className={`settings-desktop-ws-status ${status?.connected ? "is-running" : status?.phase === "error" ? "is-error" : pending === "snapshot" ? "is-pending" : "is-closed"}`}>
          {pending === "snapshot" ? t("common.loading") : status?.phase || t("settings.debug.tunnel.unknown")}
        </span>
      </div>
      <dl className="settings-debug-facts">
        <div>
          <dt>{t("settings.debug.tunnel.deviceId")}</dt>
          <dd>{formatDebugValue(status?.deviceId, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.connected")}</dt>
          <dd>{status?.connected ? t("common.yes") : t("common.no")}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.targetUrl")}</dt>
          <dd>{formatDebugValue(status?.targetUrl, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.publicUrl")}</dt>
          <dd>{formatDebugValue(status?.publicUrl, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.webSocketUrl")}</dt>
          <dd>{formatDebugValue(status?.webSocketUrl, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.lastRegisteredAt")}</dt>
          <dd>{formatDebugValue(status?.lastRegisteredAt, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.lastConnectedAt")}</dt>
          <dd>{formatDebugValue(status?.lastConnectedAt, t("settings.debug.empty"))}</dd>
        </div>
        <div>
          <dt>{t("settings.debug.tunnel.lastError")}</dt>
          <dd>{formatDebugValue(status?.lastError, t("settings.debug.empty"))}</dd>
        </div>
      </dl>
      <div className="settings-debug-actions">
        <Button disabled={pending !== null} onClick={() => void handleRefreshSnapshot()}>
          {t("settings.debug.tunnel.refresh")}
        </Button>
        <Button disabled={pending !== null} onClick={() => void handleProbe("localDebug")}>
          {pending === "localDebug" ? t("common.loading") : t("settings.debug.tunnel.probeLocal")}
        </Button>
        <Button disabled={pending !== null} onClick={() => void handleProbe("remoteUpstream")}>
          {pending === "remoteUpstream" ? t("common.loading") : t("settings.debug.tunnel.probeRemote")}
        </Button>
      </div>
      <div className="settings-debug-probe-targets">
        <code>{DESKTOP_WS_URL}</code>
        <code>{DESKTOP_REMOTE_WS_URL}</code>
      </div>
      {message ? (
        <div className={`feedback-banner settings-desktop-ws-message${probeResult && !probeResult.ok ? " warning-banner" : ""}`} role="status">
          {message}
        </div>
      ) : null}
      {probeResult ? (
        <label className="settings-debug-field">
          <span>{t("settings.debug.tunnel.probeResult")}</span>
          <textarea value={formatDebugJson(probeResult)} readOnly spellCheck={false} />
        </label>
      ) : null}
    </div>
  );
}

function LocalWsServerDebugCard() {
  const { t } = useI18n();
  const [desktopWsServerState, setDesktopWsServerState] = useState<DesktopWsServerState | null>(null);
  const [desktopWsServerPending, setDesktopWsServerPending] = useState<"open" | "close" | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.settings
      .getDesktopWsServerState()
      .then((state) => {
        if (!cancelled) {
          setDesktopWsServerState(state);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDesktopWsServerState(createFallbackDesktopWsServerState(error instanceof Error ? error.message : String(error)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const desktopWsServerStatus = useMemo(() => {
    if (desktopWsServerPending === "open") {
      return t("settings.debug.desktopWs.opening");
    }
    if (desktopWsServerPending === "close") {
      return t("settings.debug.desktopWs.closing");
    }
    if (desktopWsServerState === null) {
      return t("common.loading");
    }
    if (desktopWsServerState.running) {
      return t("settings.debug.desktopWs.open");
    }
    if (desktopWsServerState.enabled && desktopWsServerState.message) {
      return t("settings.debug.desktopWs.failed");
    }
    return t("settings.debug.desktopWs.closed");
  }, [desktopWsServerPending, desktopWsServerState, t]);
  const desktopWsServerStatusClass = desktopWsServerPending
    ? "is-pending"
    : desktopWsServerState?.running
      ? "is-running"
      : desktopWsServerState?.enabled && desktopWsServerState.message
        ? "is-error"
        : "is-closed";
  const desktopWsServerUrl = desktopWsServerState?.url || DESKTOP_WS_URL;

  async function handleSetDesktopWsServerEnabled(enabled: boolean) {
    setDesktopWsServerPending(enabled ? "open" : "close");
    try {
      const nextState = await window.electronAPI.settings.setDesktopWsServerEnabled(enabled);
      setDesktopWsServerState(nextState);
    } catch (error) {
      setDesktopWsServerState((current) => ({
        ...createFallbackDesktopWsServerState(error instanceof Error ? error.message : String(error)),
        ...current,
        running: false,
        message: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setDesktopWsServerPending(null);
    }
  }

  return (
    <div className="data-root-card settings-desktop-ws-card">
      <div className="settings-desktop-ws-copy">
        <h2>{t("settings.debug.desktopWs.title")}</h2>
        <p className="page-copy">{t("settings.debug.desktopWs.description")}</p>
      </div>
      <div className="settings-desktop-ws-panel">
        <div className="settings-desktop-ws-meta">
          <span className={`settings-desktop-ws-status ${desktopWsServerStatusClass}`}>
            {desktopWsServerStatus}
          </span>
          <code>{desktopWsServerUrl}</code>
        </div>
        <div className="settings-desktop-ws-actions">
          {desktopWsServerState?.running ? (
            <Button
              danger
              disabled={desktopWsServerPending !== null}
              onClick={() => void handleSetDesktopWsServerEnabled(false)}
            >
              {desktopWsServerPending === "close"
                ? t("settings.debug.desktopWs.closing")
                : t("settings.debug.desktopWs.closeAction")}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={desktopWsServerPending !== null}
              onClick={() => void handleSetDesktopWsServerEnabled(true)}
            >
              {desktopWsServerPending === "open"
                ? t("settings.debug.desktopWs.opening")
                : desktopWsServerState?.enabled
                  ? t("settings.debug.desktopWs.retryAction")
                  : t("settings.debug.desktopWs.openAction")}
            </Button>
          )}
          {desktopWsServerState?.enabled && !desktopWsServerState.running ? (
            <Button
              disabled={desktopWsServerPending !== null}
              onClick={() => void handleSetDesktopWsServerEnabled(false)}
            >
              {t("settings.debug.desktopWs.disableAction")}
            </Button>
          ) : null}
        </div>
      </div>
      {desktopWsServerState?.message ? (
        <div className="feedback-banner warning-banner settings-desktop-ws-message" role="status">
          {desktopWsServerState.message}
        </div>
      ) : null}
    </div>
  );
}

function AboutAppCard({
  runtimeResetPending,
  runtimeResetResult,
  onResetRuntimeEnv
}: AboutAppCardProps) {
  const { t } = useI18n();
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.settings
      .getAppInfo()
      .then((nextAppInfo) => {
        if (!cancelled) {
          setAppInfo(nextAppInfo);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppInfo({ productName: "", version: "", buildTime: "" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const version = useMemo(() => {
    if (appInfo === null) {
      return t("common.loading");
    }
    if (!appInfo.version) {
      return t("common.error");
    }
    return appInfo.version.startsWith("v") ? appInfo.version : `v${appInfo.version}`;
  }, [appInfo, t]);
  const buildTime = useMemo(() => {
    if (appInfo === null) {
      return t("common.loading");
    }
    if (!appInfo.buildTime) {
      return t("common.error");
    }
    return appInfo.buildTime;
  }, [appInfo, t]);

  return (
    <div className="settings-about-stack" aria-label={t("settings.about.label")}>
      <div className="settings-item-card settings-about-card">
        <div className="settings-item-row settings-about-row">
          <div className="settings-about-copy">
            <strong>{t("settings.about.version")}</strong>
            <span>{t("settings.about.versionDescription")}</span>
          </div>
          <div className="settings-about-version" aria-live="polite">
            {version}
          </div>
        </div>
        <div className="settings-item-row settings-about-row">
          <div className="settings-about-copy">
            <strong>{t("settings.about.buildTime")}</strong>
            <span>{t("settings.about.buildTimeDescription")}</span>
          </div>
          <div className="settings-about-version settings-about-build-time" aria-live="polite">
            {buildTime}
          </div>
        </div>
      </div>
      <div className="data-root-card settings-reset-card">
        <div className="settings-reset-copy">
          <h2>{t("settings.reset.title")}</h2>
          <p className="page-copy">{t("settings.reset.warning")}</p>
          <p className="settings-inline-note">{t("settings.reset.restartReminder")}</p>
        </div>
        {runtimeResetResult?.ok ? (
          <div className="feedback-banner settings-reset-result" role="status">
            <strong>{t("settings.reset.success")}</strong>
            {runtimeResetResult.backupPath ? (
              <span>{t("settings.reset.backupPath", { path: runtimeResetResult.backupPath })}</span>
            ) : null}
            <span>{t("settings.reset.runtimeRoot", { path: runtimeResetResult.runtimeRoot })}</span>
            <span>
              {t("settings.reset.importSummary", {
                copied: runtimeResetResult.copiedFiles,
                skipped: runtimeResetResult.skippedFiles
              })}
            </span>
          </div>
        ) : null}
        <div className="settings-reset-actions">
          <Button
            type="link"
            danger
            className="settings-reset-button"
            disabled={runtimeResetPending}
            onClick={() => void onResetRuntimeEnv()}
          >
            {runtimeResetPending ? t("settings.reset.running") : t("settings.reset.action")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({
  themeMode,
  onThemeModeChange,
  isMac,
  isWindows,
  sidebarNavOrder,
  availableSidebarNavOrderItems,
  onSidebarNavOrderChange,
  marketEnabled,
  onMarketEnabledChange,
  websiteItems,
  onWebsiteItemsChange,
  onAssistantSettingsChange,
  debugVisible
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const { sectionId: sectionIdParam } = useParams();
  const currentRoute = `${location.pathname}${location.search}`;
  const noticeIdRef = useRef(0);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [sectionReadErrors, setSectionReadErrors] = useState<SectionReadErrorMap>({});
  const [generalSettings, setGeneralSettings] = useState<DesktopGeneralSettings>(defaultGeneralSettings);
  const [generalSettingsSaving, setGeneralSettingsSaving] = useState(false);
  const [websiteLabel, setWebsiteLabel] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [editingWebsiteId, setEditingWebsiteId] = useState("");
  const [websitePending, setWebsitePending] = useState(false);
  const [websiteTransferPending, setWebsiteTransferPending] = useState("");
  const [websiteAgentPendingId, setWebsiteAgentPendingId] = useState("");
  const [deletingWebsiteId, setDeletingWebsiteId] = useState("");
  const [memorySettings, setMemorySettings] = useState<AssistantMemorySettings | null>(null);
  const [memoryStats, setMemoryStats] = useState<AssistantMemoryStats | null>(null);
  const [memoryStorage, setMemoryStorage] = useState<AssistantMemoryStorage | null>(null);
  const [memoryRecentAudit, setMemoryRecentAudit] = useState<AssistantMemorySummary["recentAudit"]>(null);
  const [memoryItems, setMemoryItems] = useState<AssistantMemoryItem[]>([]);
  const [memoryPending, setMemoryPending] = useState("");
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [assistantAgentOptions, setAssistantAgentOptions] = useState<DesktopPetAgentOption[]>([]);
  const [desktopHelperAgentKey, setDesktopHelperAgentKey] = useState(DEFAULT_DESKTOP_HELPER_AGENT_KEY);
  const [quickAssistantEnabled, setQuickAssistantEnabled] = useState(DEFAULT_QUICK_ASSISTANT_ENABLED);
  const [quickAssistantAgentKey, setQuickAssistantAgentKey] = useState(DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
  const [desktopCopilotPages, setDesktopCopilotPages] = useState<DesktopCopilotPagePreferences>(
    createDefaultDesktopCopilotPagePreferences
  );
  const [desktopHelperAgentPending, setDesktopHelperAgentPending] = useState(false);
  const [quickAssistantPending, setQuickAssistantPending] = useState(false);
  const [quickAssistantAgentPending, setQuickAssistantAgentPending] = useState(false);
  const [desktopCopilotPagePending, setDesktopCopilotPagePending] = useState("");
  const [desktopPetState, setDesktopPetState] = useState<DesktopPetState | null>(null);
  const [desktopPetPending, setDesktopPetPending] = useState(false);
  const [desktopPetAppearancePending, setDesktopPetAppearancePending] = useState("");
  const [marketSettings, setMarketSettings] = useState<MarketSettings>({ enabled: false, apiBaseUrl: "" });
  const [marketSettingsSaving, setMarketSettingsSaving] = useState(false);
  const [controlCloudConfig, setControlCloudConfig] = useState<TaskBoardCloudConfig>(defaultTaskBoardCloudConfig);
  const [controlCloudProjects, setControlCloudProjects] = useState<TaskBoardProject[]>([]);
  const [controlConnectionState, setControlConnectionState] = useState<TaskBoardConnectionState>("disabled");
  const [controlOnlineSummary, setControlOnlineSummary] = useState<TaskBoardDesktopOnlineResult>(defaultTaskBoardOnlineSummary);
  const [controlConfigSaving, setControlConfigSaving] = useState(false);
  const [tunnelHubSettings, setTunnelHubSettings] = useState<TunnelHubSettings>(defaultTunnelHubSettings);
  const [tunnelHubRegistrationToken, setTunnelHubRegistrationToken] = useState("");
  const [tunnelHubClearRegistrationToken, setTunnelHubClearRegistrationToken] = useState(false);
  const [tunnelHubRotateRelayToken, setTunnelHubRotateRelayToken] = useState(false);
  const [tunnelHubSaving, setTunnelHubSaving] = useState(false);
  const [appPairingPending, setAppPairingPending] = useState(false);
  const [appPairingResult, setAppPairingResult] = useState<DesktopAppPairingPayloadResult | null>(null);
  const [runtimeResetPending, setRuntimeResetPending] = useState(false);
  const [runtimeResetResult, setRuntimeResetResult] = useState<DesktopRuntimeEnvResetResult | null>(null);
  const desktopPetSupported = isMac || isWindows;
  const contentRef = useRef<HTMLDivElement>(null);
  const memoryDataLoadedRef = useRef(false);
  const assistantSettingsLoadedRef = useRef(false);
  const desktopPetStateLoadedRef = useRef(false);
  const sectionDefinitions = useMemo(
    () => buildLocalizedSettingsSections({ isWindows, desktopPetSupported, debugVisible, t }),
    [debugVisible, desktopPetSupported, isWindows, t]
  );
  const visibleSections = useMemo(
    () => getVisibleSettingsSections(sectionDefinitions),
    [sectionDefinitions]
  );
  const visibleSectionIds = useMemo(
    () => visibleSections.map((section) => section.id),
    [visibleSections]
  );
  const activeSection = resolveSettingsSectionId(
    `/settings/${sectionIdParam ?? ""}`,
    visibleSectionIds
  );
  const shouldReadMemoryData = activeSection === "memory";
  const shouldReadGeneralSettings = activeSection === "general";
  const shouldReadControlData = activeSection === "kanban";
  const shouldReadTunnelHubData = activeSection === "tunnelHub";
  const shouldReadMarketSettings = activeSection === "market";
  const shouldReadAssistantSettings = Boolean(
    activeSection && ASSISTANT_SETTINGS_SECTION_IDS.includes(activeSection)
  );
  const shouldReadDesktopPetState = desktopPetSupported && activeSection === "assistant";
  const controlProjectOptions = useMemo(
    () => sortTaskBoardProjectOptions(controlCloudProjects),
    [controlCloudProjects]
  );
  const selectedControlProjectId = controlCloudConfig.selectedProjectId.trim();
  const selectedControlProjectMissing = Boolean(
    selectedControlProjectId && !controlProjectOptions.some((project) => project.id === selectedControlProjectId)
  );
  const controlProjectSelectOptions = useMemo(() => [
    ...(selectedControlProjectMissing
      ? [{
          value: selectedControlProjectId,
          label: t("taskBoard.cloud.currentProject", { id: selectedControlProjectId })
        }]
      : []),
    ...controlProjectOptions.map((project) => ({
      value: project.id,
      label: getTaskBoardProjectOptionLabel(project)
    }))
  ], [controlProjectOptions, selectedControlProjectId, selectedControlProjectMissing, t]);

  function setReadErrorSections(sectionIds: SettingsSectionId[], message: string) {
    setSectionReadErrors((current) => {
      const next = { ...current };
      for (const sectionId of sectionIds) {
        if (message) {
          next[sectionId] = message;
        } else {
          delete next[sectionId];
        }
      }
      return next;
    });
  }

  function showSectionNotice(sectionId: SettingsSectionId, message: string, tone: NoticeTone) {
    if (tone === "success") {
      return;
    }
    noticeIdRef.current += 1;
    setNotice({
      id: noticeIdRef.current,
      sectionId,
      tone,
      message
    });
  }

  function dismissSectionNotice(noticeId: number) {
    setNotice((current) => (current?.id === noticeId ? null : current));
  }

  function showSectionResultNotice(
    sectionId: SettingsSectionId,
    result: {
      ok: boolean;
      message: string;
    }
  ) {
    showSectionNotice(sectionId, result.message, result.ok ? "success" : "error");
  }

  async function handleLocaleChange(nextLocale: SupportedLocale) {
    if (nextLocale === locale) {
      return;
    }
    try {
      await setLocale(nextLocale);
      showSectionNotice("appearance", `${t("settings.language.current")}：${getLocaleLabel(nextLocale, t)}`, "success");
    } catch (reason) {
      showSectionNotice("appearance", reason instanceof Error ? reason.message : String(reason), "error");
    }
  }

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeSection]);

  useEffect(() => {
    if (!shouldReadGeneralSettings) {
      return;
    }

    let cancelled = false;
    window.electronAPI.settings.getGeneralSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setGeneralSettings({
          ...defaultGeneralSettings,
          ...settings
        });
        setReadErrorSections(["general"], "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["general"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldReadGeneralSettings]);

  useEffect(() => {
    if (!shouldReadControlData) {
      return;
    }

    let cancelled = false;
    async function refreshControlState() {
      try {
        const [settingsResult, onlineResult, issueResult] = await Promise.all([
          window.electronAPI.taskBoard.getSettings(),
          window.electronAPI.taskBoard.listOnlineDevices(),
          window.electronAPI.taskBoard.listIssues()
        ]);
        if (cancelled) {
          return;
        }
        setControlCloudConfig({
          ...defaultTaskBoardCloudConfig,
          ...settingsResult.settings.cloud
        });
        setControlCloudProjects(issueResult.projects ?? []);
        setControlConnectionState(settingsResult.connectionState ?? issueResult.connectionState ?? "disabled");
        setControlOnlineSummary(onlineResult);
        setReadErrorSections(["kanban"], "");
      } catch (reason) {
        if (!cancelled) {
          setReadErrorSections(["kanban"], reason instanceof Error ? reason.message : String(reason));
        }
      }
    }

    void refreshControlState();
    const intervalId = window.setInterval(() => {
      void refreshControlState();
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [shouldReadControlData]);

  useEffect(() => {
    if (!shouldReadMarketSettings) {
      return;
    }

    let cancelled = false;
    window.electronAPI.market.getSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setMarketSettings(settings);
        onMarketEnabledChange?.(isMarketVisible(settings));
        setReadErrorSections(["market"], "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["market"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onMarketEnabledChange, shouldReadMarketSettings]);

  useEffect(() => {
    if (!shouldReadTunnelHubData) {
      return;
    }

    let cancelled = false;
    window.electronAPI.settings.getTunnelHubSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setTunnelHubSettings({
          ...defaultTunnelHubSettings,
          ...settings
        });
        setTunnelHubRelayToken("");
        setTunnelHubClearRelayToken(false);
        setTunnelHubRegistrationToken("");
        setTunnelHubClearRegistrationToken(false);
        setTunnelHubRotateRelayToken(false);
        setReadErrorSections(["tunnelHub"], "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["tunnelHub"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldReadTunnelHubData]);

  useEffect(() => {
    if (!shouldReadMemoryData || memoryDataLoadedRef.current) {
      return;
    }
    memoryDataLoadedRef.current = true;
    let cancelled = false;
    Promise.all([
      window.electronAPI.assistant.getMemorySummary(),
      window.electronAPI.assistant.listMemoryItems()
    ])
      .then(([summary, memoryList]) => {
        if (cancelled) {
          memoryDataLoadedRef.current = false;
          return;
        }
        setMemorySettings(summary.settings);
        setMemoryStats(summary.stats);
        setMemoryStorage(summary.storage);
        setMemoryRecentAudit(summary.recentAudit ?? null);
        setMemoryItems(memoryList.items);
        setReadErrorSections(["memory"], "");
      })
      .catch((reason) => {
        memoryDataLoadedRef.current = false;
        if (!cancelled) {
          setReadErrorSections(["memory"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldReadMemoryData]);

  useEffect(() => {
    if (!shouldReadAssistantSettings || assistantSettingsLoadedRef.current) {
      return;
    }
    assistantSettingsLoadedRef.current = true;
    let cancelled = false;
    Promise.all([
      window.electronAPI.assistant.getSettings(),
      window.electronAPI.assistant.listCopilotAgents(),
      window.electronAPI.assistant.listAgents()
    ])
      .then(([settings, agentsResult, fallbackAgents]) => {
        if (cancelled) {
          assistantSettingsLoadedRef.current = false;
          return;
        }
        const assistantAgents = readAssistantAgentOptions(agentsResult, fallbackAgents);
        if (!agentsResult.ok && assistantAgents.length === 0) {
          throw new Error(agentsResult.message);
        }
        setAssistantSettings(settings);
        setDesktopHelperAgentKey(settings.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY);
        setQuickAssistantEnabled(settings.quickAssistantEnabled);
        setQuickAssistantAgentKey(settings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
        setDesktopCopilotPages(settings.desktopCopilotPages || createDefaultDesktopCopilotPagePreferences());
        setAssistantAgentOptions(assistantAgents);
        setReadErrorSections(ASSISTANT_SETTINGS_SECTION_IDS, "");
      })
      .catch((reason) => {
        assistantSettingsLoadedRef.current = false;
        if (!cancelled) {
          setReadErrorSections(
            ASSISTANT_SETTINGS_SECTION_IDS,
            reason instanceof Error ? reason.message : String(reason)
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldReadAssistantSettings]);

  useEffect(() => {
    if (!shouldReadDesktopPetState) {
      return;
    }

    let cancelled = false;
    if (!desktopPetStateLoadedRef.current) {
      window.electronAPI.desktopPet.getState()
        .then((state) => {
          if (cancelled) {
            return;
          }
          desktopPetStateLoadedRef.current = true;
          setDesktopPetState(state);
          setReadErrorSections(["assistant"], "");
        })
        .catch((reason) => {
          desktopPetStateLoadedRef.current = false;
          if (!cancelled) {
            setReadErrorSections(["assistant"], reason instanceof Error ? reason.message : String(reason));
          }
        });
    }

    const dispose = window.electronAPI.desktopPet.onStateChanged((state) => {
      if (!cancelled) {
        desktopPetStateLoadedRef.current = true;
        setDesktopPetState(state);
        setReadErrorSections(["assistant"], "");
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [shouldReadDesktopPetState]);

  const desktopPetEnabled = Boolean(desktopPetState?.enabled);
  const desktopPetAppearanceOptions = desktopPetState?.appearanceOptions?.length
    ? desktopPetState.appearanceOptions
    : [...DESKTOP_PET_APPEARANCE_OPTIONS];
  const currentDesktopPetAppearanceId = desktopPetState?.appearanceId || DEFAULT_DESKTOP_PET_APPEARANCE_ID;

  function isKnownAssistantAgent(agentKey: string) {
    return assistantAgentOptions.some((agent) => agent.agentKey === agentKey);
  }

  function getAgentLabel(agentKey: string) {
    return assistantAgentOptions.find((agent) => agent.agentKey === agentKey)?.displayName || agentKey;
  }

  function readCopilotPatch(args: Record<string, unknown>) {
    const patch = args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
      ? args.patch as Record<string, unknown>
      : args;
    return patch.desktopCopilotPages && typeof patch.desktopCopilotPages === "object" && !Array.isArray(patch.desktopCopilotPages)
      ? patch.desktopCopilotPages
      : patch;
  }

  function validateCopilotPages(preferences: DesktopCopilotPagePreferences) {
    const issues = DESKTOP_COPILOT_PAGE_KEYS.flatMap((pageKey) => {
      const preference = preferences[pageKey];
      if (!preference.enabled || isKnownAssistantAgent(preference.agentKey)) {
        return [];
      }
      return [{
        field: `desktopCopilotPages.${pageKey}.agentKey`,
        pageKey,
        message: t("settings.navigation.copilotAgentUnavailable", { page: getDesktopCopilotPageLabel(pageKey, t) })
      }];
    });
    return {
      valid: issues.length === 0,
      issues
    };
  }

  function buildSettingsFormStateResult() {
    return {
      page: "settings",
      route: currentRoute,
      fields: {
        desktopHelperAgentKey: {
          value: desktopHelperAgentKey,
          saved: assistantSettings?.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY,
          valid: Boolean(assistantAgentOptions.find((agent) => agent.agentKey === desktopHelperAgentKey))
        },
        quickAssistantEnabled: {
          value: quickAssistantEnabled,
          saved: assistantSettings?.quickAssistantEnabled ?? DEFAULT_QUICK_ASSISTANT_ENABLED
        },
        quickAssistantAgentKey: {
          value: quickAssistantAgentKey,
          saved: assistantSettings?.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
          valid: Boolean(assistantAgentOptions.find((agent) => agent.agentKey === quickAssistantAgentKey))
        },
        desktopCopilotPages,
        memory: {
          enabled: memorySettings?.enabled ?? null,
          autoLearn: memorySettings?.autoLearn ?? null
        }
      },
      options: {
        assistantAgents: assistantAgentOptions.map((agent) => ({
          agentKey: agent.agentKey,
          displayName: agent.displayName,
          role: agent.role
        }))
      }
    };
  }

  async function saveDesktopCopilotPages(
    nextPages: DesktopCopilotPagePreferences,
    pendingKey: DesktopCopilotPageKey | "all"
  ) {
    const previousPages = desktopCopilotPages;
    setDesktopCopilotPages(nextPages);
    setDesktopCopilotPagePending(pendingKey);
    try {
      const nextSettings = await window.electronAPI.assistant.saveSettings({
        desktopCopilotPages: nextPages
      });
      setAssistantSettings(nextSettings);
      setDesktopCopilotPages(nextSettings.desktopCopilotPages);
      onAssistantSettingsChange?.(nextSettings);
      setReadErrorSections(["navigation"], "");
      showSectionNotice("navigation", t("settings.navigation.sideAssistantSaved"), "success");
      return nextSettings;
    } catch (reason) {
      setDesktopCopilotPages(previousPages);
      showSectionNotice("navigation", reason instanceof Error ? reason.message : String(reason), "error");
      throw reason;
    } finally {
      setDesktopCopilotPagePending("");
    }
  }

  async function handleSelectNavigationCopilotAgent(pageKey: DesktopCopilotPageKey, nextAgentKey: string) {
    const normalizedAgentKey = nextAgentKey.trim();
    const currentPreference = desktopCopilotPages[pageKey] ?? createDefaultDesktopCopilotPagePreferences()[pageKey];
    await saveDesktopCopilotPages({
      ...desktopCopilotPages,
      [pageKey]: {
        ...currentPreference,
        enabled: Boolean(normalizedAgentKey),
        agentKey: normalizedAgentKey || currentPreference.agentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY
      }
    }, pageKey).catch(() => undefined);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pageContext = await getAssistantPageContext();
      if (cancelled) {
        return;
      }
      publishCurrentPageContextSnapshot({
        route: currentRoute,
        pageKey: `native:${currentRoute}`,
        pageKind: "native",
        pageContext
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [currentRoute]);

  useEffect(() => {
    return registerDesktopActionProvider(async (request) => {
      const args = request.args ?? {};
      const actionPatch = buildSettingsActionPatch(args);
      const actionPatchHasKeys = Object.keys(actionPatch).length > 0;
      const patch = request.args?.patch && typeof request.args.patch === "object" && !Array.isArray(request.args.patch)
        ? request.args.patch as Record<string, unknown>
        : {};
      const nextCopilotPages = sanitizeDesktopCopilotPagePreferences({
        ...desktopCopilotPages,
        ...readCopilotPatch(args)
      });
      const copilotValidation = validateCopilotPages(nextCopilotPages);
      const requestedHelperAgentKey = typeof request.args?.desktopHelperAgentKey === "string"
        ? request.args.desktopHelperAgentKey.trim()
        : typeof patch.desktopHelperAgentKey === "string"
          ? patch.desktopHelperAgentKey.trim()
          : desktopHelperAgentKey.trim();
      const helperTouched = typeof request.args?.desktopHelperAgentKey === "string" || typeof patch.desktopHelperAgentKey === "string";
      const nextHelperAgent = assistantAgentOptions.find((agent) => agent.agentKey === requestedHelperAgentKey);
      const requestedQuickAssistantAgentKey = typeof request.args?.quickAssistantAgentKey === "string"
        ? request.args.quickAssistantAgentKey.trim()
        : typeof patch.quickAssistantAgentKey === "string"
          ? patch.quickAssistantAgentKey.trim()
          : quickAssistantAgentKey.trim();
      const quickAssistantAgentTouched = typeof request.args?.quickAssistantAgentKey === "string" || typeof patch.quickAssistantAgentKey === "string";
      const quickAssistantEnabledTouched = typeof request.args?.quickAssistantEnabled === "boolean" || typeof patch.quickAssistantEnabled === "boolean";
      const requestedQuickAssistantEnabled = typeof request.args?.quickAssistantEnabled === "boolean"
        ? request.args.quickAssistantEnabled
        : typeof patch.quickAssistantEnabled === "boolean"
          ? patch.quickAssistantEnabled
          : quickAssistantEnabled;
      const nextQuickAssistantAgent = assistantAgentOptions.find((agent) => agent.agentKey === requestedQuickAssistantAgentKey);
      const helperValidation = {
        field: "desktopHelperAgentKey",
        value: requestedHelperAgentKey,
        valid: Boolean(requestedHelperAgentKey && nextHelperAgent),
        message: nextHelperAgent
          ? t("settings.navigation.helperAgentValid")
          : t("settings.navigation.helperAgentInvalid")
      };
      const quickAssistantValidation = {
        field: "quickAssistantAgentKey",
        value: requestedQuickAssistantAgentKey,
        valid: Boolean(requestedQuickAssistantAgentKey && nextQuickAssistantAgent),
        message: nextQuickAssistantAgent
          ? t("settings.quickAssistant.agentValid")
          : t("settings.quickAssistant.agentInvalid")
      };
      const actionPatchHelperAgentKey = typeof actionPatch.desktopHelperAgentKey === "string"
        ? actionPatch.desktopHelperAgentKey.trim()
        : desktopHelperAgentKey.trim();
      const actionPatchQuickAssistantEnabled = typeof actionPatch.quickAssistantEnabled === "boolean"
        ? actionPatch.quickAssistantEnabled
        : quickAssistantEnabled;
      const actionPatchQuickAssistantAgentKey = typeof actionPatch.quickAssistantAgentKey === "string"
        ? actionPatch.quickAssistantAgentKey.trim()
        : quickAssistantAgentKey.trim();
      const actionPatchCopilotPages = sanitizeDesktopCopilotPagePreferences({
        ...desktopCopilotPages,
        ...readCopilotPatch(actionPatch)
      });
      const actionPatchHelperTouched = typeof actionPatch.desktopHelperAgentKey === "string";
      const actionPatchQuickAssistantEnabledTouched = typeof actionPatch.quickAssistantEnabled === "boolean";
      const actionPatchQuickAssistantAgentTouched = typeof actionPatch.quickAssistantAgentKey === "string";
      const actionPatchCopilotTouched =
        "desktopCopilotPages" in actionPatch ||
        Object.keys(readCopilotPatch(actionPatch)).some((key) =>
          DESKTOP_COPILOT_PAGE_KEYS.includes(key as DesktopCopilotPageKey)
        );
      const actionPatchHelperAgent = assistantAgentOptions.find((agent) => agent.agentKey === actionPatchHelperAgentKey);
      const actionPatchQuickAssistantAgent = assistantAgentOptions.find((agent) => agent.agentKey === actionPatchQuickAssistantAgentKey);
      const actionPatchHelperValidation = {
        field: "desktopHelperAgentKey",
        value: actionPatchHelperAgentKey,
        valid: Boolean(actionPatchHelperAgentKey && actionPatchHelperAgent),
        message: actionPatchHelperAgent
          ? t("settings.navigation.helperAgentValid")
          : t("settings.navigation.helperAgentInvalid")
      };
      const actionPatchQuickAssistantValidation = {
        field: "quickAssistantAgentKey",
        value: actionPatchQuickAssistantAgentKey,
        valid: Boolean(actionPatchQuickAssistantAgentKey && actionPatchQuickAssistantAgent),
        message: actionPatchQuickAssistantAgent
          ? t("settings.quickAssistant.agentValid")
          : t("settings.quickAssistant.agentInvalid")
      };
      const actionPatchCopilotValidation = validateCopilotPages(actionPatchCopilotPages);

      switch (request.action) {
        case "desktop.page.readCurrent":
          return {
            ok: true,
            result: {
              ...buildSettingsFormStateResult(),
              realtime: true,
              readAt: new Date().toISOString()
            }
          };
        case "desktop.page.extractStructured":
          return {
            ok: true,
            result: {
              ...buildSettingsFormStateResult(),
              structured: true,
              readAt: new Date().toISOString()
            }
          };
        case "desktop.page.fillForm":
          if (!actionPatchHasKeys) {
            return {
              ok: false,
              error: {
                code: "missing_form_patch",
                message: t("settings.action.fillFormMissing")
              }
            };
          }
          if (
            (actionPatchHelperTouched && !actionPatchHelperValidation.valid) ||
            (actionPatchQuickAssistantAgentTouched && !actionPatchQuickAssistantValidation.valid) ||
            (actionPatchCopilotTouched && !actionPatchCopilotValidation.valid)
          ) {
            return {
              ok: false,
              error: {
                code: "invalid_form_patch",
                message: actionPatchHelperTouched && !actionPatchHelperValidation.valid
                  ? actionPatchHelperValidation.message
                  : actionPatchQuickAssistantAgentTouched && !actionPatchQuickAssistantValidation.valid
                    ? actionPatchQuickAssistantValidation.message
                    : t("settings.navigation.sideAssistantUnavailable"),
                details: {
                  helperValidation: actionPatchHelperValidation,
                  quickAssistantValidation: actionPatchQuickAssistantValidation,
                  copilotValidation: actionPatchCopilotValidation
                }
              }
            };
          }
          if (actionPatchHelperTouched) {
            setDesktopHelperAgentKey(actionPatchHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY);
          }
          if (actionPatchQuickAssistantEnabledTouched) {
            setQuickAssistantEnabled(actionPatchQuickAssistantEnabled);
          }
          if (actionPatchQuickAssistantAgentTouched) {
            setQuickAssistantAgentKey(actionPatchQuickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
          }
          if (actionPatchCopilotTouched) {
            setDesktopCopilotPages(actionPatchCopilotPages);
          }
          return {
            ok: true,
            result: {
              filled: true,
              formState: {
                ...buildSettingsFormStateResult(),
                readAt: new Date().toISOString()
              }
            }
          };
        case "desktop.page.submitForm": {
          const submitPatch = actionPatchHasKeys
            ? actionPatch
            : {
                desktopHelperAgentKey,
                quickAssistantEnabled,
                quickAssistantAgentKey,
                desktopCopilotPages
              };
          const submitPatchHelperTouched = typeof submitPatch.desktopHelperAgentKey === "string";
          const submitPatchQuickAssistantEnabledTouched = typeof submitPatch.quickAssistantEnabled === "boolean";
          const submitPatchQuickAssistantAgentTouched = typeof submitPatch.quickAssistantAgentKey === "string";
          const submitPatchHelperAgentKey = typeof submitPatch.desktopHelperAgentKey === "string"
            ? submitPatch.desktopHelperAgentKey.trim()
            : desktopHelperAgentKey.trim();
          const submitPatchQuickAssistantEnabled = typeof submitPatch.quickAssistantEnabled === "boolean"
            ? submitPatch.quickAssistantEnabled
            : quickAssistantEnabled;
          const submitPatchQuickAssistantAgentKey = typeof submitPatch.quickAssistantAgentKey === "string"
            ? submitPatch.quickAssistantAgentKey.trim()
            : quickAssistantAgentKey.trim();
          const submitPatchCopilotPages = sanitizeDesktopCopilotPagePreferences({
            ...desktopCopilotPages,
            ...readCopilotPatch(submitPatch)
          });
          const submitPatchCopilotTouched =
            "desktopCopilotPages" in submitPatch ||
            Object.keys(readCopilotPatch(submitPatch)).some((key) =>
              DESKTOP_COPILOT_PAGE_KEYS.includes(key as DesktopCopilotPageKey)
            );
          const submitPatchHelperAgent = assistantAgentOptions.find((agent) => agent.agentKey === submitPatchHelperAgentKey);
          const submitPatchQuickAssistantAgent = assistantAgentOptions.find((agent) => agent.agentKey === submitPatchQuickAssistantAgentKey);
          const submitPatchHelperValidation = {
            field: "desktopHelperAgentKey",
            value: submitPatchHelperAgentKey,
            valid: Boolean(submitPatchHelperAgentKey && submitPatchHelperAgent),
            message: submitPatchHelperAgent
              ? t("settings.navigation.helperAgentValid")
              : t("settings.navigation.helperAgentInvalid")
          };
          const submitPatchQuickAssistantValidation = {
            field: "quickAssistantAgentKey",
            value: submitPatchQuickAssistantAgentKey,
            valid: Boolean(submitPatchQuickAssistantAgentKey && submitPatchQuickAssistantAgent),
            message: submitPatchQuickAssistantAgent
              ? t("settings.quickAssistant.agentValid")
              : t("settings.quickAssistant.agentInvalid")
          };
          const submitPatchCopilotValidation = validateCopilotPages(submitPatchCopilotPages);
          if (
            (submitPatchHelperTouched && !submitPatchHelperValidation.valid) ||
            (submitPatchQuickAssistantAgentTouched && !submitPatchQuickAssistantValidation.valid) ||
            (submitPatchCopilotTouched && !submitPatchCopilotValidation.valid)
          ) {
            return {
              ok: false,
              error: {
                code: "invalid_form_patch",
                message: submitPatchHelperTouched && !submitPatchHelperValidation.valid
                  ? submitPatchHelperValidation.message
                  : submitPatchQuickAssistantAgentTouched && !submitPatchQuickAssistantValidation.valid
                    ? submitPatchQuickAssistantValidation.message
                    : t("settings.navigation.sideAssistantUnavailable"),
                details: {
                  helperValidation: submitPatchHelperValidation,
                  quickAssistantValidation: submitPatchQuickAssistantValidation,
                  copilotValidation: submitPatchCopilotValidation
                }
              }
            };
          }
          if (submitPatchHelperTouched) {
            await handleSelectDesktopHelperAgentKey(submitPatchHelperAgentKey);
          }
          if (submitPatchQuickAssistantEnabledTouched) {
            const nextSettings = await window.electronAPI.assistant.saveSettings({
              quickAssistantEnabled: submitPatchQuickAssistantEnabled
            });
            setAssistantSettings(nextSettings);
            setQuickAssistantEnabled(nextSettings.quickAssistantEnabled);
            onAssistantSettingsChange?.(nextSettings);
            setReadErrorSections(["assistant"], "");
            showSectionNotice(
              "assistant",
              nextSettings.quickAssistantEnabled ? t("settings.quickAssistant.noticeEnabled") : t("settings.quickAssistant.noticeDisabled"),
              "success"
            );
          }
          if (submitPatchQuickAssistantAgentTouched) {
            await handleSelectQuickAssistantAgentKey(submitPatchQuickAssistantAgentKey);
          }
          if (submitPatchCopilotTouched) {
            await saveDesktopCopilotPages(submitPatchCopilotPages, "all");
          }
          return {
            ok: true,
            result: {
              submitted: true,
              formState: {
                ...buildSettingsFormStateResult(),
                readAt: new Date().toISOString()
              }
            }
          };
        }
        case "desktop.page.getFormState":
          return {
            ok: true,
            result: buildSettingsFormStateResult()
          };
        case "desktop.page.validateForm":
          return {
            ok: true,
            result: {
              valid: helperValidation.valid && quickAssistantValidation.valid && copilotValidation.valid,
              issues: [
                ...(helperValidation.valid ? [] : [helperValidation]),
                ...(quickAssistantValidation.valid ? [] : [quickAssistantValidation]),
                ...copilotValidation.issues
              ],
              fields: {
                desktopHelperAgentKey: helperValidation,
                quickAssistantAgentKey: quickAssistantValidation,
                desktopCopilotPages: copilotValidation
              }
            }
          };
        case "desktop.page.previewPatch":
          return {
            ok: true,
            preview: {
              page: "settings",
              changes: [{
                field: "desktopHelperAgentKey",
                from: desktopHelperAgentKey,
                to: requestedHelperAgentKey,
                displayName: nextHelperAgent?.displayName ?? requestedHelperAgentKey,
                valid: helperValidation.valid
              }, {
                field: "quickAssistantEnabled",
                from: quickAssistantEnabled,
                to: requestedQuickAssistantEnabled,
                valid: true
              }, {
                field: "quickAssistantAgentKey",
                from: quickAssistantAgentKey,
                to: requestedQuickAssistantAgentKey,
                displayName: nextQuickAssistantAgent?.displayName ?? requestedQuickAssistantAgentKey,
                valid: quickAssistantValidation.valid
              }, {
                field: "desktopCopilotPages",
                from: desktopCopilotPages,
                to: nextCopilotPages,
                valid: copilotValidation.valid
              }]
            }
          };
        case "desktop.page.applyPatch":
          if ((helperTouched && !helperValidation.valid) || (quickAssistantAgentTouched && !quickAssistantValidation.valid) || !copilotValidation.valid) {
            return {
              ok: false,
              error: {
                code: "invalid_form_patch",
                message: helperTouched && !helperValidation.valid
                  ? helperValidation.message
                  : quickAssistantAgentTouched && !quickAssistantValidation.valid
                    ? quickAssistantValidation.message
                    : t("settings.navigation.sideAssistantUnavailable"),
                details: { helperValidation, quickAssistantValidation, copilotValidation }
              }
            };
          }
          if (helperTouched) {
            await handleSelectDesktopHelperAgentKey(requestedHelperAgentKey);
          }
          if (quickAssistantEnabledTouched) {
            const nextSettings = await window.electronAPI.assistant.saveSettings({
              quickAssistantEnabled: requestedQuickAssistantEnabled
            });
            setAssistantSettings(nextSettings);
            setQuickAssistantEnabled(nextSettings.quickAssistantEnabled);
            onAssistantSettingsChange?.(nextSettings);
            setReadErrorSections(["assistant"], "");
            showSectionNotice(
              "assistant",
              nextSettings.quickAssistantEnabled ? t("settings.quickAssistant.noticeEnabled") : t("settings.quickAssistant.noticeDisabled"),
              "success"
            );
          }
          if (quickAssistantAgentTouched) {
            await handleSelectQuickAssistantAgentKey(requestedQuickAssistantAgentKey);
          }
          if ("desktopCopilotPages" in args || Object.keys(readCopilotPatch(args)).some((key) => DESKTOP_COPILOT_PAGE_KEYS.includes(key as DesktopCopilotPageKey))) {
            await saveDesktopCopilotPages(nextCopilotPages, "all");
          }
          return {
            ok: true,
            result: {
              applied: true,
              desktopHelperAgentKey: requestedHelperAgentKey,
              quickAssistantEnabled: requestedQuickAssistantEnabled,
              quickAssistantAgentKey: requestedQuickAssistantAgentKey,
              desktopCopilotPages: nextCopilotPages
            }
          };
        default:
          return null;
      }
    });
  }, [
    assistantAgentOptions,
    assistantSettings?.desktopHelperAgentKey,
    assistantSettings?.quickAssistantAgentKey,
    assistantSettings?.quickAssistantEnabled,
    desktopHelperAgentKey,
    desktopCopilotPages,
    quickAssistantAgentKey,
    quickAssistantEnabled,
    memorySettings?.autoLearn,
    memorySettings?.enabled,
    t
  ]);

  async function refreshMemoryItems() {
    const [summary, memoryList] = await Promise.all([
      window.electronAPI.assistant.getMemorySummary(),
      window.electronAPI.assistant.listMemoryItems()
    ]);
    setMemorySettings(summary.settings);
    setMemoryStats(summary.stats);
    setMemoryStorage(summary.storage);
    setMemoryRecentAudit(summary.recentAudit ?? null);
    setMemoryItems(memoryList.items);
    setReadErrorSections(["memory"], "");
    return summary;
  }

  async function handleTogglePreventSleepWhileRunning() {
    const previousSettings = generalSettings;
    const nextSettings = {
      ...generalSettings,
      preventSleepWhileRunning: !generalSettings.preventSleepWhileRunning
    };
    setGeneralSettings(nextSettings);
    setGeneralSettingsSaving(true);
    try {
      const savedSettings = await window.electronAPI.settings.saveGeneralSettings(nextSettings);
      setGeneralSettings({
        ...defaultGeneralSettings,
        ...savedSettings
      });
      setReadErrorSections(["general"], "");
      showSectionNotice(
        "general",
        savedSettings.preventSleepWhileRunning
          ? t("settings.general.noticePreventSleepEnabled")
          : t("settings.general.noticePreventSleepDisabled"),
        "success"
      );
    } catch (reason) {
      setGeneralSettings(previousSettings);
      showSectionNotice("general", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setGeneralSettingsSaving(false);
    }
  }

  async function handleAddWebsiteItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setWebsitePending(true);
    try {
      const result = await window.electronAPI.webs.websites.add({
        label: websiteLabel,
        url: websiteUrl
      });
      showSectionResultNotice("embeddedWebs", result);
      onWebsiteItemsChange(result.items);
      if (result.ok) {
        setWebsiteLabel("");
        setWebsiteUrl("");
      }
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsitePending(false);
    }
  }

  function resetWebsiteForm() {
    setEditingWebsiteId("");
    setWebsiteLabel("");
    setWebsiteUrl("");
  }

  function handleStartEditWebsiteItem(item: WebsiteEntry) {
    setEditingWebsiteId(item.id);
    setWebsiteLabel(item.label);
    setWebsiteUrl(item.url);
    setNotice((current) => current?.sectionId === "embeddedWebs" ? null : current);
  }

  function handleCancelEditWebsiteItem() {
    resetWebsiteForm();
  }

  async function handleUpdateWebsiteItem(itemId: string) {
    setWebsitePending(true);
    try {
      const result = await window.electronAPI.webs.websites.update(itemId, {
        label: websiteLabel,
        url: websiteUrl
      });
      showSectionResultNotice("embeddedWebs", result);
      onWebsiteItemsChange(result.items);
      if (result.ok) {
        resetWebsiteForm();
      }
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsitePending(false);
    }
  }

  async function handleDeleteWebsiteItem(item: WebsiteEntry) {
    setDeletingWebsiteId(item.id);
    try {
      const result = await window.electronAPI.webs.websites.remove(item.id);
      showSectionResultNotice("embeddedWebs", result);
      onWebsiteItemsChange(result.items);
      if (editingWebsiteId === item.id) {
        resetWebsiteForm();
      }
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDeletingWebsiteId("");
    }
  }

  async function handleUpdateWebsiteAgent(itemId: string, agentKey: string) {
    setWebsiteAgentPendingId(itemId);
    try {
      const result = await window.electronAPI.webs.websites.update(itemId, { agentKey });
      showSectionResultNotice("embeddedWebs", result);
      onWebsiteItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteAgentPendingId("");
    }
  }

  async function handleImportWebsiteItems() {
    setWebsiteTransferPending("import");
    try {
      const result = await window.electronAPI.webs.websites.import();
      showSectionResultNotice("embeddedWebs", result);
      onWebsiteItemsChange(result.items);
      resetWebsiteForm();
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteTransferPending("");
    }
  }

  async function handleExportWebsiteItems() {
    setWebsiteTransferPending("export");
    try {
      const result = await window.electronAPI.webs.websites.export();
      showSectionNotice(
        "embeddedWebs",
        result.path ? `${result.message} ${result.path}` : result.message,
        result.ok ? "success" : "error"
      );
      onWebsiteItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("embeddedWebs", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteTransferPending("");
    }
  }

  async function handleToggleMemoryEnabled() {
    if (!memorySettings) {
      return;
    }
    setMemoryPending("settings");
    try {
      const nextSettings = await window.electronAPI.assistant.saveMemorySettings({
        ...memorySettings,
        enabled: !memorySettings.enabled
      });
      await refreshMemoryItems();
      showSectionNotice("memory", nextSettings.enabled ? t("settings.memory.noticeEnabled") : t("settings.memory.noticeDisabled"), "success");
    } catch (reason) {
      showSectionNotice("memory", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMemoryPending("");
    }
  }

  async function handleToggleMemoryAutoLearn() {
    if (!memorySettings) {
      return;
    }
    setMemoryPending("settings");
    try {
      const nextSettings = await window.electronAPI.assistant.saveMemorySettings({
        ...memorySettings,
        autoLearn: !memorySettings.autoLearn
      });
      await refreshMemoryItems();
      showSectionNotice("memory", nextSettings.autoLearn ? t("settings.memory.noticeAutoLearnEnabled") : t("settings.memory.noticeAutoLearnDisabled"), "success");
    } catch (reason) {
      showSectionNotice("memory", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMemoryPending("");
    }
  }

  async function handleClearMemoryItems() {
    setMemoryPending("clear");
    try {
      const result = await window.electronAPI.assistant.clearMemoryItems();
      showSectionResultNotice("memory", result);
      await refreshMemoryItems();
    } catch (reason) {
      showSectionNotice("memory", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMemoryPending("");
    }
  }

  async function handleOpenMemoryDirectory() {
    setMemoryPending("open");
    try {
      const result = await window.electronAPI.assistant.openMemoryDirectory();
      showSectionResultNotice("memory", result);
    } catch (reason) {
      showSectionNotice("memory", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMemoryPending("");
    }
  }

  const recentMemoryItems = memoryItems.slice(0, 3);
  const memoryTotal = memoryStats?.total ?? 0;
  const memoryFactCount = memoryStats?.factCount ?? 0;
  const memoryObservationCount = memoryStats?.observationCount ?? 0;
  const memoryRecallLabel = memorySettings?.enabled ? t("settings.memory.recallEnabled") : t("settings.memory.recallDisabled");
  const memoryAutoLearnLabel = memorySettings?.autoLearn ? t("settings.memory.autoLearnEnabled") : t("settings.memory.autoLearnDisabled");

  async function handleToggleDesktopPet() {
    const nextEnabled = !desktopPetState?.enabled;
    if (nextEnabled) {
      const appearanceAvailable = desktopPetAppearanceOptions.some((appearance) => appearance.id === currentDesktopPetAppearanceId);
      if (!desktopPetSupported || !desktopPetState?.supported || !appearanceAvailable) {
        showSectionNotice("assistant", t("settings.desktopPet.enableUnavailable"), "error");
        return;
      }
    }
    setDesktopPetPending(true);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        enabled: nextEnabled
      });
      setDesktopPetState(nextState);
      setReadErrorSections(["assistant"], "");
      showSectionNotice("assistant", nextState.enabled ? t("settings.desktopPet.noticeEnabled") : t("settings.desktopPet.noticeDisabled"), "success");
    } catch (reason) {
      showSectionNotice("assistant", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopPetPending(false);
    }
  }

  async function handleSelectDesktopPetAppearance(appearanceId: string) {
    if (!desktopPetSupported) {
      return;
    }
    if (!desktopPetState || appearanceId === currentDesktopPetAppearanceId) {
      return;
    }
    const selectedAppearance = desktopPetAppearanceOptions.find((appearance) => appearance.id === appearanceId);
    setDesktopPetAppearancePending(appearanceId);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        appearanceId
      });
      setDesktopPetState(nextState);
      setReadErrorSections(["assistant"], "");
      if (nextState.appearanceId === appearanceId) {
        showSectionNotice(
          "assistant",
          t("settings.desktopPet.noticeAppearanceChanged", {
            name: getDesktopPetAppearanceLabel(appearanceId, selectedAppearance?.displayName ?? appearanceId, t)
          }),
          "success"
        );
      } else {
        showSectionNotice("assistant", t("settings.desktopPet.noticeAppearanceFailed"), "error");
      }
    } catch (reason) {
      showSectionNotice("assistant", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopPetAppearancePending("");
    }
  }

  async function handleSelectDesktopHelperAgentKey(nextAgentKey: string) {
    const normalizedAgentKey = nextAgentKey.trim();
    const previousAgentKey = desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
    if (!normalizedAgentKey || normalizedAgentKey === previousAgentKey) {
      return;
    }

    setDesktopHelperAgentKey(normalizedAgentKey);
    setDesktopHelperAgentPending(true);
    try {
      const nextSettings = await window.electronAPI.assistant.saveSettings({
        desktopHelperAgentKey: normalizedAgentKey
      });
      const nextAgent = assistantAgentOptions.find((agent) => agent.agentKey === nextSettings.desktopHelperAgentKey);
      setAssistantSettings(nextSettings);
      setDesktopHelperAgentKey(nextSettings.desktopHelperAgentKey);
      onAssistantSettingsChange?.(nextSettings);
      setReadErrorSections(["navigation"], "");
      showSectionNotice(
        "navigation",
        t("settings.navigation.defaultAgentChanged", { name: nextAgent?.displayName ?? nextSettings.desktopHelperAgentKey }),
        "success"
      );
    } catch (reason) {
      setDesktopHelperAgentKey(previousAgentKey);
      showSectionNotice("navigation", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopHelperAgentPending(false);
    }
  }

  async function handleToggleQuickAssistantEnabled() {
    const previousEnabled = quickAssistantEnabled;
    const nextEnabled = !quickAssistantEnabled;
    setQuickAssistantEnabled(nextEnabled);
    setQuickAssistantPending(true);
    try {
      const nextSettings = await window.electronAPI.assistant.saveSettings({
        quickAssistantEnabled: nextEnabled
      });
      setAssistantSettings(nextSettings);
      setQuickAssistantEnabled(nextSettings.quickAssistantEnabled);
      setQuickAssistantAgentKey(nextSettings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
      onAssistantSettingsChange?.(nextSettings);
      setReadErrorSections(["assistant"], "");
      showSectionNotice(
        "assistant",
        nextSettings.quickAssistantEnabled ? t("settings.quickAssistant.noticeEnabled") : t("settings.quickAssistant.noticeDisabled"),
        "success"
      );
    } catch (reason) {
      setQuickAssistantEnabled(previousEnabled);
      showSectionNotice("assistant", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setQuickAssistantPending(false);
    }
  }

  async function handleSelectQuickAssistantAgentKey(nextAgentKey: string) {
    const normalizedAgentKey = nextAgentKey.trim();
    const previousAgentKey = quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
    if (!normalizedAgentKey || normalizedAgentKey === previousAgentKey) {
      return;
    }

    setQuickAssistantAgentKey(normalizedAgentKey);
    setQuickAssistantAgentPending(true);
    try {
      const nextSettings = await window.electronAPI.assistant.saveSettings({
        quickAssistantAgentKey: normalizedAgentKey
      });
      const nextAgent = assistantAgentOptions.find((agent) => agent.agentKey === nextSettings.quickAssistantAgentKey);
      setAssistantSettings(nextSettings);
      setQuickAssistantEnabled(nextSettings.quickAssistantEnabled);
      setQuickAssistantAgentKey(nextSettings.quickAssistantAgentKey);
      onAssistantSettingsChange?.(nextSettings);
      setReadErrorSections(["assistant"], "");
      showSectionNotice(
        "assistant",
        t("settings.quickAssistant.noticeAgentChanged", { name: nextAgent?.displayName ?? nextSettings.quickAssistantAgentKey }),
        "success"
      );
    } catch (reason) {
      setQuickAssistantAgentKey(previousAgentKey);
      showSectionNotice("assistant", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setQuickAssistantAgentPending(false);
    }
  }

  function getControlConnectionLabel(state: TaskBoardConnectionState) {
    switch (state) {
      case "connecting":
        return t("taskBoard.cloud.status.connecting");
      case "open":
        return t("taskBoard.cloud.status.open");
      case "closed":
        return t("taskBoard.cloud.status.closed");
      case "error":
        return t("taskBoard.cloud.status.error");
      default:
        return t("taskBoard.cloud.status.disabled");
    }
  }

  async function saveControlCloudConfig(nextConfig: TaskBoardCloudConfig) {
    setControlConfigSaving(true);
    try {
      const result = await window.electronAPI.taskBoard.saveSettings({
        enabled: true,
        cloud: nextConfig
      });
      if (!result.ok) {
        throw new Error(result.message || t("settings.kanban.saveFailed"));
      }
      setControlCloudConfig({
        ...defaultTaskBoardCloudConfig,
        ...result.settings.cloud
      });
      setControlConnectionState(result.connectionState ?? "disabled");
      const [onlineResult, issueResult] = await Promise.all([
        window.electronAPI.taskBoard.listOnlineDevices(),
        window.electronAPI.taskBoard.listIssues()
      ]);
      setControlCloudProjects(issueResult.projects ?? []);
      setControlOnlineSummary(onlineResult);
      setReadErrorSections(["kanban"], "");
      showSectionNotice("kanban", result.message, "success");
    } catch (reason) {
      showSectionNotice("kanban", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setControlConfigSaving(false);
    }
  }

  async function handleToggleControlRemoteControl() {
    await saveControlCloudConfig({
      ...controlCloudConfig,
      remoteControlEnabled: !controlCloudConfig.remoteControlEnabled
    });
  }

  async function handleSaveMarketSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMarketSettingsSaving(true);
    try {
      const settings = await window.electronAPI.market.saveSettings(marketSettings);
      setMarketSettings(settings);
      onMarketEnabledChange?.(isMarketVisible(settings));
      setReadErrorSections(["market"], "");
      showSectionNotice(
        "market",
        isMarketVisible(settings) ? t("settings.market.noticeVisible") : t("settings.market.noticeHidden"),
        "success"
      );
    } catch (reason) {
      showSectionNotice("market", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMarketSettingsSaving(false);
    }
  }

  async function handleToggleMarketEnabled() {
    const previousSettings = marketSettings;
    const nextEnabled = !marketSettings.enabled;
    if (!nextEnabled) {
      onMarketEnabledChange?.(false);
    }
    setMarketSettingsSaving(true);
    try {
      const settings = await window.electronAPI.market.saveSettings({
        ...marketSettings,
        enabled: nextEnabled
      });
      setMarketSettings(settings);
      onMarketEnabledChange?.(isMarketVisible(settings));
      setReadErrorSections(["market"], "");
      if (nextEnabled && !isMarketVisible(settings)) {
        throw new Error(t("settings.market.enableIncomplete"));
      }
      showSectionNotice(
        "market",
        isMarketVisible(settings) ? t("settings.market.noticeVisible") : t("settings.market.noticeHidden"),
        "success"
      );
    } catch (reason) {
      setMarketSettings(previousSettings);
      onMarketEnabledChange?.(isMarketVisible(previousSettings));
      showSectionNotice("market", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setMarketSettingsSaving(false);
    }
  }

  async function handleSaveTunnelHubSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTunnelHubSaving(true);
    try {
      const result = await window.electronAPI.settings.saveTunnelHubSettings({
        enabled: tunnelHubSettings.enabled,
        relayUrl: tunnelHubSettings.relayUrl,
        deviceId: tunnelHubSettings.deviceId,
        registrationToken: tunnelHubRegistrationToken,
        clearRegistrationToken: tunnelHubClearRegistrationToken,
        rotateRelayToken: tunnelHubRotateRelayToken,
        tlsInsecureSkipVerify: tunnelHubSettings.tlsInsecureSkipVerify,
        reconnectSeconds: tunnelHubSettings.reconnectSeconds
      });
      setTunnelHubSettings({
        ...defaultTunnelHubSettings,
        ...result.settings
      });
      setTunnelHubRegistrationToken("");
      setTunnelHubClearRegistrationToken(false);
      setTunnelHubRotateRelayToken(false);
      if (!result.ok) {
        throw new Error(result.message || t("settings.tunnelHub.saveFailed"));
      }
      setReadErrorSections(["tunnelHub"], "");
      showSectionNotice("tunnelHub", result.message, "success");
    } catch (reason) {
      showSectionNotice("tunnelHub", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setTunnelHubSaving(false);
    }
  }

  async function handleToggleTunnelHubEnabled() {
    const nextEnabled = !tunnelHubSettings.enabled;
    setTunnelHubSaving(true);
    try {
      const result = await window.electronAPI.settings.saveTunnelHubSettings({
        enabled: nextEnabled,
        relayUrl: tunnelHubSettings.relayUrl,
        deviceId: tunnelHubSettings.deviceId,
        registrationToken: tunnelHubRegistrationToken,
        clearRegistrationToken: tunnelHubClearRegistrationToken,
        rotateRelayToken: tunnelHubRotateRelayToken,
        tlsInsecureSkipVerify: tunnelHubSettings.tlsInsecureSkipVerify,
        reconnectSeconds: tunnelHubSettings.reconnectSeconds
      });
      setTunnelHubSettings({
        ...defaultTunnelHubSettings,
        ...result.settings
      });
      setTunnelHubRegistrationToken("");
      setTunnelHubClearRegistrationToken(false);
      setTunnelHubRotateRelayToken(false);
      if (!result.ok) {
        throw new Error(result.message || t("settings.tunnelHub.enableIncomplete"));
      }
      setReadErrorSections(["tunnelHub"], "");
      showSectionNotice(
        "tunnelHub",
        nextEnabled ? t("settings.tunnelHub.noticeEnabled") : t("settings.tunnelHub.noticeDisabled"),
        "success"
      );
    } catch (reason) {
      showSectionNotice("tunnelHub", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setTunnelHubSaving(false);
    }
  }

  async function handleCreateAppPairingPayload() {
    setAppPairingPending(true);
    try {
      const result = await window.electronAPI.settings.createAppPairingPayload();
      setAppPairingResult(result);
      if (!result.ok) {
        showSectionNotice("control", result.message || t("settings.mobilePairing.failed"), "error");
        return;
      }
      setReadErrorSections(["control"], "");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setAppPairingResult({ ok: false, message });
      showSectionNotice("control", message, "error");
    } finally {
      setAppPairingPending(false);
    }
  }

  async function handleCopyAppPairingPayload() {
    if (!appPairingResult?.ok) {
      return;
    }
    const result = await window.electronAPI.clipboard.writeText(appPairingResult.payloadText);
    if (!result.ok) {
      showSectionNotice("control", result.message || t("settings.mobilePairing.copyFailed"), "error");
    }
  }

  async function handleResetRuntimeEnv() {
    if (!window.confirm(t("settings.reset.confirmMessage"))) {
      return;
    }

    setRuntimeResetPending(true);
    setRuntimeResetResult(null);
    try {
      const result = await window.electronAPI.settings.resetRuntimeEnv();
      if (!result.ok) {
        showSectionNotice("about", result.message || t("settings.reset.failed"), "error");
        setRuntimeResetResult(result);
        return;
      }
      setRuntimeResetResult(result);
      setReadErrorSections(["about"], "");
    } catch (reason) {
      showSectionNotice("about", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setRuntimeResetPending(false);
    }
  }

  const sidebarNavOrderLabels = new Map(availableSidebarNavOrderItems.map((item) => [item.key, item.label]));
  const activeSectionDefinition = activeSection
    ? visibleSections.find((definition) => definition.id === activeSection) ?? null
    : null;
  const activeSectionReadError = activeSection ? sectionReadErrors[activeSection] ?? "" : "";
  const activeSectionNotice = notice && notice.sectionId === activeSection && notice.tone === "error" ? notice : null;

  function renderHeaderSwitch({
    enabled,
    disabled,
    label,
    onClick
  }: {
    enabled: boolean;
    disabled: boolean;
    label: string;
    onClick: () => void;
  }) {
    return (
      <Switch
        checked={enabled}
        aria-label={label}
        disabled={disabled}
        onChange={() => onClick()}
      />
    );
  }

  function renderSectionHeaderAction() {
    switch (activeSection) {
      case "assistant":
        return desktopPetSupported ? renderHeaderSwitch({
          enabled: desktopPetEnabled,
          disabled: desktopPetPending || !desktopPetState,
          label: t("settings.desktopPet.label"),
          onClick: () => void handleToggleDesktopPet()
        }) : null;
      case "market":
        return renderHeaderSwitch({
          enabled: marketSettings.enabled,
          disabled: marketSettingsSaving,
          label: t("settings.market.enabled"),
          onClick: () => void handleToggleMarketEnabled()
        });
      case "tunnelHub":
        return renderHeaderSwitch({
          enabled: tunnelHubSettings.enabled,
          disabled: tunnelHubSaving,
          label: t("settings.tunnelHub.label"),
          onClick: () => void handleToggleTunnelHubEnabled()
        });
      default:
        return null;
    }
  }

  function renderActiveSection() {
    switch (activeSection) {
      case "general":
        return (
          <div className="settings-appearance-panel" aria-label={t("settings.general.panelAria")}>
            <div className="settings-appearance-row">
              <div className="settings-appearance-row-copy">
                <strong>{t("settings.general.preventSleepWhileRunning")}</strong>
                <span>{t("settings.general.preventSleepWhileRunningDescription")}</span>
              </div>
              <Switch
                checked={generalSettings.preventSleepWhileRunning}
                aria-label={t("settings.general.preventSleepWhileRunning")}
                disabled={generalSettingsSaving}
                onChange={() => void handleTogglePreventSleepWhileRunning()}
              />
            </div>
          </div>
        );
      case "appearance":
        return (
          <>
            <div className="settings-appearance-panel">
              <div className="settings-appearance-row">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.appearance.theme")}</strong>
                  <span>{t("settings.appearance.themeDescription")}</span>
                </div>
                <Segmented<ThemePreference>
                  aria-label={t("settings.appearance.theme")}
                  value={themeMode}
                  onChange={(value) => {
                    if (themeMode !== value) {
                      onThemeModeChange(value);
                    }
                  }}
                  options={THEME_PREFERENCE_OPTIONS.map((option) => ({
                    value: option,
                    label: (
                      <span className="settings-theme-segment-label">
                        <span className="settings-theme-segment-icon" aria-hidden="true">
                          <ThemePreferenceIcon themeMode={option} />
                        </span>
                        <span>{getThemePreferenceLabel(option, t)}</span>
                      </span>
                    )
                  }))}
                />
              </div>
              <div className="settings-appearance-row">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.language.label")}</strong>
                  <span>{t("settings.language.uiDescription")}</span>
                </div>
                <Select<SupportedLocale>
                  style={{ minWidth: 148 }}
                  value={locale}
                  aria-label={t("settings.language.label")}
                  onChange={(value) => void handleLocaleChange(value)}
                  options={[
                    { value: "zh-CN", label: t("settings.language.zhCN") },
                    { value: "en-US", label: t("settings.language.enUS") }
                  ]}
                />
              </div>
            </div>
          </>
        );
      case "assistant":
        return (
          <>
            {desktopPetSupported ? (
              <div className="settings-item-card settings-pet-card settings-appearance-pet-card">
                <div
                  className={desktopPetEnabled
                    ? "settings-item-list settings-pet-appearance-panel desktop-pet-appearance-list"
                    : "settings-item-list settings-pet-appearance-panel desktop-pet-appearance-list is-disabled"}
                  aria-label={t("settings.desktopPet.appearance")}
                  aria-disabled={!desktopPetEnabled}
                >
                  {desktopPetAppearanceOptions.map((appearance) => {
                    const selected = appearance.id === currentDesktopPetAppearanceId;
                    const pending = desktopPetAppearancePending === appearance.id;
                    const appearanceLabel = getDesktopPetAppearanceLabel(appearance.id, appearance.displayName, t);
                    const appearanceDescription = getDesktopPetAppearanceDescription(appearance.id, appearance.description, t);
                    const idlePreviewAsset = appearance.states.idle;
                    const idlePreviewFrameCount = Math.max(1, Math.round(Number(idlePreviewAsset?.frameCount) || 1));
                    const shouldRenderSpritePreview =
                      idlePreviewAsset?.path === appearance.preview && idlePreviewFrameCount > 1;
                    const previewSpriteStyle = shouldRenderSpritePreview
                      ? ({
                          "--desktop-pet-appearance-preview-frames": String(idlePreviewFrameCount),
                          backgroundImage: `url("${appearance.previewUrl}")`
                        } as CSSProperties)
                      : undefined;
                    let actionLabel = t("settings.desktopPet.select");
                    if (selected) {
                      actionLabel = desktopPetEnabled ? t("settings.desktopPet.selected") : t("settings.desktopPet.saved");
                    }
                    if (pending) {
                      actionLabel = t("settings.desktopPet.switching");
                    }
                    return (
                      <div className="settings-pet-appearance-row desktop-pet-appearance-row" key={appearance.id}>
                        <span className="desktop-pet-appearance-preview" aria-hidden="true">
                          {shouldRenderSpritePreview ? (
                            <span className="desktop-pet-appearance-sprite" style={previewSpriteStyle} />
                          ) : (
                            <img src={appearance.previewUrl} alt="" />
                          )}
                        </span>
                        <span className="desktop-pet-appearance-copy">
                          <strong>{appearanceLabel}</strong>
                          <small>{appearanceDescription}</small>
                        </span>
                        <Button
                          type={selected ? "default" : "primary"}
                          className={selected ? "desktop-pet-appearance-select is-selected" : "desktop-pet-appearance-select"}
                          aria-pressed={selected}
                          disabled={!desktopPetEnabled || selected || Boolean(desktopPetAppearancePending)}
                          onClick={() => void handleSelectDesktopPetAppearance(appearance.id)}
                        >
                          {actionLabel}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="settings-item-card desktop-helper-settings-card" aria-label={t("settings.assistant.panelAria")}>
              <div className="settings-item-header">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.quickAssistant.label")}</strong>
                  <span>
                    {quickAssistantEnabled
                      ? t("settings.quickAssistant.statusEnabled", { name: getAgentLabel(quickAssistantAgentKey) })
                      : t("settings.quickAssistant.statusDisabled")}
                  </span>
                  {quickAssistantEnabled && !isKnownAssistantAgent(quickAssistantAgentKey) ? (
                    <em>{t("settings.quickAssistant.defaultUnavailable")}</em>
                  ) : null}
                </div>
                <Switch
                  checked={quickAssistantEnabled}
                  aria-label={t("settings.quickAssistant.label")}
                  disabled={quickAssistantPending}
                  onChange={() => void handleToggleQuickAssistantEnabled()}
                />
              </div>
              <div className="settings-item-form desktop-pet-agent-form">
                <label className="desktop-pet-agent-field">
                  <span>{t("settings.quickAssistant.defaultAgent")}</span>
                  <span className="desktop-pet-agent-select-wrap">
                    <Select
                      style={{ width: "100%" }}
                      value={isKnownAssistantAgent(quickAssistantAgentKey) ? quickAssistantAgentKey : ""}
                      onChange={(value) => void handleSelectQuickAssistantAgentKey(value)}
                      disabled={!quickAssistantEnabled || assistantAgentOptions.length === 0 || quickAssistantAgentPending}
                      aria-label={t("settings.quickAssistant.defaultAgent")}
                      options={[
                        {
                          value: "",
                          label: assistantAgentOptions.length === 0
                            ? t("settings.navigation.agentsLoading")
                            : isKnownAssistantAgent(quickAssistantAgentKey)
                              ? t("settings.navigation.selectAgent")
                              : t("settings.navigation.unavailableAgent", { agentKey: quickAssistantAgentKey })
                        },
                        ...assistantAgentOptions.map((agent) => ({
                          value: agent.agentKey,
                          label: `${agent.displayName}${agent.role ? ` · ${agent.role}` : ""}`
                        }))
                      ]}
                    />
                  </span>
                </label>
              </div>
            </div>
          </>
        );
      case "kanban":
        return (
          <Card
            className="settings-item-card settings-control-card settings-kanban-ant-card"
            aria-label={t("settings.kanban.panelAria")}
            styles={{ body: { padding: 0 } }}
          >
            <div className="settings-item-header settings-control-permission-row">
              <span className="settings-control-app-icon" aria-hidden="true">
                <span />
              </span>
              <Space className="settings-kanban-copy" direction="vertical" size={3}>
                <Typography.Text strong>{t("settings.control.remoteControlEnabled")}</Typography.Text>
                <Typography.Text type="secondary">{t("settings.control.remoteControlDescription")}</Typography.Text>
                <Typography.Text className="settings-kanban-remote-state">
                  {controlCloudConfig.remoteControlEnabled
                    ? t("settings.control.remoteControlOn")
                    : t("settings.control.remoteControlOff")}
                </Typography.Text>
              </Space>
              <Switch
                checked={controlCloudConfig.remoteControlEnabled}
                aria-label={t("settings.control.remoteControlEnabled")}
                disabled={controlConfigSaving}
                loading={controlConfigSaving}
                onChange={() => void handleToggleControlRemoteControl()}
              />
            </div>
            <div className="settings-kanban-status">
              <Space direction="vertical" size={4}>
                <Typography.Text strong>{t("settings.control.statusTitle")}</Typography.Text>
                <Typography.Text type="secondary">{getControlConnectionLabel(controlConnectionState)}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {t("settings.control.onlineSummary", {
                  devices: controlOnlineSummary.deviceCount,
                  sessions: controlOnlineSummary.sessionCount,
                  agents: controlOnlineSummary.agentCount
                })}
              </Typography.Text>
            </div>
            <Form
              className="settings-control-form settings-kanban-ant-form"
              layout="vertical"
              requiredMark={false}
              onFinish={() => void saveControlCloudConfig(controlCloudConfig)}
            >
              <Form.Item label={t("taskBoard.cloud.deviceAlias")}>
                <Input
                  value={controlCloudConfig.deviceAlias ?? ""}
                  onChange={(event) => setControlCloudConfig((current) => ({ ...current, deviceAlias: event.target.value }))}
                  placeholder={t("taskBoard.cloud.deviceAliasPlaceholder")}
                />
              </Form.Item>
              <Form.Item label={t("taskBoard.cloud.serverUrl")}>
                <Input
                  value={controlCloudConfig.serverUrl}
                  onChange={(event) => setControlCloudConfig((current) => ({ ...current, serverUrl: event.target.value }))}
                  placeholder="http://127.0.0.1:8080"
                />
              </Form.Item>
              <Form.Item
                label={t("taskBoard.cloud.projectId")}
                extra={controlProjectOptions.length > 0
                  ? t("taskBoard.cloud.projectSelectHelp", { count: controlProjectOptions.length })
                  : t("taskBoard.cloud.projectFallbackHelp")}
              >
                {controlProjectOptions.length > 0 ? (
                  <Select
                    value={controlCloudConfig.selectedProjectId}
                    options={controlProjectSelectOptions}
                    onChange={(value) => setControlCloudConfig((current) => ({ ...current, selectedProjectId: value }))}
                  />
                ) : (
                  <Input
                    value={controlCloudConfig.selectedProjectId}
                    onChange={(event) => setControlCloudConfig((current) => ({ ...current, selectedProjectId: event.target.value }))}
                    placeholder="default"
                  />
                )}
              </Form.Item>
              <Form.Item className="settings-control-actions settings-kanban-actions">
                <Button type="primary" htmlType="submit" loading={controlConfigSaving} disabled={controlConfigSaving}>
                  {t("settings.kanban.save")}
                </Button>
              </Form.Item>
            </Form>
          </Card>
        );
      case "market":
        return (
          <div className="settings-item-card settings-control-card" aria-label={t("settings.market.panelAria")}>
            <form className="settings-control-form" onSubmit={(event) => void handleSaveMarketSettings(event)}>
              <label className="settings-control-field">
                <span>{t("settings.market.apiBaseUrl")}</span>
                <Input
                  value={marketSettings.apiBaseUrl}
                  onChange={(event) => setMarketSettings((current) => ({ ...current, apiBaseUrl: event.target.value }))}
                  placeholder={t("settings.market.apiBaseUrlPlaceholder")}
                />
                <small>{t("settings.market.visibilityRule")}</small>
              </label>
              <div className="settings-control-actions">
                <Button type="primary" htmlType="submit" disabled={marketSettingsSaving} loading={marketSettingsSaving}>
                  {marketSettingsSaving ? t("settings.market.saving") : t("settings.market.save")}
                </Button>
              </div>
            </form>
          </div>
        );
      case "control": {
        const pairingPayloadResult = appPairingResult?.ok ? appPairingResult : null;
        const pairingErrorMessage = appPairingResult && !appPairingResult.ok ? appPairingResult.message : "";
        return (
          <>
            <div className="settings-item-card settings-mobile-pairing-card">
              <div className="settings-item-header settings-mobile-pairing-header">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.mobilePairing.title")}</strong>
                  <span>{t("settings.mobilePairing.description")}</span>
                </div>
                <Button
                  type="primary"
                  disabled={appPairingPending}
                  loading={appPairingPending}
                  onClick={() => void handleCreateAppPairingPayload()}
                >
                  {appPairingPending ? t("settings.mobilePairing.generating") : t("settings.mobilePairing.action")}
                </Button>
              </div>
              {pairingErrorMessage ? (
                <div className="settings-item-empty settings-mobile-pairing-error" role="alert">
                  {pairingErrorMessage}
                </div>
              ) : null}
              {pairingPayloadResult ? (
                <div className="settings-mobile-pairing-body">
                  <div className="settings-mobile-pairing-qr" aria-label={t("settings.mobilePairing.qrCode")}>
                    <QRCode
                      value={pairingPayloadResult.payloadText}
                      size={196}
                      bordered={false}
                      errorLevel="M"
                    />
                  </div>
                  <div className="settings-mobile-pairing-details">
                    <div className="settings-mobile-pairing-meta">
                      <span>{t("settings.mobilePairing.apiBaseUrl")}</span>
                      <code>{pairingPayloadResult.payload.apiBaseUrl}</code>
                    </div>
                    <div className="settings-mobile-pairing-meta">
                      <span>{t("settings.mobilePairing.expiresAt")}</span>
                      <code>{formatPairingExpiresAt(pairingPayloadResult.payload.expiresAt, locale)}</code>
                    </div>
                    <label className="settings-mobile-pairing-payload">
                      <span>{t("settings.mobilePairing.payload")}</span>
                      <Input.TextArea value={pairingPayloadResult.payloadText} readOnly spellCheck={false} autoSize={{ minRows: 3, maxRows: 8 }} />
                    </label>
                    <div className="settings-control-actions">
                      <Button
                        type="primary"
                        onClick={() => void handleCopyAppPairingPayload()}
                      >
                        {t("settings.mobilePairing.copy")}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="settings-item-empty">{t("settings.mobilePairing.empty")}</div>
              )}
            </div>
          </>
        );
      }
      case "tunnelHub":
        return (
          <div className="settings-item-card settings-control-card" aria-label={t("settings.tunnelHub.panelAria")}>
            <form className="settings-control-form" onSubmit={(event) => void handleSaveTunnelHubSettings(event)}>
              <label className="settings-control-field">
                <span>{t("settings.tunnelHub.deviceId")}</span>
                <Input
                  value={tunnelHubSettings.deviceId}
                  onChange={(event) => setTunnelHubSettings((current) => ({ ...current, deviceId: event.target.value }))}
                  placeholder={t("settings.tunnelHub.deviceIdPlaceholder")}
                />
              </label>
              <label className="settings-control-field">
                <span>{t("settings.tunnelHub.relayUrl")}</span>
                <Input
                  value={tunnelHubSettings.relayUrl}
                  onChange={(event) => setTunnelHubSettings((current) => ({ ...current, relayUrl: event.target.value }))}
                  placeholder={t("settings.tunnelHub.relayUrlPlaceholder")}
                />
              </label>
              <label className="settings-control-field">
                <span>{t("settings.tunnelHub.registrationToken")}</span>
                <Input.Password
                  value={tunnelHubRegistrationToken}
                  onChange={(event) => {
                    setTunnelHubRegistrationToken(event.target.value);
                    if (event.target.value.trim()) {
                      setTunnelHubClearRegistrationToken(false);
                    }
                  }}
                  placeholder={t("settings.tunnelHub.registrationTokenPlaceholder")}
                />
                <small>
                  {tunnelHubSettings.hasRegistrationToken
                    ? t("settings.tunnelHub.registrationTokenConfigured", { preview: tunnelHubSettings.registrationTokenPreview })
                    : t("settings.tunnelHub.registrationTokenMissing")}
                </small>
              </label>
              <Checkbox
                className="settings-control-field settings-checkbox-field"
                checked={tunnelHubClearRegistrationToken}
                disabled={Boolean(tunnelHubRegistrationToken.trim())}
                onChange={(event) => setTunnelHubClearRegistrationToken(event.target.checked)}
              >
                {t("settings.tunnelHub.clearRegistrationToken")}
              </Checkbox>
              <Checkbox
                className="settings-control-field settings-checkbox-field"
                checked={tunnelHubRotateRelayToken}
                onChange={(event) => setTunnelHubRotateRelayToken(event.target.checked)}
              >
                {t("settings.tunnelHub.rotateRelayToken")}
              </Checkbox>
              <Checkbox
                className="settings-control-field settings-checkbox-field"
                checked={tunnelHubSettings.tlsInsecureSkipVerify}
                onChange={(event) => setTunnelHubSettings((current) => ({ ...current, tlsInsecureSkipVerify: event.target.checked }))}
              >
                {t("settings.tunnelHub.tlsInsecure")}
              </Checkbox>
              <label className="settings-control-field">
                <span>{t("settings.tunnelHub.reconnectSeconds")}</span>
                <div className="settings-control-inline">
                  <InputNumber
                    min={1}
                    max={3600}
                    value={tunnelHubSettings.reconnectSeconds}
                    onChange={(value) => setTunnelHubSettings((current) => ({
                      ...current,
                      reconnectSeconds: typeof value === "number" ? value : 3
                    }))}
                  />
                  <small>{t("settings.tunnelHub.reconnectUnit")}</small>
                </div>
              </label>
              {tunnelHubSettings.publicUrl || tunnelHubSettings.webSocketUrl || tunnelHubSettings.targetUrl ? (
                <div className="settings-control-field settings-readonly-stack">
                  {tunnelHubSettings.publicHost ? (
                    <small>{t("settings.tunnelHub.publicHost")}: <code>{tunnelHubSettings.publicHost}</code></small>
                  ) : null}
                  {tunnelHubSettings.publicUrl ? (
                    <small>{t("settings.tunnelHub.publicUrl")}: <code>{tunnelHubSettings.publicUrl}</code></small>
                  ) : null}
                  {tunnelHubSettings.webSocketUrl ? (
                    <small>{t("settings.tunnelHub.webSocketUrl")}: <code>{tunnelHubSettings.webSocketUrl}</code></small>
                  ) : null}
                  {tunnelHubSettings.targetUrl ? (
                    <small>{t("settings.tunnelHub.targetUrl")}: <code>{tunnelHubSettings.targetUrl}</code></small>
                  ) : null}
                </div>
              ) : null}
              <div className="settings-control-actions">
                <Button type="primary" htmlType="submit" disabled={tunnelHubSaving} loading={tunnelHubSaving}>
                  {tunnelHubSaving ? t("settings.tunnelHub.saving") : t("settings.tunnelHub.save")}
                </Button>
              </div>
            </form>
          </div>
        );

      case "navigation": {
        const defaultCopilotPages = createDefaultDesktopCopilotPagePreferences();
        const navigationSettingsOrder = sidebarNavOrder;
        const visibleFixedNavigationTools = fixedNavigationTools.filter((tool) => tool.id !== "market" || marketEnabled);
        function renderFixedNavigationToolRow(tool: FixedNavigationToolConfig) {
          const copilotPageKey = tool.copilotPageKey;
          const toolLabel = t(tool.labelKey);
          const fixedAssistantLabel = tool.fixedAssistantLabelKey ? t(tool.fixedAssistantLabelKey) : null;
          const copilotPreference = copilotPageKey
            ? desktopCopilotPages[copilotPageKey] ?? defaultCopilotPages[copilotPageKey]
            : null;
          const copilotPending = Boolean(
            copilotPageKey &&
            (desktopCopilotPagePending === copilotPageKey || desktopCopilotPagePending === "all")
          );
          const selectedCopilotAgentKey = copilotPreference?.enabled ? copilotPreference.agentKey : "";
          const selectedAgentAvailable = Boolean(
            selectedCopilotAgentKey && assistantAgentOptions.some((agent) => agent.agentKey === selectedCopilotAgentKey)
          );
          const showUnavailableAgentOption = Boolean(selectedCopilotAgentKey && !selectedAgentAvailable);
          const assistantSelectValue = fixedAssistantLabel ? "__fixed__" : selectedCopilotAgentKey;
          return (
            <div className="navigation-order-row navigation-order-row-fixed settings-item-row" role="listitem" key={tool.id}>
              <div className="navigation-order-title-cell navigation-order-title-cell-fixed" title={t("settings.navigation.fixedEntry")}>
                <span className="navigation-order-title">{toolLabel}</span>
              </div>
              <label className="navigation-order-assistant-field">
                <span className="desktop-pet-agent-select-wrap">
                  <Select
                    style={{ width: "100%" }}
                    value={assistantSelectValue}
                    onChange={(value) => {
                      if (copilotPageKey) {
                        void handleSelectNavigationCopilotAgent(copilotPageKey, value);
                      }
                    }}
                    disabled={!copilotPageKey || assistantAgentOptions.length === 0 || copilotPending}
                    aria-label={t("settings.navigation.sideAssistantFor", { label: toolLabel })}
                    options={[
                      { value: "", label: t("settings.navigation.noSideAssistant") },
                      ...(fixedAssistantLabel ? [{ value: "__fixed__", label: fixedAssistantLabel }] : []),
                      ...(showUnavailableAgentOption ? [{
                        value: selectedCopilotAgentKey,
                        label: assistantAgentOptions.length === 0
                          ? t("settings.navigation.agentsLoading")
                          : t("settings.navigation.unavailableAgent", { agentKey: selectedCopilotAgentKey })
                      }] : []),
                      ...assistantAgentOptions.map((agent) => ({
                        value: agent.agentKey,
                        label: `${agent.displayName}${agent.role ? ` · ${agent.role}` : ""}`
                      }))
                    ]}
                  />
                </span>
              </label>
              <div className="navigation-order-fixed-label">{t("settings.navigation.fixed")}</div>
            </div>
          );
        }
          return (
            <div className="settings-item-card navigation-settings-card" aria-label={t("settings.navigation.panelAria")}>
              <div className="settings-item-section-head website-list-head navigation-assistant-default-head">
                <div>
                  <strong>{t("settings.navigation.defaultAssistant")}</strong>
                  <span>{t("settings.navigation.defaultAssistantDescription")}</span>
                </div>
              </div>
              <div className="settings-item-form navigation-assistant-default">
                <span className="desktop-pet-agent-select-wrap navigation-assistant-default-select">
                  <Select
                    style={{ width: "100%" }}
                    value={assistantAgentOptions.some((agent) => agent.agentKey === desktopHelperAgentKey) ? desktopHelperAgentKey : ""}
                    onChange={(value) => void handleSelectDesktopHelperAgentKey(value)}
                    disabled={assistantAgentOptions.length === 0 || desktopHelperAgentPending}
                    aria-label={t("settings.navigation.defaultAssistant")}
                    options={[
                      {
                        value: "",
                        label: assistantAgentOptions.length === 0 ? t("settings.navigation.agentsLoading") : t("settings.navigation.selectAgent")
                      },
                      ...assistantAgentOptions.map((agent) => ({
                        value: agent.agentKey,
                        label: `${agent.displayName}${agent.role ? ` · ${agent.role}` : ""}`
                      }))
                    ]}
                  />
                </span>
              </div>
              <div className="settings-item-section-head website-list-head">
                <div>
                  <strong>{t("settings.navigation.fixedMain")}</strong>
                  <span>{t("settings.navigation.fixedMainDescription")}</span>
                </div>
              </div>
              <div className="settings-item-list navigation-order-list" role="list" aria-label={t("settings.navigation.fixedMainOrder")}>
                {navigationSettingsOrder.map((itemKey, index) => {
                    const itemLabel = sidebarNavOrderLabels.get(itemKey) ?? itemKey;
                    const copilotPageKey = getCopilotPageKeyForSidebarNavOrderItem(itemKey);
                    const copilotPreference = copilotPageKey
                      ? desktopCopilotPages[copilotPageKey] ?? createDefaultDesktopCopilotPagePreferences()[copilotPageKey]
                      : null;
                    const copilotPending = Boolean(
                      copilotPageKey &&
                      (desktopCopilotPagePending === copilotPageKey || desktopCopilotPagePending === "all")
                    );
                    const selectedCopilotAgentKey = copilotPreference?.enabled ? copilotPreference.agentKey : "";
                    const fixedAssistantLabel = copilotPageKey
                      ? null
                      : getFixedAssistantLabelForSidebarNavOrderItem(itemKey, t);
                    const assistantSelectValue = fixedAssistantLabel ? "__fixed__" : selectedCopilotAgentKey;
                    const selectedAgentAvailable = Boolean(
                      selectedCopilotAgentKey && assistantAgentOptions.some((agent) => agent.agentKey === selectedCopilotAgentKey)
                    );
                    const showUnavailableAgentOption = Boolean(
                      selectedCopilotAgentKey && !selectedAgentAvailable
                    );
                    return (
                      <div
                        className="settings-item-row navigation-order-row"
                        data-sidebar-nav-order-key={itemKey}
                        key={itemKey}
                        role="listitem"
                      >
                        <div
                          className="navigation-order-title-cell"
                          title={t("settings.navigation.itemTitle", { index: index + 1 })}
                        >
                          <span className="navigation-order-title">{itemLabel}</span>
                        </div>
                        <label className="navigation-order-assistant-field">
                          <span className="desktop-pet-agent-select-wrap">
                            <Select
                              style={{ width: "100%" }}
                              value={assistantSelectValue}
                              onChange={(value) => {
                                if (copilotPageKey) {
                                  void handleSelectNavigationCopilotAgent(copilotPageKey, value);
                                }
                              }}
                              disabled={!copilotPageKey || assistantAgentOptions.length === 0 || copilotPending}
                              aria-label={t("settings.navigation.sideAssistantFor", { label: itemLabel })}
                              options={[
                                { value: "", label: t("settings.navigation.noSideAssistant") },
                                ...(fixedAssistantLabel ? [{ value: "__fixed__", label: fixedAssistantLabel }] : []),
                                ...(showUnavailableAgentOption ? [{
                                  value: selectedCopilotAgentKey,
                                  label: assistantAgentOptions.length === 0
                                    ? t("settings.navigation.agentsLoading")
                                    : t("settings.navigation.unavailableAgent", { agentKey: selectedCopilotAgentKey })
                                }] : []),
                                ...assistantAgentOptions.map((agent) => ({
                                  value: agent.agentKey,
                                  label: `${agent.displayName}${agent.role ? ` · ${agent.role}` : ""}`
                                }))
                              ]}
                            />
                          </span>
                        </label>
                        <div className="navigation-order-actions">
                          <span className="navigation-order-fixed-label">{t("settings.navigation.itemIndex", { index: index + 1 })}</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
              <div className="settings-item-section-head website-list-head navigation-fixed-tools-head">
                <div>
                  <strong>{t("settings.navigation.fixedTools")}</strong>
                  <span>{t("settings.navigation.fixedToolsDescription")}</span>
                </div>
              </div>
              <div className="settings-item-list navigation-order-list navigation-fixed-tool-list" role="list" aria-label={t("settings.navigation.fixedTools")}>
                {visibleFixedNavigationTools.map((tool) => renderFixedNavigationToolRow(tool))}
              </div>
            </div>
          );
      }

      case "embeddedWebs":
        return (
          <div className="settings-item-card website-card">
            {!editingWebsiteId ? (
              <>
                <div className="settings-item-section-head website-list-head website-add-head">
                  <div>
                    <strong>{t("settings.embeddedWebs.addTitle")}</strong>
                    <span>{t("settings.embeddedWebs.addDescription")}</span>
                  </div>
                </div>
                <div className="settings-item-form website-add-form">
                  <form className="website-form" onSubmit={(event) => void handleAddWebsiteItem(event)}>
                    <label>
                      <span>{t("settings.embeddedWebs.displayName")}</span>
                      <Input
                        value={websiteLabel}
                        onChange={(event) => setWebsiteLabel(event.target.value)}
                        placeholder={t("settings.embeddedWebs.displayNamePlaceholder")}
                        maxLength={24}
                      />
                    </label>
                    <label>
                      <span>{t("settings.embeddedWebs.url")}</span>
                      <Input
                        value={websiteUrl}
                        onChange={(event) => setWebsiteUrl(event.target.value)}
                        placeholder={t("settings.embeddedWebs.urlPlaceholder")}
                        required
                      />
                    </label>
                    <div className="website-submit-wrap">
                      <Button type="link" htmlType="submit" className="website-submit" disabled={websitePending} loading={websitePending}>
                        {websitePending ? t("settings.embeddedWebs.adding") : t("settings.embeddedWebs.add")}
                      </Button>
                    </div>
                  </form>
                </div>
              </>
            ) : null}

            <div className="settings-item-section-head website-list-head website-added-head">
              <div>
                <strong>{t("settings.embeddedWebs.addedTitle")}</strong>
                <span>{t("settings.embeddedWebs.addedDescription")}</span>
              </div>
              <div className="settings-item-section-actions">
                <Button
                  type="link"
                  onClick={() => void handleImportWebsiteItems()}
                  disabled={websiteTransferPending !== "" || Boolean(editingWebsiteId)}
                >
                  {websiteTransferPending === "import" ? t("settings.embeddedWebs.importing") : t("settings.embeddedWebs.import")}
                </Button>
                <Button
                  type="link"
                  onClick={() => void handleExportWebsiteItems()}
                  disabled={websiteTransferPending !== "" || Boolean(editingWebsiteId)}
                >
                  {websiteTransferPending === "export" ? t("settings.embeddedWebs.exporting") : t("settings.embeddedWebs.export")}
                </Button>
              </div>
            </div>
            {websiteItems.length === 0 ? (
              <div className="settings-item-empty website-empty">{t("settings.embeddedWebs.empty")}</div>
            ) : (
              <div className="settings-item-list website-list" role="list" aria-label={t("settings.embeddedWebs.addedTitle")}>
                {websiteItems.map((item) => {
                  const itemAgentKey = item.agentKey || "";
                  const itemAgentKnown = !itemAgentKey || assistantAgentOptions.some((agent) => agent.agentKey === itemAgentKey);
                  const itemAgentPending = websiteAgentPendingId === item.id;
                  const itemEditing = editingWebsiteId === item.id;
                  return (
                    <div
                      className={itemEditing ? "settings-item-row website-row is-editing" : "settings-item-row website-row"}
                      key={item.id}
                      role="listitem"
                    >
                      {itemEditing ? (
                        <form
                          className="website-row-edit-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleUpdateWebsiteItem(item.id);
                          }}
                        >
                          <label>
                            <span>{t("settings.embeddedWebs.displayName")}</span>
                            <Input
                              value={websiteLabel}
                              onChange={(event) => setWebsiteLabel(event.target.value)}
                              placeholder={t("settings.embeddedWebs.displayNamePlaceholder")}
                              maxLength={24}
                              required
                            />
                          </label>
                          <label>
                            <span>{t("settings.embeddedWebs.url")}</span>
                            <Input
                              value={websiteUrl}
                              onChange={(event) => setWebsiteUrl(event.target.value)}
                              placeholder={t("settings.embeddedWebs.urlPlaceholder")}
                              required
                            />
                          </label>
                          <div className="website-row-actions">
                            <Button type="link" htmlType="submit" disabled={websitePending} loading={websitePending}>
                              {websitePending ? t("settings.embeddedWebs.updating") : t("settings.embeddedWebs.save")}
                            </Button>
                            <Button
                              type="link"
                              onClick={handleCancelEditWebsiteItem}
                              disabled={websitePending}
                            >
                              {t("settings.embeddedWebs.cancel")}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="website-site-cell">
                            <strong>{item.label}</strong>
                            <span className="website-site-url" title={item.url}>
                              {item.url}
                            </span>
                          </div>
                          <label className="website-agent-field">
                            <span className="desktop-pet-agent-select-wrap">
                              <Select
                                style={{ width: "100%" }}
                                value={itemAgentKey}
                                onChange={(value) => void handleUpdateWebsiteAgent(item.id, value)}
                                disabled={assistantAgentOptions.length === 0 || itemAgentPending || Boolean(editingWebsiteId)}
                                aria-label={t("settings.embeddedWebs.linkedAgentFor", { label: item.label })}
                                options={[
                                  { value: "", label: t("settings.defaultAssistant") },
                                  ...(itemAgentKey && !itemAgentKnown ? [{
                                    value: itemAgentKey,
                                    label: t("settings.navigation.unavailableAgent", { agentKey: itemAgentKey })
                                  }] : []),
                                  ...assistantAgentOptions.map((agent) => ({
                                    value: agent.agentKey,
                                    label: `${agent.displayName}${agent.role ? ` · ${agent.role}` : ""}`
                                  }))
                                ]}
                              />
                            </span>
                          </label>
                          <div className="website-row-actions">
                            <Button
                              type="link"
                              onClick={() => handleStartEditWebsiteItem(item)}
                              disabled={websitePending || deletingWebsiteId === item.id || Boolean(editingWebsiteId)}
                            >
                              {t("settings.embeddedWebs.edit")}
                            </Button>
                            <Button
                              type="link"
                              danger
                              onClick={() => void handleDeleteWebsiteItem(item)}
                              disabled={deletingWebsiteId === item.id || Boolean(editingWebsiteId)}
                            >
                              {deletingWebsiteId === item.id ? t("settings.embeddedWebs.deleting") : t("settings.embeddedWebs.delete")}
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      case "dataRoot":
        return isWindows ? <WindowsDataRootCard /> : null;
      case "memory":
        return (
          <div className="data-root-card assistant-memory-card">
            <div className="website-copy assistant-memory-copy">
              <h2>{t("settings.memory.label")}</h2>
              <p className="page-copy">
                {t("settings.memory.sectionDescription")}
              </p>
              <div className="assistant-memory-stats" aria-label={t("settings.memory.statsLabel")}>
                <div>
                  <strong>{memoryTotal}</strong>
                  <span>{t("settings.memory.statsTotal")}</span>
                </div>
                <div>
                  <strong>{memoryFactCount}</strong>
                  <span>{t("settings.memory.statsStable")}</span>
                </div>
                <div>
                  <strong>{memoryObservationCount}</strong>
                  <span>{t("settings.memory.statsObservation")}</span>
                </div>
              </div>
              <div className="assistant-memory-timeline" aria-label={t("settings.memory.timelineLabel")}>
                <span>{t("settings.memory.learnedAt", { time: formatMemoryTime(memoryStats?.lastLearnedAt, locale, t) })}</span>
                <span>{t("settings.memory.referencedAt", { time: formatMemoryTime(memoryStats?.lastReferencedAt, locale, t) })}</span>
              </div>
              <p className="assistant-memory-audit">
                {t("settings.memory.recentRecord", { summary: formatMemoryAuditSummary(memoryRecentAudit, t) })}
              </p>
            </div>
            <div className="assistant-memory-panel">
              <div className="settings-item-card assistant-memory-settings-card">
                <div className="settings-item-list assistant-memory-switches">
                  <div className="settings-item-row assistant-memory-switch-row">
                    <span className="assistant-memory-switch-copy">
                      <span>{t("settings.memory.recall")}</span>
                      <small>{memoryRecallLabel}</small>
                    </span>
                    <Switch
                      checked={Boolean(memorySettings?.enabled)}
                      aria-label={t("settings.memory.recall")}
                      disabled={!memorySettings || memoryPending === "settings"}
                      onChange={() => void handleToggleMemoryEnabled()}
                    />
                  </div>
                  <div className="settings-item-row assistant-memory-switch-row">
                    <span className="assistant-memory-switch-copy">
                      <span>{t("settings.memory.autoLearn")}</span>
                      <small>{memoryAutoLearnLabel}</small>
                    </span>
                    <Switch
                      checked={Boolean(memorySettings?.autoLearn)}
                      aria-label={t("settings.memory.autoLearn")}
                      disabled={!memorySettings || memoryPending === "settings"}
                      onChange={() => void handleToggleMemoryAutoLearn()}
                    />
                  </div>
                </div>
                <div className="settings-item-section-head website-list-head assistant-memory-section-head">
                  <div>
                    <strong>{t("settings.memory.recent")}</strong>
                    <span>
                      {memoryItems.length > 0
                        ? t("settings.memory.recentCount", { shown: recentMemoryItems.length, total: memoryItems.length })
                        : t("common.none")}
                    </span>
                  </div>
                </div>
                {recentMemoryItems.length > 0 ? (
                  <div className="settings-item-list assistant-memory-list">
                    {recentMemoryItems.map((item) => (
                      <div className="settings-item-row assistant-memory-row" key={item.id}>
                        <div className="assistant-memory-row-main">
                          <div className="assistant-memory-row-title">
                            <strong>{item.title}</strong>
                            <span>{item.category} / {formatMemoryStatus(item.status, t)}</span>
                          </div>
                          <p>{formatMemoryPreview(item.summary, 64)}</p>
                        </div>
                        <time dateTime={item.updatedAt}>{formatMemoryTime(item.updatedAt, locale, t)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="settings-item-empty">{t("settings.memory.recentEmpty")}</div>
                )}
                <div className="settings-item-form assistant-memory-storage-card">
                <div className="assistant-memory-storage-header">
                  <div>
                    <strong>{t("settings.memory.storage")}</strong>
                    <span>{t("settings.memory.storageDescription")}</span>
                  </div>
                  <span className="assistant-memory-storage-actions">
                    <Button
                      type="link"
                      onClick={() => void handleOpenMemoryDirectory()}
                      disabled={memoryPending === "open"}
                    >
                      {memoryPending === "open" ? t("settings.memory.openingDirectory") : t("settings.memory.openDirectory")}
                    </Button>
                    <Button
                      type="link"
                      danger
                      onClick={() => void handleClearMemoryItems()}
                      disabled={memoryTotal === 0 || memoryPending === "clear"}
                    >
                      {memoryPending === "clear" ? t("settings.memory.clearing") : t("common.clear")}
                    </Button>
                  </span>
                </div>
                <details className="assistant-memory-storage-details">
                  <summary>
                    <span>{t("settings.memory.viewLocalPaths")}</span>
                    <span className="assistant-memory-storage-caret" aria-hidden="true" />
                  </summary>
                  <div className="assistant-memory-storage">
                    <div>
                      <span>{t("settings.memory.directoryPath")}</span>
                      <code>{memoryStorage?.directoryPath ?? t("settings.memory.loadingValue")}</code>
                    </div>
                    <div>
                      <span>{t("settings.memory.recordsPath")}</span>
                      <code>{memoryStorage?.recordsPath ?? t("settings.memory.loadingValue")}</code>
                    </div>
                    <div>
                      <span>{t("settings.memory.staticPath")}</span>
                      <code>{memoryStorage?.staticPath ?? t("settings.memory.loadingValue")}</code>
                    </div>
                    <div>
                      <span>{t("settings.memory.auditPath")}</span>
                      <code>{memoryStorage?.auditPath ?? t("settings.memory.loadingValue")}</code>
                    </div>
                  </div>
                </details>
                </div>
              </div>
            </div>
          </div>
        );
      case "about":
        return (
          <AboutAppCard
            runtimeResetPending={runtimeResetPending}
            runtimeResetResult={runtimeResetResult}
            onResetRuntimeEnv={handleResetRuntimeEnv}
          />
        );
      case "debug":
        return (
          <div className="settings-about-stack" aria-label={t("settings.debug.label")}>
            <LocalWsServerDebugCard />
            <DesktopLogsDebugCard />
            <IdentityTokenDebugCard />
            <TunnelDebugCard />
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <section
      className="settings-page settings-page-single"
      data-settings-section={activeSectionDefinition?.id ?? ""}
    >
      <div className="settings-content-panel" ref={contentRef}>
        <div className="settings-content-shell">
          <div className="settings-page-head">
            <div className="settings-page-head-copy">
              <h1>{activeSectionDefinition?.label ?? t("settings.title")}</h1>
              <p className="page-copy">{activeSectionDefinition?.description ?? t("settings.description")}</p>
            </div>
            <div className="settings-page-head-action">
              {renderSectionHeaderAction()}
            </div>
          </div>

          <div className="settings-section-body">
            {activeSectionNotice ? (
              <div className="settings-section-feedback">
                <PageFeedbackStack
                  items={[{
                    id: activeSectionNotice.id,
                    tone: activeSectionNotice.tone,
                    message: activeSectionNotice.message,
                    onDismiss: () => dismissSectionNotice(activeSectionNotice.id)
                  }]}
                />
              </div>
            ) : null}
            {activeSectionReadError ? (
              <div className="feedback-banner warning-banner settings-section-read-error" role="alert">
                {activeSectionReadError}
              </div>
            ) : null}
            {renderActiveSection()}
          </div>
        </div>
      </div>
    </section>
  );
}
