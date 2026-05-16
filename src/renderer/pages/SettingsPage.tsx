import { useEffect, useState, type FormEvent } from "react";
import { CustomSidebarIcon } from "../components/BrandMark";
import type {
  AssistantMemoryItem,
  AssistantMemorySettings,
  AssistantMemorySummary,
  AssistantMemoryStorage,
  AssistantMemoryStats,
  AssistantSettingsPublic,
  CustomSidebarItem,
  CustomSidebarItemsResult,
  DesktopPetAgentOption,
  DesktopPetState
} from "../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  DESKTOP_COPILOT_PAGE_KEYS,
  DESKTOP_COPILOT_PAGE_LABELS,
  createDefaultDesktopCopilotPagePreferences,
  type DesktopCopilotPageKey,
  type DesktopCopilotPagePreferences
} from "../../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../../shared/page-copilot";
import { registerDesktopActionProvider } from "../services/desktopActionRegistry";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS
} from "../../shared/desktop-pet";
import type { SettingsSectionDefinition, SettingsSectionId } from "../settingsSections";
import type { SidebarNavOrderItem, SidebarNavOrderItemKey } from "../sidebarNavOrder";

type SettingsPageProps = {
  activeSection: SettingsSectionId;
  sectionDefinitions: SettingsSectionDefinition[];
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  onExitSettingsMode: () => void;
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

type WindowsDataRootCardProps = {
  onError: (message: string) => void;
};

const WIDE_SETTINGS_SECTIONS = new Set<SettingsSectionId>(["navigation", "embeddedWebsites", "memory"]);

function formatMemoryTime(value: string | null | undefined) {
  if (!value) {
    return "暂无";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatMemoryStatus(value: AssistantMemoryItem["status"]) {
  switch (value) {
    case "active":
      return "生效中";
    case "open":
      return "观察中";
    case "archived":
      return "已归档";
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

function formatMemoryAuditSummary(summary: AssistantMemorySummary["recentAudit"]) {
  if (!summary) {
    return "暂无操作";
  }
  return [summary.operation, summary.status, summary.reason].filter(Boolean).join(" / ");
}

function WindowsDataRootCard({ onError }: WindowsDataRootCardProps) {
  const [dataRoot, setDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.settings
      .getDataRoot()
      .then((root) => {
        if (!cancelled) {
          setDataRoot(root);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          onError(reason instanceof Error ? reason.message : String(reason));
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
  }, [onError]);

  return (
    <div className="data-root-card">
      <div>
        <p className="eyebrow">DATA ROOT</p>
        <h2>数据目录</h2>
        <p className="page-copy">
          使用 <code>~/.zenmind/.desktop</code> 分层保存配置、数据、状态、日志、缓存、密钥和浏览器 profile；程序产物保存在 Application Support 的 ZenMind 目录。
        </p>
      </div>
      <div className="data-root-actions">
        <div className="data-root-path">{dataRootLoading ? "正在读取..." : dataRoot || "未配置"}</div>
      </div>
    </div>
  );
}

export function SettingsPage({
  activeSection,
  sectionDefinitions,
  themeMode,
  onToggleTheme,
  onExitSettingsMode,
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
  const [feedback, setFeedback] = useState("");
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
      })
      .catch((reason) => {
        if (!cancelled) {
          setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      window.electronAPI.assistant.listAgents()
    ])
      .then(([settings, agents]) => {
        if (cancelled) {
          return;
        }
        setAssistantSettings(settings);
        setDesktopHelperAgentKey(settings.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY);
        setQuickAssistantEnabled(settings.quickAssistantEnabled);
        setQuickAssistantAgentKey(settings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY);
        setDesktopCopilotPages(settings.desktopCopilotPages || createDefaultDesktopCopilotPagePreferences());
        setAssistantAgentOptions(Array.isArray(agents) ? agents : []);
      })
      .catch((reason) => {
        if (!cancelled) {
          setFeedback(reason instanceof Error ? reason.message : String(reason));
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
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setFeedback(reason instanceof Error ? reason.message : String(reason));
        }
      });

    const dispose = window.electronAPI.desktopPet.onStateChanged((state) => {
      if (!cancelled) {
        setDesktopPetState(state);
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
        message: `${DESKTOP_COPILOT_PAGE_LABELS[pageKey]} 的侧边助手智能体不可用。`
      }];
    });
    return {
      valid: issues.length === 0,
      issues
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
      setFeedback("侧边助手配置已保存。");
      return nextSettings;
    } catch (reason) {
      setDesktopCopilotPages(previousPages);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setDesktopCopilotPagePending("");
    }
  }

  async function handleToggleCopilotPage(pageKey: DesktopCopilotPageKey) {
    await saveDesktopCopilotPages({
      ...desktopCopilotPages,
      [pageKey]: {
        ...desktopCopilotPages[pageKey],
        enabled: !desktopCopilotPages[pageKey].enabled
      }
    }, pageKey).catch(() => undefined);
  }

  async function handleSelectCopilotAgent(pageKey: DesktopCopilotPageKey, nextAgentKey: string) {
    const normalizedAgentKey = nextAgentKey.trim() || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
    await saveDesktopCopilotPages({
      ...desktopCopilotPages,
      [pageKey]: {
        ...desktopCopilotPages[pageKey],
        agentKey: normalizedAgentKey
      }
    }, pageKey).catch(() => undefined);
  }

  useEffect(() => {
    return registerDesktopActionProvider(async (request) => {
      const args = request.args ?? {};
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
          ? "侧边栏默认助手配置可用。"
          : "请选择当前智能体列表中存在的侧边栏默认助手。"
      };
      const quickAssistantValidation = {
        field: "quickAssistantAgentKey",
        value: requestedQuickAssistantAgentKey,
        valid: Boolean(requestedQuickAssistantAgentKey && nextQuickAssistantAgent),
        message: nextQuickAssistantAgent
          ? "快捷助手默认智能体配置可用。"
          : "请选择当前智能体列表中存在的快捷助手默认智能体。"
      };

      switch (request.action) {
        case "desktop.page.getFormState":
          return {
            ok: true,
            result: {
              page: "settings",
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
            }
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
                    : "侧边助手配置不可用。",
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
    memorySettings?.enabled
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
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
      if (result.ok) {
        setCustomSidebarLabel("");
        setCustomSidebarUrl("");
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarPending(false);
    }
  }

  async function handleDeleteCustomSidebarItem(item: CustomSidebarItem) {
    setDeletingCustomSidebarId(item.id);
    try {
      const result = await window.electronAPI.customSidebar.remove(item.id);
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeletingCustomSidebarId("");
    }
  }

  async function handleUpdateCustomSidebarAgent(itemId: string, agentKey: string) {
    setCustomSidebarAgentPendingId(itemId);
    try {
      const result = await window.electronAPI.customSidebar.update(itemId, { agentKey });
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarAgentPendingId("");
    }
  }

  async function handleReloadCustomSidebarItems() {
    try {
      const result = await onRefreshCustomSidebarItems();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function handleImportCustomSidebarItems() {
    setCustomSidebarTransferPending("import");
    try {
      const result = await window.electronAPI.customSidebar.import();
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarTransferPending("");
    }
  }

  async function handleExportCustomSidebarItems() {
    setCustomSidebarTransferPending("export");
    try {
      const result = await window.electronAPI.customSidebar.export();
      setFeedback(result.path ? `${result.message} ${result.path}` : result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(nextSettings.enabled ? "助手记忆已开启。" : "助手记忆已关闭。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(nextSettings.autoLearn ? "自动学习已开启。" : "自动学习已关闭。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  async function handleClearMemoryItems() {
    setMemoryPending("clear");
    try {
      const result = await window.electronAPI.assistant.clearMemoryItems();
      setFeedback(result.message);
      await refreshMemoryItems();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  async function handleOpenMemoryDirectory() {
    setMemoryPending("open");
    try {
      const result = await window.electronAPI.assistant.openMemoryDirectory();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  const recentMemoryItems = memoryItems.slice(0, 3);
  const memoryTotal = memoryStats?.total ?? 0;
  const memoryFactCount = memoryStats?.factCount ?? 0;
  const memoryObservationCount = memoryStats?.observationCount ?? 0;
  const memoryRecallLabel = memorySettings?.enabled ? "回答时按需引用" : "已暂停引用";
  const memoryAutoLearnLabel = memorySettings?.autoLearn ? "对话后自动整理" : "仅保留现有记忆";

  async function handleToggleDesktopPet() {
    setDesktopPetPending(true);
    try {
      const nextState = await window.electronAPI.desktopPet.saveSettings({
        enabled: !desktopPetState?.enabled
      });
      setDesktopPetState(nextState);
      setFeedback(nextState.enabled ? "桌面宠物已开启。" : "桌面宠物已关闭。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      if (nextState.appearanceId === appearanceId) {
        setFeedback(`桌面宠物形象已切换为 ${selectedAppearance?.displayName ?? appearanceId}。`);
      } else {
        setFeedback("桌面宠物形象切换未生效，请重启应用后再试。");
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(`桌面宠物已绑定到 ${nextAgent?.displayName ?? nextState.boundAgentKey}。`);
    } catch (reason) {
      setDesktopPetBoundAgentKey(previousBoundAgentKey);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(`侧边助手默认智能体已切换为 ${nextAgent?.displayName ?? nextSettings.desktopHelperAgentKey}。`);
    } catch (reason) {
      setDesktopHelperAgentKey(previousAgentKey);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(nextSettings.quickAssistantEnabled ? "快捷助手已开启。" : "快捷助手已关闭。");
    } catch (reason) {
      setQuickAssistantEnabled(previousEnabled);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
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
      setFeedback(`快捷助手默认智能体已切换为 ${nextAgent?.displayName ?? nextSettings.quickAssistantAgentKey}。`);
    } catch (reason) {
      setQuickAssistantAgentKey(previousAgentKey);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setQuickAssistantAgentPending(false);
    }
  }

  function moveSidebarNavOrderItem(itemKey: SidebarNavOrderItemKey, direction: -1 | 1) {
    const currentIndex = sidebarNavOrder.indexOf(itemKey);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sidebarNavOrder.length) {
      return;
    }
    const nextOrder = [...sidebarNavOrder];
    const [movedItem] = nextOrder.splice(currentIndex, 1);
    nextOrder.splice(nextIndex, 0, movedItem);
    onSidebarNavOrderChange(nextOrder);
    setFeedback("导航页签排序已更新。");
  }

  function resetSidebarNavOrder() {
    const nextOrder = availableSidebarNavOrderItems.map((item) => item.key);
    onSidebarNavOrderChange(nextOrder);
    setFeedback("导航页签排序已恢复默认。");
  }

  const sidebarNavOrderLabels = new Map(availableSidebarNavOrderItems.map((item) => [item.key, item.label]));
  const activeSectionDefinition = sectionDefinitions.find((definition) => definition.id === activeSection) ?? null;
  const activeSectionWidthClass = WIDE_SETTINGS_SECTIONS.has(activeSection) ? "workspace-wide" : "workspace-measure";

  function renderActiveSection() {
    switch (activeSection) {
      case "appearance":
        return (
          <div className="data-root-card settings-theme-card">
            <div>
              <p className="eyebrow">APPEARANCE</p>
              <h2>主题模式</h2>
              <p className="page-copy">
                选择你更习惯的界面风格。当前正在使用
                <strong>{themeMode === "light" ? "浅色" : "深色"}</strong>
                主题。
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
                  <strong>浅色</strong>
                  <span>适合白天和明亮环境</span>
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
                  <strong>深色</strong>
                  <span>适合夜间和长时间专注</span>
                </span>
              </button>
            </div>
          </div>
        );
      case "navigation":
        return (
          <div className="data-root-card navigation-settings-card">
            <div className="navigation-settings-copy">
              <p className="eyebrow">NAVIGATION</p>
              <h2>导航栏</h2>
              <p className="page-copy">
                设置主导航页签 item 的显示顺序。
                {isMac ? " macOS 会自动使用原生半透明窗口效果。" : " 当前平台会自动应用 CSS 半透明效果。"}
              </p>
            </div>
            <div className="navigation-settings-panel">
              <div className="navigation-order-section">
                <div className="custom-sidebar-list-head">
                  <strong>导航页签排序</strong>
                  <button type="button" className="text-button" onClick={resetSidebarNavOrder}>
                    恢复默认
                  </button>
                </div>
                <div className="navigation-order-list">
                  {sidebarNavOrder.map((itemKey, index) => (
                    <div className="navigation-order-row" key={itemKey}>
                      <span>{sidebarNavOrderLabels.get(itemKey) ?? itemKey}</span>
                      <div className="navigation-order-actions">
                        <button
                          type="button"
                          className="text-button"
                          disabled={index === 0}
                          onClick={() => moveSidebarNavOrderItem(itemKey, -1)}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={index === sidebarNavOrder.length - 1}
                          onClick={() => moveSidebarNavOrderItem(itemKey, 1)}
                        >
                          下移
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case "quickAssistant":
        return (
          <div className="data-root-card settings-switch-card desktop-helper-settings-card">
            <div>
              <p className="eyebrow">DESKTOP ASSISTANT</p>
              <h2>快捷助手</h2>
              <p className="page-copy">
                单独配置 Option+Space 唤起的快捷助手，和侧边助手、宠物助手相互独立。
              </p>
              <div className="quick-assistant-settings-panel" aria-label="快捷助手配置">
                <div className="page-copilot-row-main">
                  <strong>快捷助手</strong>
                  <span>
                    {quickAssistantEnabled
                      ? `Option+Space 已开启，默认使用 ${getAgentLabel(quickAssistantAgentKey)}`
                      : "Option+Space 已关闭"}
                  </span>
                  {quickAssistantEnabled && !isKnownAssistantAgent(quickAssistantAgentKey) ? (
                    <em>当前默认智能体不可用，请重新选择。</em>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={quickAssistantEnabled ? "settings-switch is-on" : "settings-switch"}
                  role="switch"
                  aria-checked={quickAssistantEnabled}
                  aria-label="快捷助手"
                  disabled={quickAssistantPending}
                  onClick={() => void handleToggleQuickAssistantEnabled()}
                >
                  <span aria-hidden="true" />
                </button>
                <label className="desktop-pet-agent-field">
                  <span>默认智能体</span>
                  <span className="desktop-pet-agent-select-wrap">
                    <select
                      value={isKnownAssistantAgent(quickAssistantAgentKey) ? quickAssistantAgentKey : ""}
                      onChange={(event) => void handleSelectQuickAssistantAgentKey(event.target.value)}
                      disabled={!quickAssistantEnabled || assistantAgentOptions.length === 0 || quickAssistantAgentPending}
                      aria-label="快捷助手默认智能体"
                    >
                      <option value="">
                        {assistantAgentOptions.length === 0
                          ? "正在读取智能体列表..."
                          : isKnownAssistantAgent(quickAssistantAgentKey) ? "请选择智能体" : `不可用：${quickAssistantAgentKey}`}
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
      case "sideAssistant":
        return (
          <div className="data-root-card settings-switch-card desktop-helper-settings-card">
            <div>
              <p className="eyebrow">SIDE ASSISTANT</p>
              <h2>侧边助手</h2>
              <p className="page-copy">
                为每个一级页签配置是否显示侧边助手，以及默认使用哪个智能体。这个设置不影响宠物助手绑定。
                全局默认只作为旧配置兼容保留。
              </p>
              <div className="desktop-pet-agent-form">
                <label className="desktop-pet-agent-field">
                  <span>兼容默认智能体</span>
                  <span className="desktop-pet-agent-select-wrap">
                    <select
                      value={assistantAgentOptions.some((agent) => agent.agentKey === desktopHelperAgentKey) ? desktopHelperAgentKey : ""}
                      onChange={(event) => void handleSelectDesktopHelperAgentKey(event.target.value)}
                      disabled={assistantAgentOptions.length === 0 || desktopHelperAgentPending}
                    >
                      <option value="">
                        {assistantAgentOptions.length === 0 ? "正在读取智能体列表..." : "请选择智能体"}
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
                      ? "保存中..."
                      : `当前默认：${
                          assistantAgentOptions.find((agent) => agent.agentKey === (assistantSettings?.desktopHelperAgentKey || desktopHelperAgentKey))?.displayName ||
                          assistantSettings?.desktopHelperAgentKey ||
                          desktopHelperAgentKey
                        }`}
                  </span>
                </label>
              </div>
              <div className="desktop-copilot-page-list page-copilot-matrix" aria-label="侧边助手配置">
                {DESKTOP_COPILOT_PAGE_KEYS.map((pageKey) => {
                  const preference = desktopCopilotPages[pageKey] ?? {
                    enabled: true,
                    agentKey: DEFAULT_DESKTOP_HELPER_AGENT_KEY
                  };
                  const pending = desktopCopilotPagePending === pageKey || desktopCopilotPagePending === "all";
                  const currentAgentAvailable = isKnownAssistantAgent(preference.agentKey);
                  return (
                    <div className="desktop-copilot-page-row page-copilot-row" key={pageKey}>
                      <div className="page-copilot-row-main">
                        <strong>{DESKTOP_COPILOT_PAGE_LABELS[pageKey]}</strong>
                        <span>{preference.enabled ? `使用 ${getAgentLabel(preference.agentKey)}` : "不显示侧边助手"}</span>
                        {!currentAgentAvailable && preference.enabled ? (
                          <em>当前智能体不可用，请重新选择。</em>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className={preference.enabled ? "settings-switch is-on" : "settings-switch"}
                        role="switch"
                        aria-checked={preference.enabled}
                        aria-label={`${DESKTOP_COPILOT_PAGE_LABELS[pageKey]} 页面助手`}
                        disabled={pending}
                        onClick={() => void handleToggleCopilotPage(pageKey)}
                      >
                        <span aria-hidden="true" />
                      </button>
                      <label className="desktop-pet-agent-field">
                        <span className="desktop-pet-agent-select-wrap">
                          <select
                            value={currentAgentAvailable ? preference.agentKey : ""}
                            onChange={(event) => void handleSelectCopilotAgent(pageKey, event.target.value)}
                            disabled={!preference.enabled || assistantAgentOptions.length === 0 || pending}
                            aria-label={`${DESKTOP_COPILOT_PAGE_LABELS[pageKey]} 侧边助手智能体`}
                          >
                            <option value="">
                              {assistantAgentOptions.length === 0
                                ? "正在读取智能体列表..."
                                : currentAgentAvailable ? "请选择智能体" : `不可用：${preference.agentKey}`}
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
                  );
                })}
              </div>
            </div>
          </div>
        );
      case "desktopPet":
        return desktopPetSupported ? (
          <div className="data-root-card settings-switch-card desktop-pet-settings-card">
            <div>
              <p className="eyebrow">DESKTOP PET</p>
              <h2>宠物助手</h2>
              <p className="page-copy">
                宠物只服务侧边助手，会在等待回答、完成或出错时做轻提醒。右键宠物可直接关闭。
              </p>
              <p className="settings-inline-note">
                当前状态：{desktopPetState?.enabled ? "已开启" : "已关闭"}
                {desktopPetState?.enabled && desktopPetState.visible ? " / 已显示" : ""}
              </p>
              <div className="desktop-pet-appearance-section" aria-label="宠物形象">
                <div className="desktop-pet-appearance-heading">
                  <span>宠物形象</span>
                  <small>当前：{desktopPetAppearanceOptions.find((appearance) => appearance.id === currentDesktopPetAppearanceId)?.displayName ?? "小宅"}</small>
                </div>
                <div className="desktop-pet-appearance-grid">
                  {desktopPetAppearanceOptions.map((appearance) => {
                    const selected = appearance.id === currentDesktopPetAppearanceId;
                    const pending = desktopPetAppearancePending === appearance.id;
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
                          <strong>{appearance.displayName}</strong>
                          <small>{pending ? "切换中..." : appearance.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="desktop-pet-agent-form">
                <label className="desktop-pet-agent-field">
                  <span>选择智能体</span>
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
                          ? "开启后读取智能体列表"
                          : desktopPetAgentOptions.length === 0
                            ? "正在读取智能体列表..."
                            : "请选择智能体"}
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
                      ? "绑定中..."
                      : `当前绑定：${
                          currentDesktopPetAgentOption?.displayName
                            ? `${currentDesktopPetAgentOption.displayName}${currentDesktopPetAgentOption.role ? ` · ${currentDesktopPetAgentOption.role}` : ""}`
                            : currentDesktopPetBoundAgentKey
                        }`}
                  </span>
                </label>
              </div>
            </div>
            <button
              type="button"
              className={desktopPetState?.enabled ? "settings-switch is-on" : "settings-switch"}
              role="switch"
              aria-checked={Boolean(desktopPetState?.enabled)}
              aria-label="桌面宠物"
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
            <div className="custom-sidebar-copy">
              <p className="eyebrow">SIDEBAR</p>
              <h2>内嵌网站</h2>
              <p className="page-copy">
                将常用网页作为内嵌网站固定至导航栏便捷访问。内嵌网站仅保存在本地，支持导入导出，系统入口不可修改。
              </p>
            </div>
            <div className="custom-sidebar-panel">
              <form className="custom-sidebar-form" onSubmit={(event) => void handleAddCustomSidebarItem(event)}>
                <label>
                  <span>显示名称</span>
                  <input
                    value={customSidebarLabel}
                    onChange={(event) => setCustomSidebarLabel(event.target.value)}
                    placeholder="例如：官网、知识库"
                    maxLength={24}
                  />
                </label>
                <label>
                  <span>网页地址</span>
                  <input
                    value={customSidebarUrl}
                    onChange={(event) => setCustomSidebarUrl(event.target.value)}
                    placeholder="支持输入完整链接或域名，例如 jira.example.com"
                    required
                  />
                </label>
                <div className="custom-sidebar-submit-wrap">
                  <button type="submit" className="text-button custom-sidebar-submit" disabled={customSidebarPending}>
                    {customSidebarPending ? "添加中..." : "添加内嵌网站"}
                  </button>
                </div>
              </form>

              <div className="custom-sidebar-list-head">
                <strong>已添加的内嵌网站</strong>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void handleImportCustomSidebarItems()}
                    disabled={customSidebarTransferPending !== ""}
                  >
                    {customSidebarTransferPending === "import" ? "导入中..." : "导入"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void handleExportCustomSidebarItems()}
                    disabled={customSidebarTransferPending !== ""}
                  >
                    {customSidebarTransferPending === "export" ? "导出中..." : "导出"}
                  </button>
                  <button type="button" className="text-button" onClick={() => void handleReloadCustomSidebarItems()}>
                    刷新
                  </button>
                </div>
              </div>
              {customSidebarItems.length === 0 ? (
                <div className="custom-sidebar-empty">还没有添加内嵌网站，添加后会显示在系统入口下方。</div>
              ) : (
                <div className="custom-sidebar-list">
                  {customSidebarItems.map((item) => {
                    const itemAgentKey = item.agentKey || "";
                    const itemAgentKnown = !itemAgentKey || assistantAgentOptions.some((agent) => agent.agentKey === itemAgentKey);
                    const itemAgentPending = customSidebarAgentPendingId === item.id;
                    return (
                      <div className="custom-sidebar-row" key={item.id}>
                        <div className="custom-sidebar-row-main">
                          <span className="custom-sidebar-row-icon" aria-hidden="true">
                            <CustomSidebarIcon iconId={item.iconId} />
                          </span>
                          <div className="custom-sidebar-row-copy">
                            <strong>{item.label}</strong>
                            <span>{item.url}</span>
                            <div className="custom-sidebar-row-agent">
                              <span className="custom-sidebar-row-agent-label">智能体增强</span>
                              <select
                                className="custom-sidebar-agent-select"
                                value={itemAgentKey}
                                onChange={(event) => void handleUpdateCustomSidebarAgent(item.id, event.target.value)}
                                disabled={assistantAgentOptions.length === 0 || itemAgentPending}
                                aria-label={`${item.label} 关联智能体`}
                              >
                                <option value="">默认助手</option>
                                {itemAgentKey && !itemAgentKnown ? (
                                  <option value={itemAgentKey}>不可用：{itemAgentKey}</option>
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
                          {deletingCustomSidebarId === item.id ? "删除中..." : "删除"}
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
        return isWindows ? <WindowsDataRootCard onError={setFeedback} /> : null;
      case "memory":
        return (
          <div className="data-root-card assistant-memory-card">
            <div className="custom-sidebar-copy assistant-memory-copy">
              <p className="eyebrow">MEMORY</p>
              <h2>助手记忆</h2>
              <p className="page-copy">
                侧边助手会在本机静默学习长期偏好和可复用结论，并在后续回答中按需引用。
              </p>
              <div className="assistant-memory-stats" aria-label="记忆统计">
                <div>
                  <strong>{memoryTotal}</strong>
                  <span>全部</span>
                </div>
                <div>
                  <strong>{memoryFactCount}</strong>
                  <span>稳定</span>
                </div>
                <div>
                  <strong>{memoryObservationCount}</strong>
                  <span>观察</span>
                </div>
              </div>
              <div className="assistant-memory-timeline" aria-label="记忆时间">
                <span>学习 {formatMemoryTime(memoryStats?.lastLearnedAt)}</span>
                <span>引用 {formatMemoryTime(memoryStats?.lastReferencedAt)}</span>
              </div>
              <p className="assistant-memory-audit">最近记录：{formatMemoryAuditSummary(memoryRecentAudit)}</p>
            </div>
            <div className="assistant-memory-panel">
              <div className="assistant-memory-switches">
                <div className="assistant-memory-switch-row">
                  <span className="assistant-memory-switch-copy">
                    <span>记忆召回</span>
                    <small>{memoryRecallLabel}</small>
                  </span>
                  <button
                    type="button"
                    className={memorySettings?.enabled ? "settings-switch is-on" : "settings-switch"}
                    role="switch"
                    aria-checked={Boolean(memorySettings?.enabled)}
                    aria-label="记忆召回"
                    disabled={!memorySettings || memoryPending === "settings"}
                    onClick={() => void handleToggleMemoryEnabled()}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                <div className="assistant-memory-switch-row">
                  <span className="assistant-memory-switch-copy">
                    <span>自动学习</span>
                    <small>{memoryAutoLearnLabel}</small>
                  </span>
                  <button
                    type="button"
                    className={memorySettings?.autoLearn ? "settings-switch is-on" : "settings-switch"}
                    role="switch"
                    aria-checked={Boolean(memorySettings?.autoLearn)}
                    aria-label="自动学习"
                    disabled={!memorySettings || memoryPending === "settings"}
                    onClick={() => void handleToggleMemoryAutoLearn()}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="custom-sidebar-list-head assistant-memory-section-head">
                <strong>最近记忆</strong>
                <span>{memoryItems.length > 0 ? `最近 ${recentMemoryItems.length} / ${memoryItems.length}` : "暂无"}</span>
              </div>
              {recentMemoryItems.length > 0 ? (
                <div className="assistant-memory-list">
                  {recentMemoryItems.map((item) => (
                    <div className="assistant-memory-row" key={item.id}>
                      <div className="assistant-memory-row-main">
                        <div className="assistant-memory-row-title">
                          <strong>{item.title}</strong>
                          <span>{item.category} / {formatMemoryStatus(item.status)}</span>
                        </div>
                        <p>{formatMemoryPreview(item.summary, 64)}</p>
                      </div>
                      <time dateTime={item.updatedAt}>{formatMemoryTime(item.updatedAt)}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="settings-inline-note">最近记忆会在这里显示。</p>
              )}
              <div className="assistant-memory-storage-card">
                <div className="assistant-memory-storage-header">
                  <div>
                    <strong>本地存储</strong>
                    <span>路径和审计日志默认收起，需要时再查看。</span>
                  </div>
                  <span className="assistant-memory-storage-actions">
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void handleOpenMemoryDirectory()}
                      disabled={memoryPending === "open"}
                    >
                      {memoryPending === "open" ? "打开中..." : "打开目录"}
                    </button>
                    <button
                      type="button"
                      className="danger-text-button"
                      onClick={() => void handleClearMemoryItems()}
                      disabled={memoryTotal === 0 || memoryPending === "clear"}
                    >
                      {memoryPending === "clear" ? "清空中..." : "清空"}
                    </button>
                  </span>
                </div>
                <details className="assistant-memory-storage-details">
                  <summary>
                    <span>查看本地文件路径</span>
                    <span className="assistant-memory-storage-caret" aria-hidden="true" />
                  </summary>
                  <div className="assistant-memory-storage">
                    <div>
                      <span>记忆目录</span>
                      <code>{memoryStorage?.directoryPath ?? "正在读取..."}</code>
                    </div>
                    <div>
                      <span>结构化记忆</span>
                      <code>{memoryStorage?.recordsPath ?? "正在读取..."}</code>
                    </div>
                    <div>
                      <span>静态长期记忆</span>
                      <code>{memoryStorage?.staticPath ?? "正在读取..."}</code>
                    </div>
                    <div>
                      <span>审计日志</span>
                      <code>{memoryStorage?.auditPath ?? "正在读取..."}</code>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <section className="settings-page workspace-wide" data-settings-section={activeSection}>
      <div className={`settings-mode-toolbar ${activeSectionWidthClass}`}>
        <button
          type="button"
          className="settings-mode-close-button"
          onClick={onExitSettingsMode}
          aria-label="退出设置模式"
          title="返回上一页"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className={`page-head ${activeSectionWidthClass}`}>
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>{activeSectionDefinition?.label ?? "设置"}</h1>
          <p className="page-copy">{activeSectionDefinition?.description ?? "管理当前设置模块。"}</p>
        </div>
      </div>

      {feedback ? <div className={`feedback-banner ${activeSectionWidthClass}`}>{feedback}</div> : null}
      <div className={activeSectionWidthClass}>
        {renderActiveSection()}
      </div>
    </section>
  );
}
