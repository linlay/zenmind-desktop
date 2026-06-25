import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, Modal, QRCode, Segmented, Select, Space, Switch, Typography } from "antd";
import { useLocation, useParams } from "react-router-dom";
import { PageFeedbackStack } from "../../components/PageFeedbackStack";
import { ControlCenterPage } from "../control-center/ControlCenterPage";
import "./SettingsPage.css";
import type {
  AssistantNavAgentItem,
  AssistantSettingsPublic,
  WebsiteEntry,
  DesktopAppPairingPayloadResult,
  DesktopAppInfo,
  DesktopDeviceInfo,
  DesktopDeviceIdentityInfo,
  DesktopGeneralSettings,
  DesktopWsProbeResult,
  DesktopPetAgentOption,
  DesktopPetState,
  DesktopRuntimeEnvResetResult,
  DesktopSsoStatus,
  DesktopUsageProfileLogEntry,
  DesktopUsageProfileRateLimitStatus,
  DesktopUsageProfileResult,
  DesktopUsageProfileSession,
  DesktopUsageProfileTrafficBucket,
  DesktopWsServerState,
  IdentityAccessTokenInspection,
  MarketSettings,
  KanbanCloudConfig,
  KanbanProject,
  PairingTargetMode,
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
import type { DesktopActionCallRequest, DesktopActionDefinition } from "../../../shared/desktop-actions";

type ThemePreference = "light" | "dark" | "system";
type KanbanConnectionState = "disabled" | "connecting" | "open" | "closed" | "error";
type DebugCategoryId = "device" | "logs" | "wsServer" | "authTokens" | "other";
type UsageHeatmapMode = "day" | "week" | "cumulative";
type DebugLogDirection = "in" | "out" | "system";

type DebugLogEntry = {
  id: number;
  direction: DebugLogDirection;
  text: string;
};

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
  isWindows: boolean;
  runtimeResetPending: boolean;
  runtimeResetResult: DesktopRuntimeEnvResetResult | null;
  onResetRuntimeEnv: () => void | Promise<void>;
};

const THEME_PREFERENCE_OPTIONS: ThemePreference[] = ["light", "dark", "system"];
const DEBUG_CATEGORY_IDS: DebugCategoryId[] = ["device", "logs", "wsServer", "authTokens", "other"];
const SETTINGS_SELECT_CLASS_NAMES = {
  popup: {
    root: "settings-select-popup"
  }
};
const DEFAULT_DESKTOP_ACTION_NAME = "desktop.setting.getState";
const DEFAULT_WS_DEBUG_COMMAND = {
  type: "runtime.info",
  payload: {}
};
const DEFAULT_WS_ACTION_DEBUG_COMMAND = {
  type: "action.call",
  payload: {
    action: DEFAULT_DESKTOP_ACTION_NAME,
    args: {}
  }
};
const APP_PAIRING_TARGET_MODES: PairingTargetMode[] = ["local", "lan", "tunnel"];

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

function getDebugCategoryLabel(categoryId: DebugCategoryId, t: TranslateFunction) {
  switch (categoryId) {
    case "device":
      return t("settings.debug.categories.device");
    case "logs":
      return t("settings.debug.categories.logs");
    case "wsServer":
      return t("settings.debug.categories.wsServer");
    case "authTokens":
      return t("settings.debug.categories.authTokens");
    default:
      return t("settings.debug.categories.other");
  }
}

function getKanbanProjectOptionLabel(project: KanbanProject) {
  const path = project.path.trim();
  if (path && path !== project.name) {
    return `${project.name} · ${path}`;
  }
  return project.name;
}

