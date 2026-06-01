import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { PageFeedbackStack } from "../../components/PageFeedbackStack";
import "../SplitWorkspaceLayout.css";
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
  CustomSidebarItemsResult,
  DesktopAppInfo,
  DesktopPetAgentOption,
  DesktopPetState
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
  createSettingsSectionDefinitions,
  getDefaultSettingsSectionId,
  getVisibleSettingsSections,
  type SettingsSectionId
} from "../../settingsPageSections";
import type { SidebarNavOrderItem, SidebarNavOrderItemKey } from "../../app-shell/navigation/sidebarNavOrder";
import { useI18n } from "../../i18n/useI18n";
import type { SupportedLocale, TranslateFunction, TranslationKey } from "../../../shared/i18n";

type SettingsPageProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  isMac: boolean;
  isWindows: boolean;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  availableSidebarNavOrderItems: SidebarNavOrderItem[];
  onSidebarNavOrderChange: (order: SidebarNavOrderItemKey[]) => void;
  customSidebarItems: CustomSidebarItem[];
  onCustomSidebarItemsChange: (items: CustomSidebarItem[]) => void;
  onRefreshCustomSidebarItems: () => Promise<CustomSidebarItemsResult>;
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

const SETTINGS_ACTION_PATCH_FIELDS = [
  "desktopHelperAgentKey",
  "quickAssistantEnabled",
  "quickAssistantAgentKey",
  "desktopCopilotPages"
] as const;
const SETTINGS_NOTICE_AUTO_CLOSE_MS = 3200;
const ASSISTANT_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "quickAssistant",
  "embeddedWebsites"
];

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
    case "mini-sama":
      return t("settings.desktopPet.appearance.miniSama.label");
    case "xiao":
      return t("settings.desktopPet.appearance.xiao.label");
    case "idol-pony":
      return t("settings.desktopPet.appearance.idolPony.label");
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
    case "mini-sama":
      return t("settings.desktopPet.appearance.miniSama.description");
    case "xiao":
      return t("settings.desktopPet.appearance.xiao.description");
    case "idol-pony":
      return t("settings.desktopPet.appearance.idolPony.description");
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
        <p className="eyebrow">DATA ROOT</p>
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
    <div className="data-root-card settings-about-card">
      <div>
        <p className="eyebrow">ABOUT</p>
        <h2>{t("settings.about.label")}</h2>
        <p className="page-copy">
          {t("settings.about.description")}
        </p>
      </div>
      <div className="settings-about-meta">
        <span>{t("settings.about.version")}</span>
        <strong>{version}</strong>
      </div>
    </div>
  );
}

