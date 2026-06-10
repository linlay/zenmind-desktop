import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
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
  CustomSidebarItem,
  DesktopAppInfo,
  DesktopPetAgentOption,
  DesktopPetState,
  DesktopRuntimeEnvResetResult,
  TaskBoardCloudConfig,
  TaskBoardDesktopOnlineResult,
  TaskBoardProject
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
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS
} from "../../../shared/desktop-pet";
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
  customSidebarItems: CustomSidebarItem[];
  onCustomSidebarItemsChange: (items: CustomSidebarItem[]) => void;
  onAssistantSettingsChange?: (settings: AssistantSettingsPublic) => void;
};

type NoticeTone = "success" | "error";

type SettingsNotice = {
  id: number;
  sectionId: SettingsSectionId;
  tone: NoticeTone;
  message: string;
};

type SectionReadErrorMap = Partial<Record<SettingsSectionId, string>>;

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
  "quickAssistant",
  "embeddedWebsites"
];

const defaultTaskBoardCloudConfig: TaskBoardCloudConfig = {
  serverUrl: "",
  token: "",
  selectedProjectId: "default",
  remoteControlEnabled: false
};

const defaultTaskBoardOnlineSummary: TaskBoardDesktopOnlineResult = {
  ok: false,
  online: false,
  deviceCount: 0,
  sessionCount: 0,
  agentCount: 0,
  devices: []
};

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
  if (itemKey === "group:assistants" || itemKey === "group:websites") {
    return t("nav.group.fixedEntry");
  }
  if (itemKey.startsWith("custom:")) {
    return t("settings.configuredInEmbeddedWebsites");
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

function AboutAppCard() {
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
          setAppInfo({ version: "" });
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

  return (
    <div className="settings-item-card settings-about-card" aria-label={t("settings.about.label")}>
      <div className="settings-item-row settings-about-row">
        <div className="settings-about-copy">
          <strong>{t("settings.about.version")}</strong>
          <span>{t("settings.about.versionDescription")}</span>
        </div>
        <div className="settings-about-version" aria-live="polite">
          {version}
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
  customSidebarItems,
  onCustomSidebarItemsChange,
  onAssistantSettingsChange
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const { sectionId: sectionIdParam } = useParams();
  const currentRoute = `${location.pathname}${location.search}`;
  const noticeIdRef = useRef(0);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [sectionReadErrors, setSectionReadErrors] = useState<SectionReadErrorMap>({});
  const [customSidebarLabel, setCustomSidebarLabel] = useState("");
  const [customSidebarUrl, setCustomSidebarUrl] = useState("");
  const [editingCustomSidebarId, setEditingCustomSidebarId] = useState("");
  const [customSidebarPending, setCustomSidebarPending] = useState(false);
  const [customSidebarTransferPending, setCustomSidebarTransferPending] = useState("");
  const [customSidebarAgentPendingId, setCustomSidebarAgentPendingId] = useState("");
  const [deletingCustomSidebarId, setDeletingCustomSidebarId] = useState("");
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
  const [desktopPetBoundAgentKey, setDesktopPetBoundAgentKey] = useState(DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  const [desktopPetBoundAgentPending, setDesktopPetBoundAgentPending] = useState(false);
  const [desktopPetAppearancePending, setDesktopPetAppearancePending] = useState("");
  const [controlCloudConfig, setControlCloudConfig] = useState<TaskBoardCloudConfig>(defaultTaskBoardCloudConfig);
  const [controlCloudProjects, setControlCloudProjects] = useState<TaskBoardProject[]>([]);
  const [controlConnectionState, setControlConnectionState] = useState<TaskBoardConnectionState>("disabled");
  const [controlOnlineSummary, setControlOnlineSummary] = useState<TaskBoardDesktopOnlineResult>(defaultTaskBoardOnlineSummary);
  const [controlConfigSaving, setControlConfigSaving] = useState(false);
  const [runtimeResetPending, setRuntimeResetPending] = useState(false);
  const [runtimeResetResult, setRuntimeResetResult] = useState<DesktopRuntimeEnvResetResult | null>(null);
  const desktopPetSupported = isMac || isWindows;
  const contentRef = useRef<HTMLDivElement>(null);
  const memoryDataLoadedRef = useRef(false);
  const assistantSettingsLoadedRef = useRef(false);
  const desktopPetStateLoadedRef = useRef(false);
  const sectionDefinitions = useMemo(
    () => buildLocalizedSettingsSections({ isWindows, t }),
    [isWindows, t]
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
  const shouldReadControlData = activeSection === "control";
  const shouldReadAssistantSettings = Boolean(
    activeSection && ASSISTANT_SETTINGS_SECTION_IDS.includes(activeSection)
  );
  const shouldReadDesktopPetState = desktopPetSupported && activeSection === "desktopPet";
  const controlProjectOptions = useMemo(
    () => sortTaskBoardProjectOptions(controlCloudProjects),
    [controlCloudProjects]
  );
  const selectedControlProjectId = controlCloudConfig.selectedProjectId.trim();
  const selectedControlProjectMissing = Boolean(
    selectedControlProjectId && !controlProjectOptions.some((project) => project.id === selectedControlProjectId)
  );

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
    if (!shouldReadControlData) {
      return;
    }

    let cancelled = false;
    async function refreshControlState() {
      try {
        const [configResult, onlineResult, issueResult] = await Promise.all([
          window.electronAPI.taskBoard.getCloudConfig(),
          window.electronAPI.taskBoard.listOnlineDevices(),
          window.electronAPI.taskBoard.listIssues()
        ]);
        if (cancelled) {
          return;
        }
        setControlCloudConfig({
          ...defaultTaskBoardCloudConfig,
          ...configResult.config
        });
        setControlCloudProjects(issueResult.projects ?? []);
        setControlConnectionState(configResult.connectionState ?? issueResult.connectionState ?? "disabled");
        setControlOnlineSummary(onlineResult);
        setReadErrorSections(["control"], "");
      } catch (reason) {
        if (!cancelled) {
          setReadErrorSections(["control"], reason instanceof Error ? reason.message : String(reason));
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
      window.electronAPI.assistant.listCopilotAgents()
    ])
      .then(([settings, agentsResult]) => {
        if (cancelled) {
          assistantSettingsLoadedRef.current = false;
          return;
        }
        if (!agentsResult.ok) {
          throw new Error(agentsResult.message);
        }
        setAssistantSettings(settings);
        setDesktopHelperAgentKey(settings.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY);
        setQuickAssistantEnabled(settings.quickAssistantEnabled);
        setQuickAssistantAgentKey(settings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
        setDesktopCopilotPages(settings.desktopCopilotPages || createDefaultDesktopCopilotPagePreferences());
        setAssistantAgentOptions(toAssistantAgentOptions(Array.isArray(agentsResult.items) ? agentsResult.items : []));
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
          setReadErrorSections(["desktopPet"], "");
        })
        .catch((reason) => {
          desktopPetStateLoadedRef.current = false;
          if (!cancelled) {
            setReadErrorSections(["desktopPet"], reason instanceof Error ? reason.message : String(reason));
          }
        });
    }

    const dispose = window.electronAPI.desktopPet.onStateChanged((state) => {
      if (!cancelled) {
        desktopPetStateLoadedRef.current = true;
        setDesktopPetState(state);
        setReadErrorSections(["desktopPet"], "");
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [shouldReadDesktopPetState]);

  useEffect(() => {
    if (desktopPetState?.boundAgentKey) {
      setDesktopPetBoundAgentKey(desktopPetState.boundAgentKey);
    }
  }, [desktopPetState?.boundAgentKey]);

  const currentDesktopPetBoundAgentKey = desktopPetState?.boundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
  const desktopPetAgentOptions = desktopPetState?.agentOptions ?? [];
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
        desktopPetBoundAgentKey: {
          value: currentDesktopPetBoundAgentKey,
          saved: currentDesktopPetBoundAgentKey
        },
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
      setReadErrorSections(["sideAssistant"], "");
      showSectionNotice("sideAssistant", t("settings.navigation.sideAssistantSaved"), "success");
      return nextSettings;
    } catch (reason) {
      setDesktopCopilotPages(previousPages);
      showSectionNotice("sideAssistant", reason instanceof Error ? reason.message : String(reason), "error");
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
            setReadErrorSections(["quickAssistant"], "");
            showSectionNotice(
              "quickAssistant",
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
            setReadErrorSections(["quickAssistant"], "");
            showSectionNotice(
              "quickAssistant",
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
    currentDesktopPetBoundAgentKey,
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

  async function handleAddCustomSidebarItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setCustomSidebarPending(true);
    try {
      const result = await window.electronAPI.customSidebar.add({
        label: customSidebarLabel,
        url: customSidebarUrl
      });
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
      if (result.ok) {
        setCustomSidebarLabel("");
        setCustomSidebarUrl("");
      }
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCustomSidebarPending(false);
    }
  }

  function resetCustomSidebarForm() {
    setEditingCustomSidebarId("");
    setCustomSidebarLabel("");
    setCustomSidebarUrl("");
  }

  function handleStartEditCustomSidebarItem(item: CustomSidebarItem) {
    setEditingCustomSidebarId(item.id);
    setCustomSidebarLabel(item.label);
    setCustomSidebarUrl(item.url);
    setNotice((current) => current?.sectionId === "embeddedWebsites" ? null : current);
  }

  function handleCancelEditCustomSidebarItem() {
    resetCustomSidebarForm();
  }

  async function handleUpdateCustomSidebarItem(itemId: string) {
    setCustomSidebarPending(true);
    try {
      const result = await window.electronAPI.customSidebar.update(itemId, {
        label: customSidebarLabel,
        url: customSidebarUrl
      });
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
      if (result.ok) {
        resetCustomSidebarForm();
      }
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCustomSidebarPending(false);
    }
  }

  async function handleDeleteCustomSidebarItem(item: CustomSidebarItem) {
    setDeletingCustomSidebarId(item.id);
    try {
      const result = await window.electronAPI.customSidebar.remove(item.id);
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
      if (editingCustomSidebarId === item.id) {
        resetCustomSidebarForm();
      }
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDeletingCustomSidebarId("");
    }
  }

  async function handleUpdateCustomSidebarAgent(itemId: string, agentKey: string) {
    setCustomSidebarAgentPendingId(itemId);
    try {
      const result = await window.electronAPI.customSidebar.update(itemId, { agentKey });
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCustomSidebarAgentPendingId("");
    }
  }

  async function handleImportCustomSidebarItems() {
    setCustomSidebarTransferPending("import");
    try {
      const result = await window.electronAPI.customSidebar.import();
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
      resetCustomSidebarForm();
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCustomSidebarTransferPending("");
    }
  }

  async function handleExportCustomSidebarItems() {
    setCustomSidebarTransferPending("export");
    try {
      const result = await window.electronAPI.customSidebar.export();
      showSectionNotice(
        "embeddedWebsites",
        result.path ? `${result.message} ${result.path}` : result.message,
        result.ok ? "success" : "error"
      );
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCustomSidebarTransferPending("");
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
    setDesktopPetPending(true);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        enabled: !desktopPetState?.enabled
      });
      setDesktopPetState(nextState);
      setReadErrorSections(["appearance"], "");
      showSectionNotice("appearance", nextState.enabled ? t("settings.desktopPet.noticeEnabled") : t("settings.desktopPet.noticeDisabled"), "success");
    } catch (reason) {
      showSectionNotice("appearance", reason instanceof Error ? reason.message : String(reason), "error");
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
      setReadErrorSections(["appearance"], "");
      if (nextState.appearanceId === appearanceId) {
        showSectionNotice(
          "desktopPet",
          t("settings.desktopPet.noticeAppearanceChanged", {
            name: getDesktopPetAppearanceLabel(appearanceId, selectedAppearance?.displayName ?? appearanceId, t)
          }),
          "success"
        );
      } else {
        showSectionNotice("appearance", t("settings.desktopPet.noticeAppearanceFailed"), "error");
      }
    } catch (reason) {
      showSectionNotice("appearance", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopPetAppearancePending("");
    }
  }

  async function handleSelectDesktopPetBoundAgentKey(nextBoundAgentKey: string) {
    const normalizedBoundAgentKey = nextBoundAgentKey.trim();
    const previousBoundAgentKey = desktopPetState?.boundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
    if (!desktopPetSupported || !desktopPetState || !normalizedBoundAgentKey || normalizedBoundAgentKey === desktopPetState.boundAgentKey) {
      return;
    }

    setDesktopPetBoundAgentPending(true);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        boundAgentKey: normalizedBoundAgentKey
      });
      const nextAgent = nextState.agentOptions.find((agent) => agent.agentKey === nextState.boundAgentKey);
      setDesktopPetState(nextState);
      setDesktopPetBoundAgentKey(nextState.boundAgentKey);
      setReadErrorSections(["appearance"], "");
      showSectionNotice("appearance", t("settings.desktopPet.noticeBoundAgentChanged", { name: nextAgent?.displayName ?? nextState.boundAgentKey }), "success");
    } catch (reason) {
      setDesktopPetBoundAgentKey(previousBoundAgentKey);
      showSectionNotice("appearance", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopPetBoundAgentPending(false);
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
      setReadErrorSections(["sideAssistant"], "");
      showSectionNotice(
        "sideAssistant",
        t("settings.navigation.defaultAgentChanged", { name: nextAgent?.displayName ?? nextSettings.desktopHelperAgentKey }),
        "success"
      );
    } catch (reason) {
      setDesktopHelperAgentKey(previousAgentKey);
      showSectionNotice("sideAssistant", reason instanceof Error ? reason.message : String(reason), "error");
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
      setReadErrorSections(["quickAssistant"], "");
      showSectionNotice(
        "quickAssistant",
        nextSettings.quickAssistantEnabled ? t("settings.quickAssistant.noticeEnabled") : t("settings.quickAssistant.noticeDisabled"),
        "success"
      );
    } catch (reason) {
      setQuickAssistantEnabled(previousEnabled);
      showSectionNotice("quickAssistant", reason instanceof Error ? reason.message : String(reason), "error");
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
      setReadErrorSections(["quickAssistant"], "");
      showSectionNotice(
        "quickAssistant",
        t("settings.quickAssistant.noticeAgentChanged", { name: nextAgent?.displayName ?? nextSettings.quickAssistantAgentKey }),
        "success"
      );
    } catch (reason) {
      setQuickAssistantAgentKey(previousAgentKey);
      showSectionNotice("quickAssistant", reason instanceof Error ? reason.message : String(reason), "error");
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
      const result = await window.electronAPI.taskBoard.saveCloudConfig(nextConfig);
      if (!result.ok) {
        throw new Error(result.message || t("settings.control.saveFailed"));
      }
      setControlCloudConfig({
        ...defaultTaskBoardCloudConfig,
        ...result.config
      });
      setControlConnectionState(result.connectionState ?? "disabled");
      const [onlineResult, issueResult] = await Promise.all([
        window.electronAPI.taskBoard.listOnlineDevices(),
        window.electronAPI.taskBoard.listIssues()
      ]);
      setControlCloudProjects(issueResult.projects ?? []);
      setControlOnlineSummary(onlineResult);
      setReadErrorSections(["control"], "");
      showSectionNotice("control", result.message, "success");
    } catch (reason) {
      showSectionNotice("control", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setControlConfigSaving(false);
    }
  }

  async function handleSaveControlCloudConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveControlCloudConfig(controlCloudConfig);
  }

  async function handleToggleControlRemoteControl() {
    await saveControlCloudConfig({
      ...controlCloudConfig,
      remoteControlEnabled: !controlCloudConfig.remoteControlEnabled
    });
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
        showSectionNotice("runtimeReset", result.message || t("settings.reset.failed"), "error");
        setRuntimeResetResult(result);
        return;
      }
      setRuntimeResetResult(result);
      setReadErrorSections(["runtimeReset"], "");
    } catch (reason) {
      showSectionNotice("runtimeReset", reason instanceof Error ? reason.message : String(reason), "error");
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

  function renderActiveSection() {
    switch (activeSection) {
      case "appearance":
        return (
          <>
            <div className="settings-appearance-panel">
              <div className="settings-appearance-row">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.appearance.theme")}</strong>
                  <span>{t("settings.appearance.themeDescription")}</span>
                </div>
                <div className="settings-theme-segment" role="radiogroup" aria-label={t("settings.appearance.theme")}>
                  {THEME_PREFERENCE_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={themeMode === option ? "settings-theme-segment-option is-active" : "settings-theme-segment-option"}
                      role="radio"
                      aria-checked={themeMode === option}
                      onClick={() => {
                        if (themeMode !== option) {
                          onThemeModeChange(option);
                        }
                      }}
                    >
                      <span className="settings-theme-segment-icon" aria-hidden="true">
                        <ThemePreferenceIcon themeMode={option} />
                      </span>
                      <span>{getThemePreferenceLabel(option, t)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-appearance-row">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.language.label")}</strong>
                  <span>{t("settings.language.uiDescription")}</span>
                </div>
                <label className="settings-language-select-wrap">
                  <select
                    className="settings-language-select"
                    value={locale}
                    aria-label={t("settings.language.label")}
                    onChange={(event) => void handleLocaleChange(event.target.value as SupportedLocale)}
                  >
                    <option value="zh-CN">{t("settings.language.zhCN")}</option>
                    <option value="en-US">{t("settings.language.enUS")}</option>
                  </select>
                </label>
              </div>
            </div>
            {desktopPetSupported ? (
              <div className="settings-item-card settings-pet-card settings-appearance-pet-card">
                <div className="settings-item-header settings-pet-header">
                  <div className="settings-appearance-row-copy">
                    <strong>{t("settings.desktopPet.label")}</strong>
                    <span>{t("settings.desktopPet.description")}</span>
                  </div>
                  <button
                    type="button"
                    className={desktopPetState?.enabled ? "settings-switch is-on" : "settings-switch"}
                    role="switch"
                    aria-checked={Boolean(desktopPetState?.enabled)}
                    aria-label={t("settings.desktopPet.label")}
                    disabled={desktopPetPending}
                    onClick={() => void handleToggleDesktopPet()}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                <div className="settings-item-list settings-pet-appearance-panel desktop-pet-appearance-list" aria-label={t("settings.desktopPet.appearance")}>
                  {desktopPetAppearanceOptions.map((appearance) => {
                    const selected = appearance.id === currentDesktopPetAppearanceId;
                    const pending = desktopPetAppearancePending === appearance.id;
                    const appearanceLabel = getDesktopPetAppearanceLabel(appearance.id, appearance.displayName, t);
                    const appearanceDescription = getDesktopPetAppearanceDescription(appearance.id, appearance.description, t);
                    return (
                      <div className="settings-pet-appearance-row desktop-pet-appearance-row" key={appearance.id}>
                        <span className="desktop-pet-appearance-preview" aria-hidden="true">
                          <img src={appearance.previewAssetPath} alt="" />
                        </span>
                        <span className="desktop-pet-appearance-copy">
                          <strong>{appearanceLabel}</strong>
                          <small>{appearanceDescription}</small>
                        </span>
                        <button
                          type="button"
                          className={selected ? "desktop-pet-appearance-select is-selected" : "desktop-pet-appearance-select"}
                          aria-pressed={selected}
                          disabled={selected || Boolean(desktopPetAppearancePending)}
                          onClick={() => void handleSelectDesktopPetAppearance(appearance.id)}
                        >
                          {pending ? t("settings.desktopPet.switching") : selected ? t("settings.desktopPet.selected") : t("settings.desktopPet.select")}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="settings-item-form desktop-pet-agent-form">
                  <label className="desktop-pet-agent-field">
                    <span>{t("settings.desktopPet.selectAgent")}</span>
                    <span className="desktop-pet-agent-select-wrap">
                      <select
                        value={desktopPetAgentOptions.some((agent) => agent.agentKey === desktopPetBoundAgentKey) ? desktopPetBoundAgentKey : ""}
                        onChange={(event) => {
                          const nextBoundAgentKey = event.target.value;
                          setDesktopPetBoundAgentKey(nextBoundAgentKey);
                          void handleSelectDesktopPetBoundAgentKey(nextBoundAgentKey);
                        }}
                        disabled={!desktopPetEnabled || desktopPetAgentOptions.length === 0 || desktopPetBoundAgentPending}
                      >
                        <option value="">
                          {!desktopPetEnabled
                            ? t("settings.desktopPet.loadAgentsAfterEnabled")
                            : desktopPetAgentOptions.length === 0
                              ? t("settings.navigation.agentsLoading")
                              : t("settings.navigation.selectAgent")}
                        </option>
                        {desktopPetAgentOptions.map((agent) => (
                          <option value={agent.agentKey} key={agent.agentKey}>
                            {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                </div>
              </div>
            ) : null}
          </>
        );
      case "control":
        return (
          <div className="settings-item-card settings-control-card" aria-label={t("settings.control.panelAria")}>
            <div className="settings-item-header settings-control-permission-row">
              <span className="settings-control-app-icon" aria-hidden="true">
                <span />
              </span>
              <div className="settings-appearance-row-copy">
                <strong>{t("settings.control.remoteControlEnabled")}</strong>
                <span>{t("settings.control.remoteControlDescription")}</span>
                <em>
                  {controlCloudConfig.remoteControlEnabled
                    ? t("settings.control.remoteControlOn")
                    : t("settings.control.remoteControlOff")}
                </em>
              </div>
              <button
                type="button"
                className={controlCloudConfig.remoteControlEnabled ? "settings-switch is-on" : "settings-switch"}
                role="switch"
                aria-checked={controlCloudConfig.remoteControlEnabled}
                aria-label={t("settings.control.remoteControlEnabled")}
                disabled={controlConfigSaving}
                onClick={() => void handleToggleControlRemoteControl()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            <div className="settings-item-section-head custom-sidebar-list-head">
              <div>
                <strong>{t("settings.control.statusTitle")}</strong>
                <span>{getControlConnectionLabel(controlConnectionState)}</span>
              </div>
            </div>
            <div className="settings-control-summary">
              {t("settings.control.onlineSummary", {
                devices: controlOnlineSummary.deviceCount,
                sessions: controlOnlineSummary.sessionCount,
                agents: controlOnlineSummary.agentCount
              })}
            </div>
            <form className="settings-control-form" onSubmit={(event) => void handleSaveControlCloudConfig(event)}>
              <label className="settings-control-field">
                <span>{t("taskBoard.cloud.serverUrl")}</span>
                <input
                  value={controlCloudConfig.serverUrl}
                  onChange={(event) => setControlCloudConfig((current) => ({ ...current, serverUrl: event.target.value }))}
                  placeholder="http://127.0.0.1:8080"
                />
              </label>
              <label className="settings-control-field">
                <span>{t("taskBoard.cloud.token")}</span>
                <input
                  value={controlCloudConfig.token}
                  onChange={(event) => setControlCloudConfig((current) => ({ ...current, token: event.target.value }))}
                  placeholder={t("taskBoard.cloud.tokenPlaceholder")}
                />
              </label>
              <label className="settings-control-field">
                <span>{t("taskBoard.cloud.projectId")}</span>
                {controlProjectOptions.length > 0 ? (
                  <select
                    value={controlCloudConfig.selectedProjectId}
                    onChange={(event) => setControlCloudConfig((current) => ({ ...current, selectedProjectId: event.target.value }))}
                  >
                    {selectedControlProjectMissing ? (
                      <option value={controlCloudConfig.selectedProjectId}>
                        {t("taskBoard.cloud.currentProject", { id: controlCloudConfig.selectedProjectId })}
                      </option>
                    ) : null}
                    {controlProjectOptions.map((project) => (
                      <option value={project.id} key={project.id}>
                        {getTaskBoardProjectOptionLabel(project)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={controlCloudConfig.selectedProjectId}
                    onChange={(event) => setControlCloudConfig((current) => ({ ...current, selectedProjectId: event.target.value }))}
                    placeholder="default"
                  />
                )}
                <small>
                  {controlProjectOptions.length > 0
                    ? t("taskBoard.cloud.projectSelectHelp", { count: controlProjectOptions.length })
                    : t("taskBoard.cloud.projectFallbackHelp")}
                </small>
              </label>
              <div className="settings-control-actions">
                <button type="submit" className="settings-control-primary-button" disabled={controlConfigSaving}>
                  {controlConfigSaving ? t("settings.control.saving") : t("settings.control.save")}
                </button>
              </div>
            </form>
          </div>
        );
      case "navigation": {
        const defaultCopilotPages = createDefaultDesktopCopilotPagePreferences();
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
                  <select
                    value={assistantSelectValue}
                    onChange={(event) => {
                      if (copilotPageKey) {
                        void handleSelectNavigationCopilotAgent(copilotPageKey, event.target.value);
                      }
                    }}
                    disabled={!copilotPageKey || assistantAgentOptions.length === 0 || copilotPending}
                    aria-label={t("settings.navigation.sideAssistantFor", { label: toolLabel })}
                  >
                    <option value="">{t("settings.navigation.noSideAssistant")}</option>
                    {fixedAssistantLabel ? (
                      <option value="__fixed__">{fixedAssistantLabel}</option>
                    ) : null}
                    {showUnavailableAgentOption ? (
                      <option value={selectedCopilotAgentKey}>
                        {assistantAgentOptions.length === 0
                          ? t("settings.navigation.agentsLoading")
                          : t("settings.navigation.unavailableAgent", { agentKey: selectedCopilotAgentKey })}
                      </option>
                    ) : null}
                    {assistantAgentOptions.map((agent) => (
                      <option value={agent.agentKey} key={agent.agentKey}>
                        {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <div className="navigation-order-fixed-label">{t("settings.navigation.fixed")}</div>
            </div>
          );
        }
          return (
            <div className="settings-item-card navigation-settings-card" aria-label={t("settings.navigation.panelAria")}>
              <div className="settings-item-section-head custom-sidebar-list-head navigation-assistant-default-head">
                <div>
                  <strong>{t("settings.navigation.defaultAssistant")}</strong>
                  <span>{t("settings.navigation.defaultAssistantDescription")}</span>
                </div>
              </div>
              <div className="settings-item-form navigation-assistant-default">
                <span className="desktop-pet-agent-select-wrap navigation-assistant-default-select">
                  <select
                    value={assistantAgentOptions.some((agent) => agent.agentKey === desktopHelperAgentKey) ? desktopHelperAgentKey : ""}
                    onChange={(event) => void handleSelectDesktopHelperAgentKey(event.target.value)}
                    disabled={assistantAgentOptions.length === 0 || desktopHelperAgentPending}
                    aria-label={t("settings.navigation.defaultAssistant")}
                  >
                    <option value="">
                      {assistantAgentOptions.length === 0 ? t("settings.navigation.agentsLoading") : t("settings.navigation.selectAgent")}
                    </option>
                    {assistantAgentOptions.map((agent) => (
                      <option value={agent.agentKey} key={agent.agentKey}>
                        {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
              <div className="settings-item-section-head custom-sidebar-list-head">
                <div>
                  <strong>{t("settings.navigation.fixedMain")}</strong>
                  <span>{t("settings.navigation.fixedMainDescription")}</span>
                </div>
              </div>
              <div className="settings-item-list navigation-order-list" role="list" aria-label={t("settings.navigation.fixedMainOrder")}>
                {sidebarNavOrder.map((itemKey, index) => {
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
                            <select
                              value={assistantSelectValue}
                              onChange={(event) => {
                                if (copilotPageKey) {
                                  void handleSelectNavigationCopilotAgent(copilotPageKey, event.target.value);
                                }
                              }}
                              disabled={!copilotPageKey || assistantAgentOptions.length === 0 || copilotPending}
                              aria-label={t("settings.navigation.sideAssistantFor", { label: itemLabel })}
                            >
                              <option value="">{t("settings.navigation.noSideAssistant")}</option>
                              {fixedAssistantLabel ? (
                                <option value="__fixed__">{fixedAssistantLabel}</option>
                              ) : null}
                              {showUnavailableAgentOption ? (
                                <option value={selectedCopilotAgentKey}>
                                  {assistantAgentOptions.length === 0
                                    ? t("settings.navigation.agentsLoading")
                                    : t("settings.navigation.unavailableAgent", { agentKey: selectedCopilotAgentKey })}
                                </option>
                              ) : null}
                              {assistantAgentOptions.map((agent) => (
                                <option value={agent.agentKey} key={agent.agentKey}>
                                  {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                                </option>
                              ))}
                            </select>
                          </span>
                        </label>
                        <div className="navigation-order-actions">
                          <span className="navigation-order-fixed-label">{t("settings.navigation.itemIndex", { index: index + 1 })}</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
              <div className="settings-item-section-head custom-sidebar-list-head navigation-fixed-tools-head">
                <div>
                  <strong>{t("settings.navigation.fixedTools")}</strong>
                  <span>{t("settings.navigation.fixedToolsDescription")}</span>
                </div>
              </div>
              <div className="settings-item-list navigation-order-list navigation-fixed-tool-list" role="list" aria-label={t("settings.navigation.fixedTools")}>
                {fixedNavigationTools.map((tool) => renderFixedNavigationToolRow(tool))}
              </div>
            </div>
          );
      }
      case "quickAssistant":
        return (
          <div className="settings-item-card desktop-helper-settings-card" aria-label={t("settings.quickAssistant.panelAria")}>
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
              <button
                type="button"
                className={quickAssistantEnabled ? "settings-switch is-on" : "settings-switch"}
                role="switch"
                aria-checked={quickAssistantEnabled}
                aria-label={t("settings.quickAssistant.label")}
                disabled={quickAssistantPending}
                onClick={() => void handleToggleQuickAssistantEnabled()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            <div className="settings-item-form desktop-pet-agent-form">
              <label className="desktop-pet-agent-field">
                <span>{t("settings.quickAssistant.defaultAgent")}</span>
                <span className="desktop-pet-agent-select-wrap">
                  <select
                    value={isKnownAssistantAgent(quickAssistantAgentKey) ? quickAssistantAgentKey : ""}
                    onChange={(event) => void handleSelectQuickAssistantAgentKey(event.target.value)}
                    disabled={!quickAssistantEnabled || assistantAgentOptions.length === 0 || quickAssistantAgentPending}
                    aria-label={t("settings.quickAssistant.defaultAgent")}
                  >
                    <option value="">
                      {assistantAgentOptions.length === 0
                        ? t("settings.navigation.agentsLoading")
                        : isKnownAssistantAgent(quickAssistantAgentKey)
                          ? t("settings.navigation.selectAgent")
                          : t("settings.navigation.unavailableAgent", { agentKey: quickAssistantAgentKey })}
                    </option>
                    {assistantAgentOptions.map((agent) => (
                      <option value={agent.agentKey} key={agent.agentKey}>
                        {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </div>
          </div>
        );
      case "embeddedWebsites":
        return (
          <div className="settings-item-card custom-sidebar-card">
            {!editingCustomSidebarId ? (
              <>
                <div className="settings-item-section-head custom-sidebar-list-head custom-sidebar-add-head">
                  <div>
                    <strong>{t("settings.embeddedWebsites.addTitle")}</strong>
                    <span>{t("settings.embeddedWebsites.addDescription")}</span>
                  </div>
                </div>
                <div className="settings-item-form custom-sidebar-add-form">
                  <form className="custom-sidebar-form" onSubmit={(event) => void handleAddCustomSidebarItem(event)}>
                    <label>
                      <span>{t("settings.embeddedWebsites.displayName")}</span>
                      <input
                        value={customSidebarLabel}
                        onChange={(event) => setCustomSidebarLabel(event.target.value)}
                        placeholder={t("settings.embeddedWebsites.displayNamePlaceholder")}
                        maxLength={24}
                      />
                    </label>
                    <label>
                      <span>{t("settings.embeddedWebsites.url")}</span>
                      <input
                        value={customSidebarUrl}
                        onChange={(event) => setCustomSidebarUrl(event.target.value)}
                        placeholder={t("settings.embeddedWebsites.urlPlaceholder")}
                        required
                      />
                    </label>
                    <div className="custom-sidebar-submit-wrap">
                      <button type="submit" className="text-button custom-sidebar-submit" disabled={customSidebarPending}>
                        {customSidebarPending ? t("settings.embeddedWebsites.adding") : t("settings.embeddedWebsites.add")}
                      </button>
                    </div>
                  </form>
                </div>
              </>
            ) : null}

            <div className="settings-item-section-head custom-sidebar-list-head custom-sidebar-added-head">
              <div>
                <strong>{t("settings.embeddedWebsites.addedTitle")}</strong>
                <span>{t("settings.embeddedWebsites.addedDescription")}</span>
              </div>
              <div className="settings-item-section-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void handleImportCustomSidebarItems()}
                  disabled={customSidebarTransferPending !== "" || Boolean(editingCustomSidebarId)}
                >
                  {customSidebarTransferPending === "import" ? t("settings.embeddedWebsites.importing") : t("settings.embeddedWebsites.import")}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void handleExportCustomSidebarItems()}
                  disabled={customSidebarTransferPending !== "" || Boolean(editingCustomSidebarId)}
                >
                  {customSidebarTransferPending === "export" ? t("settings.embeddedWebsites.exporting") : t("settings.embeddedWebsites.export")}
                </button>
              </div>
            </div>
            {customSidebarItems.length === 0 ? (
              <div className="settings-item-empty custom-sidebar-empty">{t("settings.embeddedWebsites.empty")}</div>
            ) : (
              <div className="settings-item-list custom-sidebar-list" role="list" aria-label={t("settings.embeddedWebsites.addedTitle")}>
                {customSidebarItems.map((item) => {
                  const itemAgentKey = item.agentKey || "";
                  const itemAgentKnown = !itemAgentKey || assistantAgentOptions.some((agent) => agent.agentKey === itemAgentKey);
                  const itemAgentPending = customSidebarAgentPendingId === item.id;
                  const itemEditing = editingCustomSidebarId === item.id;
                  return (
                    <div
                      className={itemEditing ? "settings-item-row custom-sidebar-row is-editing" : "settings-item-row custom-sidebar-row"}
                      key={item.id}
                      role="listitem"
                    >
                      {itemEditing ? (
                        <form
                          className="custom-sidebar-row-edit-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleUpdateCustomSidebarItem(item.id);
                          }}
                        >
                          <label>
                            <span>{t("settings.embeddedWebsites.displayName")}</span>
                            <input
                              value={customSidebarLabel}
                              onChange={(event) => setCustomSidebarLabel(event.target.value)}
                              placeholder={t("settings.embeddedWebsites.displayNamePlaceholder")}
                              maxLength={24}
                              required
                            />
                          </label>
                          <label>
                            <span>{t("settings.embeddedWebsites.url")}</span>
                            <input
                              value={customSidebarUrl}
                              onChange={(event) => setCustomSidebarUrl(event.target.value)}
                              placeholder={t("settings.embeddedWebsites.urlPlaceholder")}
                              required
                            />
                          </label>
                          <div className="custom-sidebar-row-actions">
                            <button type="submit" className="text-button" disabled={customSidebarPending}>
                              {customSidebarPending ? t("settings.embeddedWebsites.updating") : t("settings.embeddedWebsites.save")}
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              onClick={handleCancelEditCustomSidebarItem}
                              disabled={customSidebarPending}
                            >
                              {t("settings.embeddedWebsites.cancel")}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="custom-sidebar-site-cell">
                            <strong>{item.label}</strong>
                            <span className="custom-sidebar-site-url" title={item.url}>
                              {item.url}
                            </span>
                          </div>
                          <label className="custom-sidebar-agent-field">
                            <span className="desktop-pet-agent-select-wrap">
                              <select
                                value={itemAgentKey}
                                onChange={(event) => void handleUpdateCustomSidebarAgent(item.id, event.target.value)}
                                disabled={assistantAgentOptions.length === 0 || itemAgentPending || Boolean(editingCustomSidebarId)}
                                aria-label={t("settings.embeddedWebsites.linkedAgentFor", { label: item.label })}
                              >
                                <option value="">{t("settings.defaultAssistant")}</option>
                                {itemAgentKey && !itemAgentKnown ? (
                                  <option value={itemAgentKey}>{t("settings.navigation.unavailableAgent", { agentKey: itemAgentKey })}</option>
                                ) : null}
                                {assistantAgentOptions.map((agent) => (
                                  <option value={agent.agentKey} key={agent.agentKey}>
                                    {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                                  </option>
                                ))}
                              </select>
                            </span>
                          </label>
                          <div className="custom-sidebar-row-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => handleStartEditCustomSidebarItem(item)}
                              disabled={customSidebarPending || deletingCustomSidebarId === item.id || Boolean(editingCustomSidebarId)}
                            >
                              {t("settings.embeddedWebsites.edit")}
                            </button>
                            <button
                              type="button"
                              className="danger-text-button"
                              onClick={() => void handleDeleteCustomSidebarItem(item)}
                              disabled={deletingCustomSidebarId === item.id || Boolean(editingCustomSidebarId)}
                            >
                              {deletingCustomSidebarId === item.id ? t("settings.embeddedWebsites.deleting") : t("settings.embeddedWebsites.delete")}
                            </button>
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
      case "debug":
        return null;
      case "memory":
        return (
          <div className="data-root-card assistant-memory-card">
            <div className="custom-sidebar-copy assistant-memory-copy">
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
                    <button
                      type="button"
                      className={memorySettings?.enabled ? "settings-switch is-on" : "settings-switch"}
                      role="switch"
                      aria-checked={Boolean(memorySettings?.enabled)}
                      aria-label={t("settings.memory.recall")}
                      disabled={!memorySettings || memoryPending === "settings"}
                      onClick={() => void handleToggleMemoryEnabled()}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>
                  <div className="settings-item-row assistant-memory-switch-row">
                    <span className="assistant-memory-switch-copy">
                      <span>{t("settings.memory.autoLearn")}</span>
                      <small>{memoryAutoLearnLabel}</small>
                    </span>
                    <button
                      type="button"
                      className={memorySettings?.autoLearn ? "settings-switch is-on" : "settings-switch"}
                      role="switch"
                      aria-checked={Boolean(memorySettings?.autoLearn)}
                      aria-label={t("settings.memory.autoLearn")}
                      disabled={!memorySettings || memoryPending === "settings"}
                      onClick={() => void handleToggleMemoryAutoLearn()}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="settings-item-section-head custom-sidebar-list-head assistant-memory-section-head">
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
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void handleOpenMemoryDirectory()}
                      disabled={memoryPending === "open"}
                    >
                      {memoryPending === "open" ? t("settings.memory.openingDirectory") : t("settings.memory.openDirectory")}
                    </button>
                    <button
                      type="button"
                      className="danger-text-button"
                      onClick={() => void handleClearMemoryItems()}
                      disabled={memoryTotal === 0 || memoryPending === "clear"}
                    >
                      {memoryPending === "clear" ? t("settings.memory.clearing") : t("common.clear")}
                    </button>
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
      case "runtimeReset":
        return (
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
              <button
                type="button"
                className="danger-text-button settings-reset-button"
                disabled={runtimeResetPending}
                onClick={() => void handleResetRuntimeEnv()}
              >
                {runtimeResetPending ? t("settings.reset.running") : t("settings.reset.action")}
              </button>
            </div>
          </div>
        );
      case "about":
        return <AboutAppCard />;
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
            <h1>{activeSectionDefinition?.label ?? t("settings.title")}</h1>
            <p className="page-copy">{activeSectionDefinition?.description ?? t("settings.description")}</p>
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