function sortKanbanProjectOptions(projects: KanbanProject[]) {
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

function getPairingTargetModeLabel(targetMode: PairingTargetMode, t: TranslateFunction) {
  switch (targetMode) {
    case "lan":
      return t("settings.mobilePairing.targetModeLan");
    case "tunnel":
      return t("settings.mobilePairing.targetModeTunnel");
    default:
      return t("settings.mobilePairing.targetModeLocal");
  }
}

function maskPairingPayloadText(value: string) {
  return value ? "zmpair:v2:********" : "";
}

function dateKeyUTC(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseUsageDate(value: string) {
  const normalized = value.includes("T") ? value : `${value}T00:00:00.000Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUTCDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUTCWeek(date: Date) {
  const next = new Date(date);
  const dayIndex = (next.getUTCDay() + 6) % 7;
  next.setUTCDate(next.getUTCDate() - dayIndex);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function formatUsageTokenCount(value: number, locale: SupportedLocale) {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (locale === "zh-CN") {
    if (normalized >= 100_000_000) {
      return `${Number((normalized / 100_000_000).toFixed(normalized >= 1_000_000_000 ? 0 : 1))}\u4ebf`;
    }
    if (normalized >= 10_000) {
      return `${Number((normalized / 10_000).toFixed(normalized >= 1_000_000 ? 0 : 1))}\u4e07`;
    }
  }
  return new Intl.NumberFormat(locale, {
    notation: normalized >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: normalized >= 100_000 ? 1 : 0
  }).format(normalized);
}

function formatUsageCount(value: number, locale: SupportedLocale) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

function formatUsageCostMicro(value: number, currency: string, locale: SupportedLocale) {
  const normalizedCurrency = currency || "USD";
  const amount = (Number.isFinite(value) ? value : 0) / 1_000_000;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: amount >= 100 ? 0 : 2
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(2)}`;
  }
}

function formatUsageDateTime(value: string, locale: SupportedLocale, fallback: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return fallback;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function buildUsageDailyMap(items: DesktopUsageProfileTrafficBucket[]) {
  const dailyMap = new Map<string, DesktopUsageProfileTrafficBucket>();
  for (const item of items) {
    const date = parseUsageDate(item.bucket);
    if (!date) {
      continue;
    }
    const key = dateKeyUTC(date);
    const current = dailyMap.get(key);
    dailyMap.set(key, {
      ...item,
      bucket: key,
      requests: (current?.requests ?? 0) + item.requests,
      request_tokens: (current?.request_tokens ?? 0) + item.request_tokens,
      response_tokens: (current?.response_tokens ?? 0) + item.response_tokens,
      total_tokens: (current?.total_tokens ?? 0) + item.total_tokens,
      cache_hit_tokens: (current?.cache_hit_tokens ?? 0) + item.cache_hit_tokens,
      cache_miss_tokens: (current?.cache_miss_tokens ?? 0) + item.cache_miss_tokens,
      cache_total_tokens: (current?.cache_total_tokens ?? 0) + item.cache_total_tokens,
      cache_hit_rate: item.cache_hit_rate,
      cost_micro: (current?.cost_micro ?? 0) + item.cost_micro,
      error_requests: (current?.error_requests ?? 0) + item.error_requests,
      average_latency_ms: item.average_latency_ms
    });
  }
  return dailyMap;
}

function calculateUsageStreaks(items: DesktopUsageProfileTrafficBucket[], now: Date) {
  const activeDays = new Set(
    items
      .filter((item) => item.total_tokens > 0)
      .map((item) => parseUsageDate(item.bucket))
      .filter((date): date is Date => date !== null)
      .map(dateKeyUTC)
  );
  let currentStreak = 0;
  let cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  while (activeDays.has(dateKeyUTC(cursor))) {
    currentStreak += 1;
    cursor = addUTCDays(cursor, -1);
  }

  let longestStreak = 0;
  let runningStreak = 0;
  const sortedDays = [...activeDays].sort();
  let previousDay = "";
  for (const day of sortedDays) {
    const date = parseUsageDate(day);
    const previousDate = previousDay ? parseUsageDate(previousDay) : null;
    const consecutive = date && previousDate
      ? dateKeyUTC(addUTCDays(previousDate, 1)) === dateKeyUTC(date)
      : false;
    runningStreak = consecutive ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = day;
  }

  return { currentStreak, longestStreak };
}

function aggregateUsageModels(logs: DesktopUsageProfileLogEntry[]) {
  const byModel = new Map<string, { model: string; requests: number; tokens: number; costMicro: number }>();
  for (const log of logs) {
    const model = log.public_model || log.upstream_model || log.provider || "unknown";
    const current = byModel.get(model) ?? { model, requests: 0, tokens: 0, costMicro: 0 };
    current.requests += 1;
    current.tokens += log.total_tokens;
    current.costMicro += log.cost_micro;
    byModel.set(model, current);
  }
  return [...byModel.values()].sort((left, right) => right.requests - left.requests).slice(0, 6);
}

function limitUsageProgress(limit: DesktopUsageProfileRateLimitStatus) {
  const quota = limit.cost_quota_micro > 0
    ? limit.cost_quota_micro
    : limit.token_quota > 0
      ? limit.token_quota
      : limit.request_quota;
  const used = limit.cost_quota_micro > 0
    ? limit.cost_micro
    : limit.token_quota > 0
      ? limit.tokens
      : limit.requests;
  const remaining = limit.cost_quota_micro > 0
    ? limit.cost_remaining_micro
    : limit.token_quota > 0
      ? limit.token_remaining
      : limit.request_remaining;
  const usedPercent = quota > 0 ? Math.min(100, Math.max(0, Math.round((used / quota) * 100))) : 0;
  const remainingPercent = quota > 0 ? Math.max(0, Math.min(100, Math.round((remaining / quota) * 100))) : 100;
  return { quota, used, remaining, usedPercent, remainingPercent };
}

function usageAvatarInitials(name: string, email: string) {
  const source = (name || email || "?").trim();
  if (!source) {
    return "?";
  }
  const words = source.split(/\s+/u).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
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
  "websites"
];

const defaultKanbanCloudConfig: KanbanCloudConfig = {
  serverUrl: "",
  token: "",
  selectedProjectId: "default",
  remoteControlEnabled: false,
  deviceAlias: ""
};

const defaultGeneralSettings: DesktopGeneralSettings = {
  deviceName: "",
  preventSleepWhileRunning: true,
  desktopWsServerEnabled: false,
  desktopActionConfirmationEnabled: true
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
  publicHost: "",
  publicUrl: "",
  webSocketUrl: "",
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
    { id: "settings", labelKey: "nav.settings", copilotPageKey: null, fixedAssistantLabelKey: "settings.defaultAssistant" }
  ]
];

const fixedNavigationTools = fixedNavigationToolRows.flat();

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

type UsageSettingsPanelProps = {
  profile: DesktopUsageProfileResult | null;
  ssoStatus: DesktopSsoStatus | null;
  loading: boolean;
  heatmapMode: UsageHeatmapMode;
  onHeatmapModeChange: (mode: UsageHeatmapMode) => void;
  onRefresh: () => void | Promise<void>;
};

function UsageSettingsPanel({
  profile,
  ssoStatus,
  loading,
  heatmapMode,
  onHeatmapModeChange,
  onRefresh
}: UsageSettingsPanelProps) {
  const { locale, t } = useI18n();
  const user = ssoStatus?.user ?? null;
  const displayName = user?.name || user?.email || t("settings.usage.profile.guestName");
  const displayAccount = user?.email || user?.sub || t("settings.usage.profile.accountFallback");
  const statusLabel = ssoStatus?.authenticated
    ? t("settings.usage.profile.statusSignedIn")
    : ssoStatus?.pending
      ? t("sidebar.sso.signingIn")
      : t("settings.usage.profile.statusSignedOut");
  const successProfile = profile?.ok ? profile : null;
  const failureProfile = profile && !profile.ok ? profile : null;

  const dailyMap = useMemo(
    () => buildUsageDailyMap(successProfile?.usage.items ?? []),
    [successProfile]
  );
  const heatmap = useMemo(() => {
    const end = successProfile ? new Date(successProfile.fetchedAt) : new Date();
    if (Number.isNaN(end.getTime())) {
      end.setTime(Date.now());
    }
    end.setUTCHours(0, 0, 0, 0);
    const start = addUTCDays(end, -364);
    const leadingEmptyCells = (start.getUTCDay() + 6) % 7;
    const weekTotals = new Map<string, number>();
    for (const [day, bucket] of dailyMap) {
      const date = parseUsageDate(day);
      if (!date) {
        continue;
      }
      const weekKey = dateKeyUTC(startOfUTCWeek(date));
      weekTotals.set(weekKey, (weekTotals.get(weekKey) ?? 0) + bucket.total_tokens);
    }
    let cumulative = 0;
    const cells = Array.from({ length: 365 }, (_item, index) => {
      const date = addUTCDays(start, index);
      const key = dateKeyUTC(date);
      const dailyTokens = dailyMap.get(key)?.total_tokens ?? 0;
      cumulative += dailyTokens;
      const weekKey = dateKeyUTC(startOfUTCWeek(date));
      const value = heatmapMode === "week"
        ? weekTotals.get(weekKey) ?? 0
        : heatmapMode === "cumulative"
          ? cumulative
          : dailyTokens;
      return {
        key,
        value,
        dailyTokens,
        label: new Intl.DateTimeFormat(locale, {
          month: "2-digit",
          day: "2-digit"
        }).format(date)
      };
    });
    const maxValue = cells.reduce((max, cell) => Math.max(max, cell.value), 0);
    const months: Array<{ key: string; label: string }> = [];
    let monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (monthCursor <= endMonth) {
      months.push({
        key: dateKeyUTC(monthCursor),
        label: new Intl.DateTimeFormat(locale, { month: "short" }).format(monthCursor)
      });
      monthCursor = new Date(Date.UTC(monthCursor.getUTCFullYear(), monthCursor.getUTCMonth() + 1, 1));
    }
    return { leadingEmptyCells, cells, maxValue, months };
  }, [dailyMap, heatmapMode, locale, successProfile]);

  const overview = useMemo(() => {
    if (!successProfile) {
      return [];
    }
    const peakDailyTokens = successProfile.usage.items.reduce(
      (max, item) => Math.max(max, item.total_tokens),
      0
    );
    const streaks = calculateUsageStreaks(successProfile.usage.items, new Date(successProfile.fetchedAt));
    return [{
      label: t("settings.usage.overview.totalTokens"),
      value: formatUsageTokenCount(successProfile.usage.summary.total_tokens, locale)
    }, {
      label: t("settings.usage.overview.peakDailyTokens"),
      value: formatUsageTokenCount(peakDailyTokens, locale)
    }, {
      label: t("settings.usage.overview.currentStreak"),
      value: t("settings.usage.overview.days", { count: streaks.currentStreak })
    }, {
      label: t("settings.usage.overview.longestStreak"),
      value: t("settings.usage.overview.days", { count: streaks.longestStreak })
    }, {
      label: t("settings.usage.overview.sessions"),
      value: formatUsageCount(successProfile.sessions.total, locale)
    }];
  }, [locale, successProfile, t]);

  const modelUsage = useMemo(
    () => aggregateUsageModels(successProfile?.logs.items ?? []),
    [successProfile]
  );
  const priceByModel = useMemo(() => {
    const prices = new Map<string, NonNullable<typeof successProfile>["prices"]["items"][number]>();
    for (const price of successProfile?.prices.items ?? []) {
      prices.set(price.public_model, price);
    }
    return prices;
  }, [successProfile]);

  function renderProfileAvatar() {
    if (user?.avatarUrl) {
      return <img src={user.avatarUrl} alt={t("settings.usage.profile.avatarAlt")} />;
    }
    return <span>{usageAvatarInitials(displayName, displayAccount)}</span>;
  }

  function renderHeatmap() {
    if (!successProfile || successProfile.usage.items.length === 0) {
      return (
        <div className="settings-item-empty usage-heatmap-empty">
          {t("settings.usage.heatmap.empty")}
        </div>
      );
    }
    return (
      <div className="usage-heatmap-scroll" aria-label={t("settings.usage.heatmap.title")}>
        <div className="usage-heatmap-months" aria-hidden="true">
          {heatmap.months.map((month) => <span key={month.key}>{month.label}</span>)}
        </div>
        <div className="usage-heatmap-grid">
          {Array.from({ length: heatmap.leadingEmptyCells }, (_item, index) => (
            <span className="usage-heatmap-cell is-empty" key={`empty-${index}`} aria-hidden="true" />
          ))}
          {heatmap.cells.map((cell) => {
            const level = heatmap.maxValue > 0
              ? Math.min(4, Math.max(1, Math.ceil((cell.value / heatmap.maxValue) * 4)))
              : 0;
            const title = `${cell.label} · ${formatUsageTokenCount(cell.dailyTokens, locale)} ${t("settings.usage.tokens")}`;
            return (
              <span
                className={`usage-heatmap-cell level-${level}`}
                key={cell.key}
                title={title}
                aria-label={title}
              />
            );
          })}
        </div>
      </div>
    );
  }

  function renderLimitRows(limits: DesktopUsageProfileRateLimitStatus[]) {
    if (limits.length === 0) {
      return <div className="settings-item-empty">{t("settings.usage.billing.noLimits")}</div>;
    }
    return (
      <div className="usage-limit-list">
        {limits.map((limit) => {
          const progress = limitUsageProgress(limit);
          return (
            <div className="usage-limit-row" key={`${limit.window}-${limit.starts_at}-${limit.resets_at}`}>
              <div>
                <strong>{limit.window || t("settings.usage.billing.windowFallback")}</strong>
                <span>{t("settings.usage.billing.resetAt", { time: formatUsageDateTime(limit.resets_at, locale, t("common.none")) })}</span>
              </div>
              <div className="usage-limit-meter" aria-label={t("settings.usage.billing.remainingPercent", { percent: progress.remainingPercent })}>
                <span style={{ width: `${progress.usedPercent}%` }} />
              </div>
              <span className="usage-limit-percent">
                {t("settings.usage.billing.remainingPercent", { percent: progress.remainingPercent })}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderAllowedModels() {
    const allowedModels = successProfile?.currentKey.allowed_models ?? [];
    if (allowedModels.length === 0) {
      return <div className="settings-item-empty">{t("settings.usage.billing.allowedModelsEmpty")}</div>;
    }
    return (
      <div className="usage-model-chip-list">
        {allowedModels.slice(0, 12).map((model) => (
          <span className="usage-model-chip" key={model}>{model}</span>
        ))}
      </div>
    );
  }

  function renderCommonModels() {
    if (!successProfile || modelUsage.length === 0) {
      return <div className="settings-item-empty">{t("settings.usage.details.noModels")}</div>;
    }
    return (
      <div className="usage-detail-list">
        {modelUsage.map((item) => (
          <div className="usage-detail-row" key={item.model}>
            <div>
              <strong>{item.model}</strong>
              <span>
                {t("settings.usage.details.modelMeta", {
                  requests: formatUsageCount(item.requests, locale),
                  tokens: formatUsageTokenCount(item.tokens, locale)
                })}
              </span>
            </div>
            <span>{formatUsageCostMicro(item.costMicro, successProfile.balance.currency, locale)}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderDevices(sessions: DesktopUsageProfileSession[]) {
    if (sessions.length === 0) {
      return <div className="settings-item-empty">{t("settings.usage.details.noDevices")}</div>;
    }
    return (
      <div className="usage-detail-list">
        {sessions.slice(0, 6).map((session) => (
          <div className="usage-detail-row" key={`${session.device_id}-${session.source}-${session.last_seen_at}`}>
            <div>
              <strong>{session.device_id || session.source || t("settings.usage.details.deviceFallback")}</strong>
              <span>
                {session.active ? t("settings.usage.details.active") : t("settings.usage.details.idle")}
                {" · "}
                {t("settings.usage.details.lastSeen", {
                  time: formatUsageDateTime(session.last_seen_at, locale, t("common.none"))
                })}
              </span>
            </div>
            <span>{formatUsageTokenCount(session.token_count, locale)}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderPrices() {
    const allowedModels = successProfile?.currentKey.allowed_models ?? [];
    const visiblePrices = allowedModels
      .map((model) => priceByModel.get(model))
      .filter((price): price is NonNullable<typeof price> => Boolean(price))
      .slice(0, 6);
    if (!successProfile || visiblePrices.length === 0) {
      return null;
    }
    return (
      <div className="usage-prices">
        <h3>{t("settings.usage.details.pricesTitle")}</h3>
        <div className="usage-detail-list">
          {visiblePrices.map((price) => (
            <div className="usage-detail-row" key={price.id || price.public_model}>
              <div>
                <strong>{price.public_model}</strong>
                <span>{price.protocol}</span>
              </div>
              <span>
                {t("settings.usage.details.priceMeta", {
                  input: formatUsageCostMicro(price.input_cost_micro_per_1m_tokens, price.currency, locale),
                  output: formatUsageCostMicro(price.output_cost_micro_per_1m_tokens, price.currency, locale)
                })}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const balanceRemaining = successProfile?.balance.items.reduce((total, item) =>
    total + Math.max(0, item.cost_remaining_micro), 0) ?? 0;

  return (
    <div className="usage-settings-stack">
      <div className="data-root-card usage-profile-card">
        <div className="usage-profile-avatar" aria-hidden="true">
          {renderProfileAvatar()}
        </div>
        <div className="usage-profile-copy">
          <h2>{displayName}</h2>
          <p>{displayAccount}</p>
          <span className={`usage-status-pill ${ssoStatus?.authenticated ? "is-active" : "is-muted"}`}>
            {statusLabel}
          </span>
        </div>
        <Button disabled={loading} loading={loading} onClick={() => void onRefresh()}>
          {t("common.refresh")}
        </Button>
      </div>

      {loading && !profile ? (
        <div className="data-root-card">
          <div className="settings-item-empty">{t("common.loading")}</div>
        </div>
      ) : null}

      {failureProfile ? (
        <div className="data-root-card usage-empty-card">
          <h2>{t("settings.usage.empty.title")}</h2>
          <p className="page-copy">{failureProfile.message}</p>
        </div>
      ) : null}

      {successProfile ? (
        <>
          <div className="usage-summary-strip" aria-label={t("settings.usage.overview.title")}>
            {overview.map((item) => (
              <div className="usage-summary-item" key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>

          <div className="data-root-card usage-heatmap-card">
            <div className="usage-card-head">
              <div>
                <h2>{t("settings.usage.heatmap.title")}</h2>
                <p className="page-copy">{t("settings.usage.heatmap.description")}</p>
              </div>
              <Segmented<UsageHeatmapMode>
                value={heatmapMode}
                onChange={onHeatmapModeChange}
                options={[
                  { value: "day", label: t("settings.usage.heatmap.day") },
                  { value: "week", label: t("settings.usage.heatmap.week") },
                  { value: "cumulative", label: t("settings.usage.heatmap.cumulative") }
                ]}
              />
            </div>
            {renderHeatmap()}
          </div>

          <div className="data-root-card usage-billing-card">
            <div className="usage-card-head">
              <div>
                <h2>{t("settings.usage.billing.title")}</h2>
                <p className="page-copy">{t("settings.usage.billing.description")}</p>
              </div>
            </div>
            <div className="usage-billing-panels">
              <div className="usage-billing-panel">
                <strong>{successProfile.currentKey.name || successProfile.provider.providerName}</strong>
                <span>
                  {t("settings.usage.billing.keyMeta", {
                    status: successProfile.currentKey.status || t("common.none"),
                    source: successProfile.currentKey.source || t("common.none")
                  })}
                </span>
                <small>{successProfile.provider.baseURL}</small>
              </div>
              <div className="usage-billing-panel">
                <strong>{formatUsageCostMicro(successProfile.balance.cost_micro, successProfile.balance.currency, locale)}</strong>
                <span>{t("settings.usage.billing.balanceSpent")}</span>
                <small>
                  {successProfile.balance.unlimited
                    ? t("settings.usage.billing.unlimited")
                    : t("settings.usage.billing.remainingCost", {
                        amount: formatUsageCostMicro(balanceRemaining, successProfile.balance.currency, locale)
                      })}
                </small>
              </div>
            </div>
            <div className="usage-section-subhead">
              <h3>{t("settings.usage.billing.limitsTitle")}</h3>
            </div>
            {renderLimitRows(successProfile.limits.rate_limit_usage)}
            <div className="usage-section-subhead">
              <h3>{t("settings.usage.billing.allowedModels")}</h3>
            </div>
            {renderAllowedModels()}
          </div>

          <div className="data-root-card usage-detail-card usage-models-card">
            <div className="usage-section-subhead">
              <h2>{t("settings.usage.details.modelsTitle")}</h2>
            </div>
            {renderCommonModels()}
            {renderPrices()}
          </div>
          <div className="data-root-card usage-detail-card usage-devices-card">
            <div className="usage-section-subhead">
              <h2>{t("settings.usage.details.devicesTitle")}</h2>
            </div>
            {renderDevices(successProfile.sessions.items)}
          </div>
        </>
      ) : null}
    </div>
  );
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

function createDebugRequestId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readDebugJsonObject(text: string, invalidJsonMessage: string, objectMessage: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(invalidJsonMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(objectMessage);
  }
  return parsed as Record<string, unknown>;
}

function buildDesktopActionRequestText(action = DEFAULT_DESKTOP_ACTION_NAME) {
  return formatDebugJson({
    action,
    args: {},
    permissionMode: "full_access"
  });
}

function normalizeDesktopActionDebugRequest(
  input: Record<string, unknown>,
  selectedAction: string,
  requestId: string,
  missingActionMessage: string
): DesktopActionCallRequest {
  const action = typeof input.action === "string" && input.action.trim()
    ? input.action.trim()
    : selectedAction.trim();
  if (!action) {
    throw new Error(missingActionMessage);
  }
  const request: DesktopActionCallRequest = {
    requestId,
    action,
    args: asRecord(input.args)
  };
  const source = asRecord(input.source);
  if (Object.keys(source).length > 0) {
    request.source = source as DesktopActionCallRequest["source"];
  }
  if (
    input.permissionMode === "default" ||
    input.permissionMode === "page_control" ||
    input.permissionMode === "full_access"
  ) {
    request.permissionMode = input.permissionMode;
  }
  if (typeof input.expectedPageKey === "string" && input.expectedPageKey.trim()) {
    request.expectedPageKey = input.expectedPageKey.trim();
  }
  return request;
}

function buildWsDebugCommandText(command: Record<string, unknown> = DEFAULT_WS_DEBUG_COMMAND) {
  return formatDebugJson(command);
}

function normalizeWsDebugFrame(input: Record<string, unknown>, missingTypeMessage: string) {
  const type = typeof input.type === "string" ? input.type.trim() : "";
  if (!type) {
    throw new Error(missingTypeMessage);
  }
  return {
    ns: typeof input.ns === "string" && input.ns.trim() ? input.ns.trim() : "d",
    frame: typeof input.frame === "string" && input.frame.trim() ? input.frame.trim() : "request",
    type,
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : createDebugRequestId("settings_debug_ws"),
    payload: "payload" in input ? input.payload : {}
  };
}

function appendDebugLogEntry(
  setEntries: (updater: (entries: DebugLogEntry[]) => DebugLogEntry[]) => void,
  direction: DebugLogDirection,
  value: unknown
) {
  const text = typeof value === "string" ? value : formatDebugJson(value);
  setEntries((entries) => [
    ...entries.slice(-79),
    {
      id: Date.now() + Math.random(),
      direction,
      text
    }
  ]);
}

function DesktopActionDebugDialog({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [actions, setActions] = useState<DesktopActionDefinition[]>([]);
  const [selectedAction, setSelectedAction] = useState(DEFAULT_DESKTOP_ACTION_NAME);
  const [requestText, setRequestText] = useState(buildDesktopActionRequestText());
  const [responseText, setResponseText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function handleLoadActions() {
    setMessage("");
    try {
      const result = await window.electronAPI.desktopActions.list();
      const nextActions = Array.isArray(result.actions) ? result.actions : [];
      setActions(nextActions);
      if (!nextActions.some((action) => action.name === selectedAction) && nextActions[0]?.name) {
        setSelectedAction(nextActions[0].name);
        setRequestText(buildDesktopActionRequestText(nextActions[0].name));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRunAction() {
    setPending(true);
    setMessage("");
    try {
      const record = readDebugJsonObject(
        requestText,
        t("settings.debug.console.invalidJson"),
        t("settings.debug.console.jsonObjectRequired")
      );
      const request = normalizeDesktopActionDebugRequest(
        record,
        selectedAction,
        createDebugRequestId("settings_debug_action"),
        t("settings.debug.desktopActions.missingAction")
      );
      const response = await window.electronAPI.desktopActions.call(request);
      setResponseText(formatDebugJson(response));
      setMessage(response.ok ? t("settings.debug.desktopActions.completed") : response.error?.message || t("common.error"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function handleCopyResponse() {
    if (!responseText) {
      return;
    }
    await window.electronAPI.clipboard.writeText(responseText);
  }

  useEffect(() => {
    if (open) {
      void handleLoadActions();
    }
  }, [open]);

  return (
    <Modal
      className="settings-debug-modal"
      footer={null}
      open={open}
      title={t("settings.debug.desktopActions.dialogTitle")}
      width={820}
      onCancel={onClose}
    >
      <div className="settings-debug-dialog-body">
        <div className="settings-debug-dialog-actions">
          <Select
            className="settings-debug-action-select"
            classNames={SETTINGS_SELECT_CLASS_NAMES}
            showSearch
            value={selectedAction}
            optionFilterProp="label"
            options={actions.map((action) => ({
              value: action.name,
              label: `${action.name} · ${action.kind}`
            }))}
            onChange={(value) => {
              setSelectedAction(value);
              setRequestText(buildDesktopActionRequestText(value));
            }}
          />
          <Button onClick={() => void handleLoadActions()}>{t("common.refresh")}</Button>
          <Button type="primary" disabled={pending} onClick={() => void handleRunAction()}>
            {pending ? t("common.loading") : t("settings.debug.desktopActions.run")}
          </Button>
          <Button disabled={!responseText} onClick={() => void handleCopyResponse()}>
            {t("settings.debug.desktopActions.copyResponse")}
          </Button>
        </div>
        {message ? (
          <div className={`feedback-banner settings-desktop-ws-message${responseText && !/"ok": true/u.test(responseText) ? " warning-banner" : ""}`} role="status">
            {message}
          </div>
        ) : null}
        <div className="settings-debug-dialog-grid">
          <label className="settings-debug-field">
            <span>{t("settings.debug.desktopActions.request")}</span>
            <textarea value={requestText} onChange={(event) => setRequestText(event.target.value)} spellCheck={false} />
          </label>
          <label className="settings-debug-field">
            <span>{t("settings.debug.desktopActions.response")}</span>
            <textarea value={responseText} readOnly spellCheck={false} />
          </label>
        </div>
      </div>
    </Modal>
  );
}

function DesktopActionDebugCard() {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="data-root-card settings-debug-panel">
      <div className="settings-debug-panel-head">
        <div>
          <h2>{t("settings.debug.desktopActions.title")}</h2>
          <p className="page-copy">{t("settings.debug.desktopActions.description")}</p>
        </div>
      </div>
      <div className="settings-debug-actions">
        <Button type="primary" onClick={() => setDialogOpen(true)}>
          {t("settings.debug.desktopActions.openDialog")}
        </Button>
      </div>
      <DesktopActionDebugDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

function WsServerDebugDialog({
  open,
  onClose,
  url
}: {
  open: boolean;
  onClose: () => void;
  url: string;
}) {
  const { t } = useI18n();
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [commandText, setCommandText] = useState(buildWsDebugCommandText());
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);

  function closeSocket() {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    setConnected(false);
  }

  async function handleConnect() {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const tokenResult = await window.electronAPI.agentAuth.issueAccessToken("missing");
      const token = tokenResult.token.trim();
      if (!tokenResult.ok || !token) {
        throw new Error(tokenResult.message || t("settings.debug.wsConsole.tokenUnavailable"));
      }
      const wsUrl = new URL(url || DESKTOP_WS_URL);
      wsUrl.searchParams.set("token", token);
      wsUrl.searchParams.set("source", "settings-debug-ws-console");
      const socket = new WebSocket(wsUrl.toString());
      socketRef.current = socket;
      appendDebugLogEntry(setEntries, "system", wsUrl.toString().replace(token, "token-redacted"));
      socket.onopen = () => {
        setConnected(true);
        setPending(false);
        setMessage(t("settings.debug.wsConsole.connected"));
      };
      socket.onmessage = (event) => {
        appendDebugLogEntry(setEntries, "in", typeof event.data === "string" ? event.data : String(event.data));
      };
      socket.onerror = () => {
        setMessage(t("settings.debug.wsConsole.error"));
        appendDebugLogEntry(setEntries, "system", t("settings.debug.wsConsole.error"));
      };
      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setConnected(false);
        setPending(false);
        setMessage(t("settings.debug.wsConsole.closed"));
      };
    } catch (error) {
      setPending(false);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function handleDisconnect() {
    closeSocket();
    setMessage(t("settings.debug.wsConsole.closed"));
  }

  function handleSend() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setMessage(t("settings.debug.wsConsole.notConnected"));
      return;
    }
    try {
      const record = readDebugJsonObject(
        commandText,
        t("settings.debug.console.invalidJson"),
        t("settings.debug.console.jsonObjectRequired")
      );
      const frame = normalizeWsDebugFrame(record, t("settings.debug.wsConsole.missingType"));
      const text = JSON.stringify(frame);
      socket.send(text);
      appendDebugLogEntry(setEntries, "out", frame);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (!open) {
      closeSocket();
    }
  }, [open]);

  useEffect(() => () => closeSocket(), []);

  return (
    <Modal
      className="settings-debug-modal"
      footer={null}
      open={open}
      title={t("settings.debug.wsConsole.title")}
      width={860}
      onCancel={onClose}
    >
      <div className="settings-debug-dialog-body">
        <div className="settings-debug-dialog-actions">
          <span className={`settings-desktop-ws-status ${connected ? "is-running" : pending ? "is-pending" : "is-closed"}`}>
            {connected ? t("settings.debug.wsConsole.connected") : pending ? t("common.loading") : t("settings.debug.wsConsole.closed")}
          </span>
          <Button type="primary" disabled={connected || pending} onClick={() => void handleConnect()}>
            {pending ? t("common.loading") : t("settings.debug.wsConsole.connect")}
          </Button>
          <Button disabled={!connected} onClick={() => handleDisconnect()}>
            {t("settings.debug.wsConsole.disconnect")}
          </Button>
          <Button onClick={() => setCommandText(buildWsDebugCommandText(DEFAULT_WS_DEBUG_COMMAND))}>
            {t("settings.debug.wsConsole.runtimeInfo")}
          </Button>
          <Button onClick={() => setCommandText(buildWsDebugCommandText({ type: "action.list", payload: {} }))}>
            {t("settings.debug.wsConsole.actionList")}
          </Button>
          <Button onClick={() => setCommandText(buildWsDebugCommandText(DEFAULT_WS_ACTION_DEBUG_COMMAND))}>
            {t("settings.debug.wsConsole.actionCall")}
          </Button>
        </div>
        {message ? (
          <div className="feedback-banner settings-desktop-ws-message" role="status">
            {message}
          </div>
        ) : null}
        <label className="settings-debug-field">
          <span>{t("settings.debug.wsConsole.command")}</span>
          <textarea value={commandText} onChange={(event) => setCommandText(event.target.value)} spellCheck={false} />
        </label>
        <div className="settings-debug-dialog-actions">
          <Button type="primary" disabled={!connected} onClick={() => handleSend()}>
            {t("settings.debug.wsConsole.send")}
          </Button>
          <Button disabled={entries.length === 0} onClick={() => setEntries([])}>
            {t("settings.debug.wsConsole.clear")}
          </Button>
        </div>
        <div className="settings-debug-log" aria-label={t("settings.debug.wsConsole.messages")}>
          {entries.length === 0 ? (
            <div className="settings-debug-log-empty">{t("settings.debug.wsConsole.empty")}</div>
          ) : entries.map((entry) => (
            <pre key={entry.id} className={`settings-debug-log-entry is-${entry.direction}`}>
              {entry.text}
            </pre>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function DeviceIdentityDebugCard() {
  const { t } = useI18n();
  const [identity, setIdentity] = useState<DesktopDeviceIdentityInfo | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DesktopDeviceInfo | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function handleRefresh() {
    setPending(true);
    setMessage("");
    try {
      const [identityResult, deviceInfoResult] = await Promise.all([
        window.electronAPI.settings.getDeviceIdentity(),
        window.electronAPI.settings.getDesktopDeviceInfo()
      ]);
      setIdentity(identityResult);
      setDeviceInfo(deviceInfoResult);
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

  useEffect(() => {
    void handleRefresh();
  }, []);

  const identityJson = identity ? formatDebugJson(identity) : "";
  const rows: Array<{ label: TranslationKey; value: unknown }> = identity
    ? [
      { label: "settings.debug.device.resolvedDeviceName", value: deviceInfo?.deviceName },
      { label: "settings.debug.device.configuredDeviceName", value: deviceInfo?.configuredDeviceName },
      { label: "settings.debug.device.hostname", value: deviceInfo?.hostname },
      { label: "settings.debug.device.username", value: deviceInfo?.username },
      { label: "settings.debug.device.platform", value: deviceInfo?.platform },
      { label: "settings.debug.device.arch", value: deviceInfo?.arch },
      { label: "settings.debug.device.identityPath", value: identity.identityPath },
      { label: "settings.debug.device.version", value: identity.version },
      { label: "settings.debug.device.installId", value: identity.installId },
      { label: "settings.debug.device.deviceId", value: identity.deviceId },
      { label: "settings.debug.device.machineHash", value: identity.machineHash },
      { label: "settings.debug.device.machineSource", value: identity.machineSource },
      { label: "settings.debug.device.createdAt", value: identity.createdAt },
      { label: "settings.debug.device.updatedAt", value: identity.updatedAt },
      { label: "settings.debug.device.lastMachineMismatchAt", value: identity.lastMachineMismatchAt }
    ]
    : [];

  return (
    <div className="data-root-card settings-debug-panel">
      <div className="settings-debug-panel-head">
        <h2>{t("settings.debug.device.title")}</h2>
        <span className={`settings-desktop-ws-status ${message ? "is-error" : pending ? "is-pending" : identity ? "is-running" : "is-closed"}`}>
          {pending ? t("common.loading") : message ? t("common.error") : identity ? t("settings.debug.device.loaded") : t("settings.debug.empty")}
        </span>
      </div>
      <div className="settings-debug-actions">
        <Button disabled={pending} onClick={() => void handleRefresh()}>
          {pending ? t("common.loading") : t("common.refresh")}
        </Button>
        <Button disabled={!identity?.deviceId} onClick={() => void handleCopy(identity?.deviceId || "")}>
          {t("settings.debug.device.copyDeviceId")}
        </Button>
        <Button disabled={!identityJson} onClick={() => void handleCopy(identityJson)}>
          {t("settings.debug.device.copyJson")}
        </Button>
      </div>
      {message ? (
        <div className="feedback-banner warning-banner settings-desktop-ws-message" role="status">
          {message}
        </div>
      ) : null}
      {identity ? (
        <div className="settings-debug-grid">
          <dl className="settings-debug-facts">
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{t(row.label)}</dt>
                <dd>{formatDebugValue(row.value, t("settings.debug.empty"))}</dd>
              </div>
            ))}
          </dl>
          <label className="settings-debug-field">
            <span>{t("settings.debug.device.json")}</span>
            <textarea value={identityJson} readOnly spellCheck={false} />
          </label>
        </div>
      ) : null}
    </div>
  );
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
  const [pending, setPending] = useState<"snapshot" | "localDebug" | null>(null);
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

  async function handleProbe(target: "localDebug") {
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
      </div>
      <div className="settings-debug-probe-targets">
        <code>{DESKTOP_WS_URL}</code>
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

function DebugSettingsPanel() {
  const { t } = useI18n();
  const [activeCategoryId, setActiveCategoryId] = useState<DebugCategoryId>("device");

  function renderActiveCategory() {
    switch (activeCategoryId) {
      case "device":
        return <DeviceIdentityDebugCard />;
      case "logs":
        return <DesktopLogsDebugCard />;
      case "wsServer":
        return <LocalWsServerDebugCard />;
      case "authTokens":
        return <IdentityTokenDebugCard />;
      case "other":
        return (
          <div className="settings-about-stack">
            <DesktopActionDebugCard />
            <TunnelDebugCard />
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="settings-debug-layout">
      <nav className="settings-debug-nav" aria-label={t("settings.debug.categories.label")}>
        {DEBUG_CATEGORY_IDS.map((categoryId) => {
          const selected = categoryId === activeCategoryId;
          return (
            <button
              key={categoryId}
              type="button"
              className={`settings-debug-nav-item${selected ? " is-selected" : ""}`}
              aria-current={selected ? "page" : undefined}
              onClick={() => setActiveCategoryId(categoryId)}
            >
              {getDebugCategoryLabel(categoryId, t)}
            </button>
          );
        })}
      </nav>
      <div className="settings-debug-content">
        {renderActiveCategory()}
      </div>
    </div>
  );
}

function LocalWsServerDebugCard() {
  const { t } = useI18n();
  const [desktopWsServerState, setDesktopWsServerState] = useState<DesktopWsServerState | null>(null);
  const [desktopWsServerPending, setDesktopWsServerPending] = useState<"open" | "close" | null>(null);
  const [wsConsoleOpen, setWsConsoleOpen] = useState(false);

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
          <Button onClick={() => setWsConsoleOpen(true)}>
            {t("settings.debug.desktopWs.consoleAction")}
          </Button>
        </div>
      </div>
      {desktopWsServerState?.message ? (
        <div className="feedback-banner warning-banner settings-desktop-ws-message" role="status">
          {desktopWsServerState.message}
        </div>
      ) : null}
      <WsServerDebugDialog
        open={wsConsoleOpen}
        url={desktopWsServerUrl}
        onClose={() => setWsConsoleOpen(false)}
      />
    </div>
  );
}

function AboutAppCard({
  isWindows,
  runtimeResetPending,
  runtimeResetResult,
  onResetRuntimeEnv
}: AboutAppCardProps) {
  const { t } = useI18n();
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [deviceIdentity, setDeviceIdentity] = useState<DesktopDeviceIdentityInfo | null>(null);

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
    window.electronAPI.settings
      .getDeviceIdentity()
      .then((nextDeviceIdentity) => {
        if (!cancelled) {
          setDeviceIdentity(nextDeviceIdentity);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeviceIdentity({
            identityPath: "",
            version: 0,
            installId: "",
            deviceId: "",
            machineHash: "",
            machineSource: "unavailable",
            createdAt: "",
            updatedAt: ""
          });
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
  const deviceId = useMemo(() => {
    if (deviceIdentity === null) {
      return t("common.loading");
    }
    if (!deviceIdentity.deviceId) {
      return t("common.error");
    }
    return deviceIdentity.deviceId;
  }, [deviceIdentity, t]);

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
        <div className="settings-item-row settings-about-row">
          <div className="settings-about-copy">
            <strong>{t("settings.about.deviceId")}</strong>
            <span>{t("settings.about.deviceIdDescription")}</span>
          </div>
          <div className="settings-about-version settings-about-device-id" aria-live="polite">
            {deviceId}
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
      {isWindows && <WindowsDataRootCard />}
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
  const [usageProfile, setUsageProfile] = useState<DesktopUsageProfileResult | null>(null);
  const [usageSsoStatus, setUsageSsoStatus] = useState<DesktopSsoStatus | null>(null);
  const [usageProfileLoading, setUsageProfileLoading] = useState(false);
  const [usageHeatmapMode, setUsageHeatmapMode] = useState<UsageHeatmapMode>("day");
  const [generalSettings, setGeneralSettings] = useState<DesktopGeneralSettings>(defaultGeneralSettings);
  const [generalDeviceNameDraft, setGeneralDeviceNameDraft] = useState(defaultGeneralSettings.deviceName);
  const [desktopDeviceInfo, setDesktopDeviceInfo] = useState<DesktopDeviceInfo | null>(null);
  const [desktopDeviceInfoLoading, setDesktopDeviceInfoLoading] = useState(false);
  const [generalSettingsSaving, setGeneralSettingsSaving] = useState(false);
  const [websiteLabel, setWebsiteLabel] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [editingWebsiteId, setEditingWebsiteId] = useState("");
  const [websitePending, setWebsitePending] = useState(false);
  const [websiteTransferPending, setWebsiteTransferPending] = useState("");
  const [websiteAgentPendingId, setWebsiteAgentPendingId] = useState("");
  const [deletingWebsiteId, setDeletingWebsiteId] = useState("");
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
  const [controlCloudConfig, setControlCloudConfig] = useState<KanbanCloudConfig>(defaultKanbanCloudConfig);
  const [controlCloudProjects, setControlCloudProjects] = useState<KanbanProject[]>([]);
  const [controlConnectionState, setControlConnectionState] = useState<KanbanConnectionState>("disabled");
  const [controlConfigSaving, setControlConfigSaving] = useState(false);
  const [tunnelHubSettings, setTunnelHubSettings] = useState<TunnelHubSettings>(defaultTunnelHubSettings);
  const [tunnelHubSsoStatus, setTunnelHubSsoStatus] = useState<DesktopSsoStatus | null>(null);
  const [tunnelHubSaving, setTunnelHubSaving] = useState(false);
  const [appPairingPending, setAppPairingPending] = useState(false);
  const [appPairingTargetMode, setAppPairingTargetMode] = useState<PairingTargetMode>("local");
  const [appPairingResult, setAppPairingResult] = useState<DesktopAppPairingPayloadResult | null>(null);
  const [runtimeResetPending, setRuntimeResetPending] = useState(false);
  const [runtimeResetResult, setRuntimeResetResult] = useState<DesktopRuntimeEnvResetResult | null>(null);
  const desktopPetSupported = isMac || isWindows;
  const contentRef = useRef<HTMLDivElement>(null);
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
  const shouldReadUsageProfile = activeSection === "usage";
  const shouldReadGeneralSettings = activeSection === "general";
  const shouldReadControlData = activeSection === "kanban";
  const shouldReadTunnelHubData = activeSection === "tunnelHub";
  const shouldReadMarketSettings = activeSection === "market";
  const shouldReadAssistantSettings = Boolean(
    activeSection && ASSISTANT_SETTINGS_SECTION_IDS.includes(activeSection)
  );
  const shouldReadDesktopPetState = desktopPetSupported && activeSection === "assistant";
  const controlProjectOptions = useMemo(
    () => sortKanbanProjectOptions(controlCloudProjects),
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
          label: t("kanban.cloud.currentProject", { id: selectedControlProjectId })
        }]
      : []),
    ...controlProjectOptions.map((project) => ({
      value: project.id,
      label: getKanbanProjectOptionLabel(project)
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

  async function refreshUsageProfile() {
    setUsageProfileLoading(true);
    const [profileResult, ssoResult] = await Promise.allSettled([
      window.electronAPI.settings.getUsageProfile(),
      window.electronAPI.sso.getStatus()
    ]);

    if (profileResult.status === "fulfilled") {
      setUsageProfile(profileResult.value);
      setReadErrorSections(["usage"], "");
    } else {
      setReadErrorSections(
        ["usage"],
        profileResult.reason instanceof Error ? profileResult.reason.message : String(profileResult.reason)
      );
    }

    if (ssoResult.status === "fulfilled") {
      setUsageSsoStatus(ssoResult.value);
    }
    setUsageProfileLoading(false);
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
    if (!shouldReadUsageProfile) {
      return;
    }
    void refreshUsageProfile();
  }, [shouldReadUsageProfile]);

  useEffect(() => {
    if (!shouldReadGeneralSettings) {
      return;
    }

    let cancelled = false;
    setDesktopDeviceInfoLoading(true);
    Promise.all([
      window.electronAPI.settings.getGeneralSettings(),
      window.electronAPI.settings.getDesktopDeviceInfo()
    ])
      .then(([settings, deviceInfo]) => {
        if (cancelled) {
          return;
        }
        const nextSettings = {
          ...defaultGeneralSettings,
          ...settings
        };
        setGeneralSettings(nextSettings);
        setGeneralDeviceNameDraft(nextSettings.deviceName);
        setDesktopDeviceInfo(deviceInfo);
        setReadErrorSections(["general"], "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["general"], reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDesktopDeviceInfoLoading(false);
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
        const [settingsResult, issueResult] = await Promise.all([
          window.electronAPI.kanban.getSettings(),
          window.electronAPI.kanban.listIssues()
        ]);
        if (cancelled) {
          return;
        }
        setControlCloudConfig({
          ...defaultKanbanCloudConfig,
          ...settingsResult.settings.cloud
        });
        setControlCloudProjects(issueResult.projects ?? []);
        setControlConnectionState(settingsResult.connectionState ?? issueResult.connectionState ?? "disabled");
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
    Promise.allSettled([
      window.electronAPI.settings.getTunnelHubSettings(),
      window.electronAPI.sso.getStatus()
    ])
      .then(([settingsResult, ssoResult]) => {
        if (cancelled) {
          return;
        }
        if (settingsResult.status !== "fulfilled") {
          throw settingsResult.reason;
        }
        const settings = settingsResult.value;
        setTunnelHubSettings({
          ...defaultTunnelHubSettings,
          ...settings
        });
        setTunnelHubSsoStatus(ssoResult.status === "fulfilled" ? ssoResult.value : null);
        setReadErrorSections(["control"], "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setReadErrorSections(["control"], reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldReadTunnelHubData]);


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
    t
  ]);

async function handleSaveGeneralDeviceName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const previousSettings = generalSettings;
    const nextSettings = {
      ...generalSettings,
      deviceName: generalDeviceNameDraft.trim()
    };
    setGeneralSettings(nextSettings);
    setGeneralSettingsSaving(true);
    setDesktopDeviceInfoLoading(true);
    try {
      const savedSettings = await window.electronAPI.settings.saveGeneralSettings(nextSettings);
      setGeneralSettings({
        ...defaultGeneralSettings,
        ...savedSettings
      });
      setGeneralDeviceNameDraft(savedSettings.deviceName);
      setDesktopDeviceInfo(await window.electronAPI.settings.getDesktopDeviceInfo());
      setReadErrorSections(["general"], "");
      showSectionNotice(
        "general",
        savedSettings.deviceName
          ? t("settings.general.noticeDeviceNameSaved", { name: savedSettings.deviceName })
          : t("settings.general.noticeDeviceNameAuto"),
        "success"
      );
    } catch (reason) {
      setGeneralSettings(previousSettings);
      showSectionNotice("general", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setGeneralSettingsSaving(false);
      setDesktopDeviceInfoLoading(false);
    }
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

  async function handleToggleDesktopActionConfirmation() {
    const previousSettings = generalSettings;
    const nextSettings = {
      ...generalSettings,
      desktopActionConfirmationEnabled: !generalSettings.desktopActionConfirmationEnabled
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
        savedSettings.desktopActionConfirmationEnabled
          ? t("settings.general.noticeDesktopActionConfirmationEnabled")
          : t("settings.general.noticeDesktopActionConfirmationDisabled"),
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
      showSectionResultNotice("websites", result);
      onWebsiteItemsChange(result.items);
      if (result.ok) {
        setWebsiteLabel("");
        setWebsiteUrl("");
      }
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
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
    setNotice((current) => current?.sectionId === "websites" ? null : current);
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
      showSectionResultNotice("websites", result);
      onWebsiteItemsChange(result.items);
      if (result.ok) {
        resetWebsiteForm();
      }
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsitePending(false);
    }
  }

  async function handleDeleteWebsiteItem(item: WebsiteEntry) {
    setDeletingWebsiteId(item.id);
    try {
      const result = await window.electronAPI.webs.websites.remove(item.id);
      showSectionResultNotice("websites", result);
      onWebsiteItemsChange(result.items);
      if (editingWebsiteId === item.id) {
        resetWebsiteForm();
      }
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setDeletingWebsiteId("");
    }
  }

  async function handleUpdateWebsiteAgent(itemId: string, agentKey: string) {
    setWebsiteAgentPendingId(itemId);
    try {
      const result = await window.electronAPI.webs.websites.update(itemId, { agentKey });
      showSectionResultNotice("websites", result);
      onWebsiteItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteAgentPendingId("");
    }
  }

  async function handleImportWebsiteItems() {
    setWebsiteTransferPending("import");
    try {
      const result = await window.electronAPI.webs.websites.import();
      showSectionResultNotice("websites", result);
      onWebsiteItemsChange(result.items);
      resetWebsiteForm();
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteTransferPending("");
    }
  }

  async function handleExportWebsiteItems() {
    setWebsiteTransferPending("export");
    try {
      const result = await window.electronAPI.webs.websites.export();
      showSectionNotice(
        "websites",
        result.path ? `${result.message} ${result.path}` : result.message,
        result.ok ? "success" : "error"
      );
      onWebsiteItemsChange(result.items);
    } catch (reason) {
      showSectionNotice("websites", reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setWebsiteTransferPending("");
    }
  }

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

  function getControlConnectionLabel(state: KanbanConnectionState) {
    switch (state) {
      case "connecting":
        return t("kanban.cloud.status.connecting");
      case "open":
        return t("kanban.cloud.status.open");
      case "closed":
        return t("kanban.cloud.status.closed");
      case "error":
        return t("kanban.cloud.status.error");
      default:
        return t("kanban.cloud.status.disabled");
    }
  }

  async function saveControlCloudConfig(nextConfig: KanbanCloudConfig) {
    setControlConfigSaving(true);
    try {
      const result = await window.electronAPI.kanban.saveSettings({
        enabled: true,
        cloud: nextConfig
      });
      if (!result.ok) {
        throw new Error(result.message || t("settings.kanban.saveFailed"));
      }
      setControlCloudConfig({
        ...defaultKanbanCloudConfig,
        ...result.settings.cloud
      });
      setControlConnectionState(result.connectionState ?? "disabled");
      const issueResult = await window.electronAPI.kanban.listIssues();
      setControlCloudProjects(issueResult.projects ?? []);
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
        deviceId: tunnelHubSettings.deviceId
      });
      setTunnelHubSettings({
        ...defaultTunnelHubSettings,
        ...result.settings
      });
      if (result.settings.webSocketUrl !== tunnelHubSettings.webSocketUrl) {
        setAppPairingResult(null);
      }
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
        deviceId: tunnelHubSettings.deviceId
      });
      setTunnelHubSettings({
        ...defaultTunnelHubSettings,
        ...result.settings
      });
      if (result.settings.webSocketUrl !== tunnelHubSettings.webSocketUrl) {
        setAppPairingResult(null);
      }
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
      const result = await window.electronAPI.settings.createAppPairingPayload({
        targetMode: appPairingTargetMode
      });
      setAppPairingResult(result);
      if (!result.ok) {
        showSectionNotice("tunnelHub", result.message || t("settings.mobilePairing.failed"), "error");
        return;
      }
      setReadErrorSections(["tunnelHub"], "");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setAppPairingResult({ ok: false, message });
      showSectionNotice("tunnelHub", message, "error");
    } finally {
      setAppPairingPending(false);
    }
  }

  function handleAppPairingTargetModeChange(value: PairingTargetMode) {
    setAppPairingTargetMode(value);
    setAppPairingResult(null);
  }

  async function handleCopyAppPairingPayload() {
    if (!appPairingResult?.ok) {
      return;
    }
    const result = await window.electronAPI.clipboard.writeText(appPairingResult.payloadText);
    if (!result.ok) {
      showSectionNotice("tunnelHub", result.message || t("settings.mobilePairing.copyFailed"), "error");
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
  const settingsContentStyle = activeSectionDefinition?.layout === "wide"
    ? ({ "--settings-content-max": "var(--workspace-wide-max)" } as CSSProperties)
    : undefined;
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
      default:
        return null;
    }
  }

  function renderActiveSection() {
    switch (activeSection) {
      case "usage":
        return (
          <UsageSettingsPanel
            profile={usageProfile}
            ssoStatus={usageSsoStatus}
            loading={usageProfileLoading}
            heatmapMode={usageHeatmapMode}
            onHeatmapModeChange={setUsageHeatmapMode}
            onRefresh={refreshUsageProfile}
          />
        );
      case "general": {
        const deviceInfoRows: Array<{ label: TranslationKey; value: unknown }> = [
          { label: "settings.general.desktopDeviceId", value: desktopDeviceInfo?.deviceId }
        ];
        return (
          <div className="settings-appearance-panel" aria-label={t("settings.general.panelAria")}>
            <div className="settings-appearance-row">
              <div className="settings-appearance-row-copy">
                <strong>{t("settings.general.desktopInfoTitle")}</strong>
              </div>
            </div>
            <form className="settings-control-form settings-device-form" onSubmit={(event) => void handleSaveGeneralDeviceName(event)}>
              <div className="settings-device-name-row">
                <label className="settings-control-field">
                  <span>{t("settings.general.desktopDeviceName")}</span>
                  <Input
                    value={generalDeviceNameDraft}
                    onChange={(event) => setGeneralDeviceNameDraft(event.target.value)}
                    placeholder={desktopDeviceInfo?.deviceName || t("settings.general.deviceNameFallback")}
                    disabled={generalSettingsSaving}
                  />
                </label>
                <Button type="primary" htmlType="submit" disabled={generalSettingsSaving} loading={generalSettingsSaving}>
                  {generalSettingsSaving ? t("settings.general.savingDeviceName") : t("settings.general.saveDeviceName")}
                </Button>
              </div>
              <dl className="settings-device-info-list" aria-label={t("settings.general.desktopInfoReadonly")}>
                {deviceInfoRows.map((row) => (
                  <div key={row.label}>
                    <dt>{t(row.label)}</dt>
                    <dd>{formatDebugValue(row.value, desktopDeviceInfoLoading ? t("common.loading") : t("settings.debug.empty"))}</dd>
                  </div>
                ))}
              </dl>
            </form>
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
            <div className="settings-appearance-row">
              <div className="settings-appearance-row-copy">
                <strong>{t("settings.general.desktopActionConfirmation")}</strong>
                <span>{t("settings.general.desktopActionConfirmationDescription")}</span>
              </div>
              <Switch
                checked={generalSettings.desktopActionConfirmationEnabled}
                aria-label={t("settings.general.desktopActionConfirmation")}
                disabled={generalSettingsSaving}
                onChange={() => void handleToggleDesktopActionConfirmation()}
              />
            </div>
          </div>
        );
      }
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
                  classNames={SETTINGS_SELECT_CLASS_NAMES}
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
                      classNames={SETTINGS_SELECT_CLASS_NAMES}
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
            </div>
            <Form
              className="settings-control-form settings-kanban-ant-form"
              layout="vertical"
              requiredMark={false}
              onFinish={() => void saveControlCloudConfig(controlCloudConfig)}
            >
              <Form.Item label={t("kanban.cloud.serverUrl")}>
                <Input
                  value={controlCloudConfig.serverUrl}
                  onChange={(event) => setControlCloudConfig((current) => ({ ...current, serverUrl: event.target.value }))}
                  placeholder="http://127.0.0.1:8080"
                />
              </Form.Item>
              <Form.Item
                label={t("kanban.cloud.projectId")}
                extra={controlProjectOptions.length > 0
                  ? t("kanban.cloud.projectSelectHelp", { count: controlProjectOptions.length })
                  : t("kanban.cloud.projectFallbackHelp")}
              >
                {controlProjectOptions.length > 0 ? (
                  <Select
                    classNames={SETTINGS_SELECT_CLASS_NAMES}
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
      case "control":
        return (
          <div className="settings-control-center-embed">
            <ControlCenterPage />
          </div>
        );
      case "tunnelHub": {
        const pairingPayloadResult = appPairingResult?.ok ? appPairingResult : null;
        const pairingErrorMessage = appPairingResult && !appPairingResult.ok ? appPairingResult.message : "";
        return (
          <div className="settings-control-config-stack">
            <div className="settings-item-card settings-control-card" aria-label={t("settings.tunnelHub.panelAria")}>
              <div className="settings-item-header settings-mobile-pairing-header">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.tunnelHub.connectionTitle")}</strong>
                  <span>{t("settings.tunnelHub.description")}</span>
                </div>
                <Switch
                  checked={tunnelHubSettings.enabled}
                  aria-label={t("settings.tunnelHub.label")}
                  disabled={tunnelHubSaving}
                  loading={tunnelHubSaving}
                  onChange={() => void handleToggleTunnelHubEnabled()}
                />
              </div>
              <form className="settings-control-form" onSubmit={(event) => void handleSaveTunnelHubSettings(event)}>
                <label className="settings-control-field">
                  <span>{t("settings.tunnelHub.relayUrl")}</span>
                  <Input
                    value={tunnelHubSettings.relayUrl}
                    onChange={(event) => setTunnelHubSettings((current) => ({ ...current, relayUrl: event.target.value }))}
                    placeholder={t("settings.tunnelHub.relayUrlPlaceholder")}
                  />
                </label>
                {tunnelHubSsoStatus && !tunnelHubSsoStatus.authenticated ? (
                  <div className="settings-control-field settings-readonly-stack">
                    <small>{t("settings.tunnelHub.loginRequired")}</small>
                  </div>
                ) : null}
                {tunnelHubSettings.publicHost ? (
                  <div className="settings-control-field settings-readonly-stack">
                    <small>{t("settings.tunnelHub.publicHost")}: <code>{tunnelHubSettings.publicHost}</code></small>
                  </div>
                ) : null}
                <div className="settings-control-actions">
                  <Button type="primary" htmlType="submit" disabled={tunnelHubSaving} loading={tunnelHubSaving}>
                    {tunnelHubSaving ? t("settings.tunnelHub.saving") : t("settings.tunnelHub.save")}
                  </Button>
                </div>
              </form>
            </div>
            <div className="settings-item-card settings-mobile-pairing-card">
              <div className="settings-item-header settings-mobile-pairing-header">
                <div className="settings-appearance-row-copy">
                  <strong>{t("settings.mobilePairing.title")}</strong>
                  <span>{t("settings.mobilePairing.description")}</span>
                </div>
                <div className="settings-mobile-pairing-actions">
                  <Segmented<PairingTargetMode>
                    aria-label={t("settings.mobilePairing.targetMode")}
                    value={appPairingTargetMode}
                    disabled={appPairingPending}
                    onChange={handleAppPairingTargetModeChange}
                    options={APP_PAIRING_TARGET_MODES.map((targetMode) => ({
                      value: targetMode,
                      label: getPairingTargetModeLabel(targetMode, t)
                    }))}
                  />
                  <Button
                    type="primary"
                    disabled={appPairingPending}
                    loading={appPairingPending}
                    onClick={() => void handleCreateAppPairingPayload()}
                  >
                    {appPairingPending ? t("settings.mobilePairing.generating") : t("settings.mobilePairing.action")}
                  </Button>
                </div>
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
                      <span>{t("settings.mobilePairing.targetMode")}</span>
                      <code>{getPairingTargetModeLabel(pairingPayloadResult.display.targetMode, t)}</code>
                    </div>
                    <div className="settings-mobile-pairing-meta">
                      <span>{t("settings.mobilePairing.wsUrl")}</span>
                      <code>{pairingPayloadResult.display.wsUrl}</code>
                    </div>
                    <div className="settings-mobile-pairing-meta">
                      <span>{t("settings.mobilePairing.expiresAt")}</span>
                      <code>{formatPairingExpiresAt(pairingPayloadResult.display.expiresAt, locale)}</code>
                    </div>
                    <div className="settings-mobile-pairing-meta settings-mobile-pairing-payload">
                      <span>{t("settings.mobilePairing.payload")}</span>
                      <code>{maskPairingPayloadText(pairingPayloadResult.payloadText)}</code>
                    </div>
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
          </div>
        );
      }
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
                    classNames={SETTINGS_SELECT_CLASS_NAMES}
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
                    classNames={SETTINGS_SELECT_CLASS_NAMES}
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
                              classNames={SETTINGS_SELECT_CLASS_NAMES}
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

      case "websites":
        return (
          <div className="settings-item-card website-card">
            {!editingWebsiteId ? (
              <>
                <div className="settings-item-section-head website-list-head website-add-head">
                  <div>
                    <strong>{t("settings.websites.addTitle")}</strong>
                    <span>{t("settings.websites.addDescription")}</span>
                  </div>
                </div>
                <div className="settings-item-form website-add-form">
                  <form className="website-form" onSubmit={(event) => void handleAddWebsiteItem(event)}>
                    <label>
                      <span>{t("settings.websites.displayName")}</span>
                      <Input
                        value={websiteLabel}
                        onChange={(event) => setWebsiteLabel(event.target.value)}
                        placeholder={t("settings.websites.displayNamePlaceholder")}
                        maxLength={24}
                      />
                    </label>
                    <label>
                      <span>{t("settings.websites.url")}</span>
                      <Input
                        value={websiteUrl}
                        onChange={(event) => setWebsiteUrl(event.target.value)}
                        placeholder={t("settings.websites.urlPlaceholder")}
                        required
                      />
                    </label>
                    <div className="website-submit-wrap">
                      <Button type="link" htmlType="submit" className="website-submit" disabled={websitePending} loading={websitePending}>
                        {websitePending ? t("settings.websites.adding") : t("settings.websites.add")}
                      </Button>
                    </div>
                  </form>
                </div>
              </>
            ) : null}

            <div className="settings-item-section-head website-list-head website-added-head">
              <div>
                <strong>{t("settings.websites.addedTitle")}</strong>
                <span>{t("settings.websites.addedDescription")}</span>
              </div>
              <div className="settings-item-section-actions">
                <Button
                  type="link"
                  onClick={() => void handleImportWebsiteItems()}
                  disabled={websiteTransferPending !== "" || Boolean(editingWebsiteId)}
                >
                  {websiteTransferPending === "import" ? t("settings.websites.importing") : t("settings.websites.import")}
                </Button>
                <Button
                  type="link"
                  onClick={() => void handleExportWebsiteItems()}
                  disabled={websiteTransferPending !== "" || Boolean(editingWebsiteId)}
                >
                  {websiteTransferPending === "export" ? t("settings.websites.exporting") : t("settings.websites.export")}
                </Button>
              </div>
            </div>
            {websiteItems.length === 0 ? (
              <div className="settings-item-empty website-empty">{t("settings.websites.empty")}</div>
            ) : (
              <div className="settings-item-list website-list" role="list" aria-label={t("settings.websites.addedTitle")}>
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
                            <span>{t("settings.websites.displayName")}</span>
                            <Input
                              value={websiteLabel}
                              onChange={(event) => setWebsiteLabel(event.target.value)}
                              placeholder={t("settings.websites.displayNamePlaceholder")}
                              maxLength={24}
                              required
                            />
                          </label>
                          <label>
                            <span>{t("settings.websites.url")}</span>
                            <Input
                              value={websiteUrl}
                              onChange={(event) => setWebsiteUrl(event.target.value)}
                              placeholder={t("settings.websites.urlPlaceholder")}
                              required
                            />
                          </label>
                          <div className="website-row-actions">
                            <Button type="link" htmlType="submit" disabled={websitePending} loading={websitePending}>
                              {websitePending ? t("settings.websites.updating") : t("settings.websites.save")}
                            </Button>
                            <Button
                              type="link"
                              onClick={handleCancelEditWebsiteItem}
                              disabled={websitePending}
                            >
                              {t("settings.websites.cancel")}
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
                                classNames={SETTINGS_SELECT_CLASS_NAMES}
                                style={{ width: "100%" }}
                                value={itemAgentKey}
                                onChange={(value) => void handleUpdateWebsiteAgent(item.id, value)}
                                disabled={assistantAgentOptions.length === 0 || itemAgentPending || Boolean(editingWebsiteId)}
                                aria-label={t("settings.websites.linkedAgentFor", { label: item.label })}
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
                              {t("settings.websites.edit")}
                            </Button>
                            <Button
                              type="link"
                              danger
                              onClick={() => void handleDeleteWebsiteItem(item)}
                              disabled={deletingWebsiteId === item.id || Boolean(editingWebsiteId)}
                            >
                              {deletingWebsiteId === item.id ? t("settings.websites.deleting") : t("settings.websites.delete")}
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
      case "about":
        return (
          <AboutAppCard
            isWindows={isWindows}
            runtimeResetPending={runtimeResetPending}
            runtimeResetResult={runtimeResetResult}
            onResetRuntimeEnv={handleResetRuntimeEnv}
          />
        );
      case "debug":
        return (
          <DebugSettingsPanel />
        );
      default:
        return null;
    }
  }

  const shouldShowSettingsPageHead = activeSection !== "control";

  return (
    <section
      className="settings-page settings-page-single"
      data-settings-section={activeSectionDefinition?.id ?? ""}
      data-settings-layout={activeSectionDefinition?.layout ?? "measure"}
    >
      <div className="settings-content-panel" ref={contentRef} style={settingsContentStyle}>
        <div className="settings-content-shell">
          {shouldShowSettingsPageHead ? (
            <div className="settings-page-head">
              <div className="settings-page-head-copy">
                <h1>{activeSectionDefinition?.label ?? t("settings.title")}</h1>
                <p className="page-copy">{activeSectionDefinition?.description ?? t("settings.description")}</p>
              </div>
              <div className="settings-page-head-action">
                {renderSectionHeaderAction()}
              </div>
            </div>
          ) : null}

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