export function SettingsPage({
  themeMode,
  onToggleTheme,
  isMac,
  isWindows,
  sidebarNavOrder,
  availableSidebarNavOrderItems,
  onSidebarNavOrderChange,
  customSidebarItems,
  onCustomSidebarItemsChange,
  onRefreshCustomSidebarItems,
  onAssistantSettingsChange
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const noticeIdRef = useRef(0);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [sectionReadErrors, setSectionReadErrors] = useState<SectionReadErrorMap>({});
  const [customSidebarLabel, setCustomSidebarLabel] = useState("");
  const [customSidebarUrl, setCustomSidebarUrl] = useState("");
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
  const desktopPetSupported = isMac || isWindows;
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionDefinitions = useMemo(
    () =>
      createSettingsSectionDefinitions({
        isWindows,
        desktopPetSupported
      }).map((definition) => {
        const localized: Record<SettingsSectionId, { label: string; description: string }> = {
          appearance: { label: t("settings.appearance.label"), description: t("settings.appearance.description") },
          navigation: { label: t("settings.navigation.label"), description: t("settings.navigation.description") },
          quickAssistant: { label: t("settings.quickAssistant.label"), description: t("settings.quickAssistant.description") },
          desktopPet: { label: t("settings.desktopPet.label"), description: t("settings.desktopPet.description") },
          embeddedWebsites: { label: t("settings.embeddedWebsites.label"), description: t("settings.embeddedWebsites.description") },
          dataRoot: { label: t("settings.dataRoot.label"), description: t("settings.dataRoot.description") },
          debug: { label: t("settings.debug.label"), description: t("settings.debug.description") },
          memory: { label: t("settings.memory.label"), description: t("settings.memory.description") },
          about: { label: t("settings.about.label"), description: t("settings.about.description") }
        };
        return { ...definition, ...localized[definition.id] };
      }),
    [desktopPetSupported, isWindows, t]
  );
  const visibleSections = useMemo(
    () => getVisibleSettingsSections(sectionDefinitions),
    [sectionDefinitions]
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(() =>
    getDefaultSettingsSectionId(
      createSettingsSectionDefinitions({
        isWindows,
        desktopPetSupported
      })
    )
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
      showSectionNotice("appearance", `${t("settings.language.current")}：${nextLocale}`, "success");
    } catch (reason) {
      showSectionNotice("appearance", reason instanceof Error ? reason.message : String(reason), "error");
    }
  }

  useEffect(() => {
    const fallbackSectionId = getDefaultSettingsSectionId(sectionDefinitions);
    if (!fallbackSectionId) {
      return;
    }
    setActiveSection((currentSectionId) =>
      visibleSections.some((definition) => definition.id === currentSectionId)
        ? currentSectionId
        : fallbackSectionId
    );
  }, [sectionDefinitions, visibleSections]);

  useEffect(() => {
    setNotice((current) => (current?.tone === "success" ? null : current));
  }, [activeSection]);

  useEffect(() => {
    if (!notice || notice.tone !== "success") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
    }, SETTINGS_NOTICE_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.assistant.getMemorySummary(),
      window.electronAPI.assistant.listMemoryItems()
    ])
      .then(([summary, memoryList]) => {
        if (cancelled) {
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
        if (!cancelled) {
          setReadErrorSections(["memory"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.electronAPI.assistant.getSettings(),
      window.electronAPI.assistant.listCopilotAgents()
    ])
      .then(([settings, agentsResult]) => {
        if (cancelled) {
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
  }, []);

  useEffect(() => {
    if (!desktopPetSupported) {
      return;
    }

    let cancelled = false;
    window.electronAPI.desktopPet.getState()
      .then((state) => {
        if (!cancelled) {
          setDesktopPetState(state);
          setReadErrorSections(["desktopPet"], "");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["desktopPet"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    const dispose = window.electronAPI.desktopPet.onStateChanged((state) => {
      if (!cancelled) {
        setDesktopPetState(state);
        setReadErrorSections(["desktopPet"], "");
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [desktopPetSupported]);

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
  const defaultDesktopPetAppearance = DESKTOP_PET_APPEARANCE_OPTIONS.find((appearance) => appearance.id === DEFAULT_DESKTOP_PET_APPEARANCE_ID) ??
    DESKTOP_PET_APPEARANCE_OPTIONS[0];
  const currentDesktopPetAppearance = desktopPetAppearanceOptions.find(
    (appearance) => appearance.id === currentDesktopPetAppearanceId
  );
  const currentDesktopPetAppearanceLabel = getDesktopPetAppearanceLabel(
    currentDesktopPetAppearance?.id ?? defaultDesktopPetAppearance.id,
    currentDesktopPetAppearance?.displayName ?? defaultDesktopPetAppearance.displayName,
    t
  );
  const currentDesktopPetAgentOption = desktopPetAgentOptions.find(
    (agent) => agent.agentKey === currentDesktopPetBoundAgentKey
  );

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

  async function handleDeleteCustomSidebarItem(item: CustomSidebarItem) {
    setDeletingCustomSidebarId(item.id);
    try {
      const result = await window.electronAPI.customSidebar.remove(item.id);
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
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

  async function handleReloadCustomSidebarItems() {
    try {
      const result = await onRefreshCustomSidebarItems();
      showSectionResultNotice("embeddedWebsites", result);
    } catch (reason) {
      showSectionNotice("embeddedWebsites", reason instanceof Error ? reason.message : String(reason), "error");
    }
  }

  async function handleImportCustomSidebarItems() {
    setCustomSidebarTransferPending("import");
    try {
      const result = await window.electronAPI.customSidebar.import();
      showSectionResultNotice("embeddedWebsites", result);
      onCustomSidebarItemsChange(result.items);
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
      setReadErrorSections(["desktopPet"], "");
      showSectionNotice("desktopPet", nextState.enabled ? t("settings.desktopPet.noticeEnabled") : t("settings.desktopPet.noticeDisabled"), "success");
    } catch (reason) {
      showSectionNotice("desktopPet", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDesktopPetPending(false);
    }
  }

  async function handleSelectDesktopPetAppearance(appearanceId: string) {
    if (!desktopPetSupported || !desktopPetState || appearanceId === currentDesktopPetAppearanceId) {
      return;
    }
    const selectedAppearance = desktopPetAppearanceOptions.find((appearance) => appearance.id === appearanceId);
    setDesktopPetAppearancePending(appearanceId);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        appearanceId
      });
      setDesktopPetState(nextState);
      setReadErrorSections(["desktopPet"], "");
      if (nextState.appearanceId === appearanceId) {
        showSectionNotice(
          "desktopPet",
          t("settings.desktopPet.noticeAppearanceChanged", {
            name: getDesktopPetAppearanceLabel(appearanceId, selectedAppearance?.displayName ?? appearanceId, t)
          }),
          "success"
        );
      } else {
        showSectionNotice("desktopPet", t("settings.desktopPet.noticeAppearanceFailed"), "error");
      }
    } catch (reason) {
      showSectionNotice("desktopPet", reason instanceof Error ? reason.message : String(reason), "error");
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
      setReadErrorSections(["desktopPet"], "");
      showSectionNotice("desktopPet", t("settings.desktopPet.noticeBoundAgentChanged", { name: nextAgent?.displayName ?? nextState.boundAgentKey }), "success");
    } catch (reason) {
      setDesktopPetBoundAgentKey(previousBoundAgentKey);
      showSectionNotice("desktopPet", reason instanceof Error ? reason.message : String(reason), "error");
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

  const sidebarNavOrderLabels = new Map(availableSidebarNavOrderItems.map((item) => [item.key, item.label]));
  const activeSectionDefinition = activeSection
    ? visibleSections.find((definition) => definition.id === activeSection) ?? null
    : null;
  const activeSectionWidthClass = activeSectionDefinition?.layout === "wide" ? "workspace-wide" : "workspace-measure";
  const activeSectionReadError = activeSection ? sectionReadErrors[activeSection] ?? "" : "";
  const activeSectionNotice = notice && notice.sectionId === activeSection ? notice : null;

  function renderActiveSection() {
    switch (activeSection) {
      case "appearance":
        return (
          <>
            <div className="data-root-card settings-theme-card">
              <div>
                <p className="eyebrow">APPEARANCE</p>
                <h2>{t("settings.appearance.theme")}</h2>
                <p className="page-copy">
                  {t("settings.appearance.description")} <strong>{themeMode === "light" ? t("settings.appearance.light") : t("settings.appearance.dark")}</strong>
                </p>
              </div>
              <div className="settings-theme-actions">
                <button
                  type="button"
                  className={themeMode === "light" ? "settings-theme-option is-active" : "settings-theme-option"}
                  onClick={() => {
                    if (themeMode !== "light") {
                      onToggleTheme();
                    }
                  }}
                >
                  <span className="settings-theme-preview settings-theme-preview-light" aria-hidden="true">
                    <span />
                    <span />
                  </span>
                  <span className="settings-theme-copy">
                    <strong>{t("settings.appearance.light")}</strong>
                    <span>{t("settings.appearance.lightDescription")}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={themeMode === "dark" ? "settings-theme-option is-active" : "settings-theme-option"}
                  onClick={() => {
                    if (themeMode !== "dark") {
                      onToggleTheme();
                    }
                  }}
                >
                  <span className="settings-theme-preview settings-theme-preview-dark" aria-hidden="true">
                    <span />
                    <span />
                  </span>
                  <span className="settings-theme-copy">
                    <strong>{t("settings.appearance.dark")}</strong>
                    <span>{t("settings.appearance.darkDescription")}</span>
                  </span>
                </button>
              </div>
            </div>
            <div className="data-root-card settings-theme-card">
              <div>
                <p className="eyebrow">LANGUAGE</p>
                <h2>{t("settings.language.label")}</h2>
                <p className="page-copy">{t("settings.language.description")}</p>
              </div>
              <div className="settings-theme-actions">
                <button
                  type="button"
                  className={locale === "zh-CN" ? "settings-theme-option is-active" : "settings-theme-option"}
                  onClick={() => void handleLocaleChange("zh-CN")}
                >
                  <span className="settings-theme-copy">
                    <strong>{t("settings.language.zhCN")}</strong>
                    <span>zh-CN</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={locale === "en-US" ? "settings-theme-option is-active" : "settings-theme-option"}
                  onClick={() => void handleLocaleChange("en-US")}
                >
                  <span className="settings-theme-copy">
                    <strong>{t("settings.language.enUS")}</strong>
                    <span>en-US</span>
                  </span>
                </button>
              </div>
            </div>
          </>
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
            <div className="navigation-order-row navigation-order-row-fixed" role="listitem" key={tool.id}>
              <div className="navigation-order-title-cell navigation-order-title-cell-fixed" title={t("settings.navigation.fixedEntry")}>
                <span className="navigation-order-fixed-dot" aria-hidden="true" />
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
          <div className="data-root-card navigation-settings-card" aria-label={t("settings.navigation.panelAria")}>
            <div className="navigation-settings-panel">
              <div className="navigation-assistant-default" aria-label={t("settings.navigation.defaultAssistant")}>
                <div className="page-copilot-row-main">
                  <strong>{t("settings.navigation.defaultAssistant")}</strong>
                  <span>{t("settings.navigation.defaultAssistantDescription")}</span>
                </div>
                <label className="desktop-pet-agent-field navigation-assistant-default-field">
                  <span className="desktop-pet-agent-select-wrap">
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
                  <span className="desktop-pet-agent-note">
                    {desktopHelperAgentPending
                      ? t("settings.navigation.saving")
                      : t("settings.navigation.currentDefault", {
                          name: assistantAgentOptions.find((agent) => agent.agentKey === (assistantSettings?.desktopHelperAgentKey || desktopHelperAgentKey))?.displayName ||
                            assistantSettings?.desktopHelperAgentKey ||
                            desktopHelperAgentKey
                        })}
                  </span>
                </label>
              </div>
              <div className="navigation-order-section">
                <div className="custom-sidebar-list-head">
                  <strong>{t("settings.navigation.fixedMain")}</strong>
                  <span>{t("settings.navigation.fixedMainDescription")}</span>
                </div>
                <div className="navigation-order-grid-head" aria-hidden="true">
                  <span>{t("settings.navigation.pageColumn")}</span>
                  <span>{t("settings.navigation.sideAssistantColumn")}</span>
                  <span>{t("settings.navigation.statusColumn")}</span>
                </div>
                <div className="navigation-order-list" role="list" aria-label={t("settings.navigation.fixedMainOrder")}>
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
                        className="navigation-order-row"
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
                <div className="custom-sidebar-list-head navigation-fixed-tools-head">
                  <strong>{t("settings.navigation.fixedTools")}</strong>
                  <span>{t("settings.navigation.fixedToolsDescription")}</span>
                </div>
                <div className="navigation-order-list navigation-fixed-tool-list" role="list" aria-label={t("settings.navigation.fixedTools")}>
                  {fixedNavigationTools.map((tool) => renderFixedNavigationToolRow(tool))}
                </div>
              </div>
            </div>
          </div>
        );
      }
      case "quickAssistant":
        return (
          <div className="data-root-card settings-switch-card desktop-helper-settings-card">
            <div>
              <div className="quick-assistant-settings-panel" aria-label={t("settings.quickAssistant.panelAria")}>
                <div className="page-copilot-row-main">
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
          </div>
        );
      case "desktopPet":
        return desktopPetSupported ? (
          <div className="data-root-card settings-switch-card desktop-pet-settings-card">
            <div>
              <p className="settings-inline-note">
                {t("settings.desktopPet.currentStatus", {
                  status: desktopPetState?.enabled ? t("settings.desktopPet.enabled") : t("settings.desktopPet.disabled"),
                  visible: desktopPetState?.enabled && desktopPetState.visible ? t("settings.desktopPet.visibleSuffix") : ""
                })}
              </p>
              <div className="desktop-pet-appearance-section" aria-label={t("settings.desktopPet.appearance")}>
                <div className="desktop-pet-appearance-heading">
                  <span>{t("settings.desktopPet.appearance")}</span>
                  <small>{t("settings.desktopPet.currentAppearance", { name: currentDesktopPetAppearanceLabel })}</small>
                </div>
                <div className="desktop-pet-appearance-grid">
                  {desktopPetAppearanceOptions.map((appearance) => {
                    const selected = appearance.id === currentDesktopPetAppearanceId;
                    const pending = desktopPetAppearancePending === appearance.id;
                    const appearanceLabel = getDesktopPetAppearanceLabel(appearance.id, appearance.displayName, t);
                    const appearanceDescription = getDesktopPetAppearanceDescription(appearance.id, appearance.description, t);
                    return (
                      <button
                        type="button"
                        className={selected ? "desktop-pet-appearance-card is-selected" : "desktop-pet-appearance-card"}
                        key={appearance.id}
                        aria-pressed={selected}
                        disabled={Boolean(desktopPetAppearancePending) && !selected}
                        onClick={() => void handleSelectDesktopPetAppearance(appearance.id)}
                      >
                        <span className="desktop-pet-appearance-preview" aria-hidden="true">
                          <img src={appearance.previewAssetPath} alt="" />
                        </span>
                        <span className="desktop-pet-appearance-copy">
                          <strong>{appearanceLabel}</strong>
                          <small>{pending ? t("settings.desktopPet.switching") : appearanceDescription}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="desktop-pet-agent-form">
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
                  <span className="desktop-pet-agent-note">
                    {desktopPetBoundAgentPending
                      ? t("settings.desktopPet.binding")
                      : t("settings.desktopPet.currentBinding", {
                          name: currentDesktopPetAgentOption?.displayName
                            ? `${currentDesktopPetAgentOption.displayName}${currentDesktopPetAgentOption.role ? ` · ${currentDesktopPetAgentOption.role}` : ""}`
                            : currentDesktopPetBoundAgentKey
                        })}
                  </span>
                </label>
              </div>
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
        ) : null;
      case "embeddedWebsites":
        return (
          <div className="data-root-card custom-sidebar-card">
            <div className="custom-sidebar-panel">
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

              <div className="custom-sidebar-list-head">
                <strong>{t("settings.embeddedWebsites.addedTitle")}</strong>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void handleImportCustomSidebarItems()}
                    disabled={customSidebarTransferPending !== ""}
                  >
                    {customSidebarTransferPending === "import" ? t("settings.embeddedWebsites.importing") : t("settings.embeddedWebsites.import")}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void handleExportCustomSidebarItems()}
                    disabled={customSidebarTransferPending !== ""}
                  >
                    {customSidebarTransferPending === "export" ? t("settings.embeddedWebsites.exporting") : t("settings.embeddedWebsites.export")}
                  </button>
                  <button type="button" className="text-button" onClick={() => void handleReloadCustomSidebarItems()}>
                    {t("settings.embeddedWebsites.refresh")}
                  </button>
                </div>
              </div>
              {customSidebarItems.length === 0 ? (
                <div className="custom-sidebar-empty">{t("settings.embeddedWebsites.empty")}</div>
              ) : (
                <div className="custom-sidebar-list">
                  {customSidebarItems.map((item) => {
                    const itemAgentKey = item.agentKey || "";
                    const itemAgentKnown = !itemAgentKey || assistantAgentOptions.some((agent) => agent.agentKey === itemAgentKey);
                    const itemAgentPending = customSidebarAgentPendingId === item.id;
                    return (
                      <div className="custom-sidebar-row" key={item.id}>
                        <div className="custom-sidebar-row-main">
                          <div className="custom-sidebar-row-copy">
                            <strong>{item.label}</strong>
                            <span>{item.url}</span>
                            <div className="custom-sidebar-row-agent">
                              <span className="custom-sidebar-row-agent-label">{t("settings.embeddedWebsites.agentEnhancement")}</span>
                              <select
                                className="custom-sidebar-agent-select"
                                value={itemAgentKey}
                                onChange={(event) => void handleUpdateCustomSidebarAgent(item.id, event.target.value)}
                                disabled={assistantAgentOptions.length === 0 || itemAgentPending}
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
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="danger-text-button"
                          onClick={() => void handleDeleteCustomSidebarItem(item)}
                          disabled={deletingCustomSidebarId === item.id}
                        >
                          {deletingCustomSidebarId === item.id ? t("settings.embeddedWebsites.deleting") : t("settings.embeddedWebsites.delete")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      case "dataRoot":
        return isWindows ? <WindowsDataRootCard /> : null;
      case "debug":
        return (
          <div className="data-root-card">
            <div className="debug-settings-copy">
              <p className="eyebrow">DEBUG</p>
              <h2>{t("settings.debug.label")}</h2>
              <p className="page-copy">{t("settings.debug.sectionDescription")}</p>
              <p className="settings-inline-note">{t("settings.debug.shortcut")}</p>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => void window.electronAPI.debug.openViewer()}
            >
              {t("settings.debug.openViewer")}
            </button>
          </div>
        );
      case "memory":
        return (
          <div className="data-root-card assistant-memory-card">
            <div className="custom-sidebar-copy assistant-memory-copy">
              <p className="eyebrow">MEMORY</p>
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
              <div className="assistant-memory-switches">
                <div className="assistant-memory-switch-row">
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
                <div className="assistant-memory-switch-row">
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
              <div className="custom-sidebar-list-head assistant-memory-section-head">
                <strong>{t("settings.memory.recent")}</strong>
                <span>
                  {memoryItems.length > 0
                    ? t("settings.memory.recentCount", { shown: recentMemoryItems.length, total: memoryItems.length })
                    : t("common.none")}
                </span>
              </div>
              {recentMemoryItems.length > 0 ? (
                <div className="assistant-memory-list">
                  {recentMemoryItems.map((item) => (
                    <div className="assistant-memory-row" key={item.id}>
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
                <p className="settings-inline-note">{t("settings.memory.recentEmpty")}</p>
              )}
              <div className="assistant-memory-storage-card">
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
        );
      case "about":
        return <AboutAppCard />;
      default:
        return null;
    }
  }

  return (
    <section
      className="settings-page split-workspace-page"
      data-settings-section={activeSectionDefinition?.id ?? ""}
    >
      <div className="settings-layout split-workspace-layout">
        <aside className="settings-sidebar-card split-workspace-sidebar-card">
          <div>
            <h2 className="settings-sidebar-title">{t("settings.title")}</h2>
          </div>
          <nav className="settings-directory-nav" aria-label={t("settings.directory")}>
            {visibleSections.map((section) => {
              const isActive = section.id === activeSectionDefinition?.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={isActive ? "settings-directory-btn is-active" : "settings-directory-btn"}
                  onClick={() => {
                    if (section.id === activeSectionDefinition?.id) {
                      return;
                    }
                    setActiveSection(section.id);
                    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  <span className="settings-directory-btn-label">{section.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="settings-main-card split-workspace-main-card" ref={contentRef}>
          <div className={`settings-content-shell ${activeSectionWidthClass}`}>
            <div className="settings-page-head">
              <p className="eyebrow">SETTINGS</p>
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
                      onDismiss:
                        activeSectionNotice.tone === "error"
                          ? () => dismissSectionNotice(activeSectionNotice.id)
                          : undefined
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
      </div>
    </section>
  );
}
