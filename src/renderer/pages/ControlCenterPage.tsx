import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ServiceConfigFile,
  ServiceConfigReadResult,
  ServiceId,
  ServiceLogTarget,
  ServiceState,
} from "@shared/contracts";
import { useServices } from "../services/ServicesContext";
import { useLocation, useNavigate } from "react-router-dom";
import { AGENT_WEBCLIENT_DISPLAY_NAME, getServiceDisplayName } from "../service-display";
import { PageFeedbackStack } from "../components/PageFeedbackStack";

const CORE_MODULES = [
  {
    id: "zenmind-app-server",
    name: "认证服务",
    description:
      "认证与管理服务，提供 OAuth2/OIDC、管理后台、App 访问令牌和设备管理。",
  },
  {
    id: "agent-platform",
    name: "智能体平台",
    description: "AI Agent 运行时，提供对话、工具执行和沙箱能力。",
  },
  {
    id: "agent-webclient",
    name: AGENT_WEBCLIENT_DISPLAY_NAME,
    description:
      "独立进程模式的 AGENT Web 客户端，负责静态资源托管并代理 API 请求。",
  },
  {
    id: "agent-container-hub",
    name: "容器仓库",
    description: "宿主机容器服务，负责为后续智能体运行时提供沙箱能力。",
  },
] as const;

const QUICK_START_ORDER = [
  "zenmind-app-server",
  "agent-platform",
  "agent-webclient",
] as const;
const FEEDBACK_AUTO_CLOSE_MS = 3200;

function statusClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "config-required":
    case "initialization-required":
      return "warning";
    case "dependency-missing":
      return "warning";
    case "error":
    case "stopped":
      return "danger";
    case "not-installed":
      return "idle";
    default:
      return "muted";
  }
}

function statusDotClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "error":
      return "danger";
    case "config-required":
    case "initialization-required":
    case "dependency-missing":
      return "warning";
    case "stopped":
      return "danger";
    case "not-installed":
    default:
      return "idle";
  }
}

type ActionScope = "lifecycle" | "detail";
type ConfigMeta = Pick<ServiceConfigReadResult, "path" | "exists" | "source">;
type ConfigCache = Record<ServiceId, Record<string, string>>;
type ConfigMetaCache = Record<ServiceId, Record<string, ConfigMeta>>;
type ServiceGroupKey = "core" | "market";
type HelpTipState = {
  serviceId: ServiceId;
  label: string;
  description: string;
  top: number;
  left: number;
};
type CoreModuleEntry = (typeof CORE_MODULES)[number] & {
  service: ServiceState | null;
};
type MetaItem = {
  key: string;
  label: string;
  value: string;
  title?: string;
  actions?: Array<{
    label: string;
    icon: "article" | "folder";
    disabled?: boolean;
    onAction: () => void;
  }>;
};

function shouldShowInitializeAction(service: ServiceState) {
  return (
    service.status === "initialization-required" ||
    service.message.startsWith("初始化失败")
  );
}

function getErrorLogDisplay(service: ServiceState) {
  if (service.healthMeta.errorLogFilePath) {
    return service.healthMeta.errorLogFilePath;
  }
  if (service.healthMeta.logFilePath) {
    return "无独立错误日志，stderr 已并入日志文件";
  }
  return "未声明";
}

function getConfigSourceLabel(
  configFile: ServiceConfigFile,
  meta?: ConfigMeta,
) {
  if (meta?.source === "file") {
    return "已创建";
  }
  if (meta?.source === "template") {
    return "来自模板";
  }
  if (meta?.source === "missing") {
    return "未创建";
  }
  if (configFile.exists) {
    return "已创建";
  }
  return "未读取";
}

function getConfigSourceClass(
  configFile: ServiceConfigFile,
  meta?: ConfigMeta,
) {
  if (meta?.source === "file") {
    return "is-file";
  }
  if (meta?.source === "template") {
    return "is-template";
  }
  if (meta?.source === "missing") {
    return "is-missing";
  }
  if (configFile.exists) {
    return "is-file";
  }
  return "is-pending";
}

function getParentDirectory(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return "";
  }

  const lastSeparatorIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\"),
  );
  if (lastSeparatorIndex < 0) {
    return "";
  }
  if (lastSeparatorIndex === 0) {
    return normalizedPath.slice(0, 1);
  }
  if (lastSeparatorIndex === 2 && normalizedPath[1] === ":") {
    return normalizedPath.slice(0, 3);
  }
  return normalizedPath.slice(0, lastSeparatorIndex);
}

function getConfigDirectoryPaths(configFiles: ServiceConfigFile[]) {
  return [
    ...new Set(
      configFiles
        .map((configFile) =>
          getParentDirectory(configFile.absolutePath),
        )
        .filter((directoryPath) => directoryPath.length > 0),
    ),
  ];
}

function getPidDisplay(service: ServiceState) {
  if (service.healthMeta.pid) {
    return String(service.healthMeta.pid);
  }
  if (service.healthMeta.pidFilePath) {
    return `PID 文件：${service.healthMeta.pidFilePath}`;
  }
  return "未声明";
}

function StartServiceIcon() {
  return (
    <svg
      className="service-action-icon service-action-icon-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7.25 4.75v14.5L18.75 12 7.25 4.75Z" />
    </svg>
  );
}

function StopServiceIcon() {
  return (
    <svg
      className="service-action-icon service-action-icon-stop"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.75 6.75h10.5v10.5H6.75z" />
    </svg>
  );
}

function ReinstallServiceIcon() {
  return (
    <svg
      className="service-action-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 8.5 12 5l6 3.5-6 3.5-6-3.5Z" />
      <path d="M6 8.5v7L12 19l6-3.5v-7" />
      <path d="M12 12v7" />
      <path d="M17 4.5h3v3" />
      <path d="M20 4.5 16.5 8" />
    </svg>
  );
}

function RestartServiceIcon() {
  return (
    <svg
      className="service-action-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 12a8 8 0 0 1-13.6 5.7" />
      <path d="M4 12A8 8 0 0 1 17.6 6.3" />
      <path d="M17 3.5v4h4" />
      <path d="M7 20.5v-4H3" />
    </svg>
  );
}

function InstallServiceIcon() {
  return (
    <svg
      className="service-action-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4v9" />
      <path d="m8.5 9.5 3.5 3.5 3.5-3.5" />
      <path d="M5.5 15.5v2.25A2.25 2.25 0 0 0 7.75 20h8.5a2.25 2.25 0 0 0 2.25-2.25V15.5" />
    </svg>
  );
}

function UninstallServiceIcon() {
  return (
    <svg
      className="service-action-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 5h6" />
      <path d="M5.5 8h13" />
      <path d="M8 8l.6 10.2A2 2 0 0 0 10.6 20h2.8a2 2 0 0 0 2-1.8L16 8" />
      <path d="M10.5 11v5" />
      <path d="M13.5 11v5" />
    </svg>
  );
}

function OpenFrontendIcon() {
  return (
    <svg
      className="service-action-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
      <path d="M14 4h6v6" />
      <path d="m11 13 8.5-8.5" />
    </svg>
  );
}

function ServiceHelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 17.25h.01" />
      <path d="M9.6 9.25A2.65 2.65 0 0 1 12.15 7c1.55 0 2.75.98 2.75 2.35 0 1.05-.58 1.7-1.72 2.42-.88.55-1.2.98-1.2 1.88v.35" />
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
    </svg>
  );
}

function ServiceInfoIcon() {
  return (
    <svg
      className="service-action-icon service-action-icon-info"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="6.75" r="2.15" />
      <path d="M10.55 10.05h2.9v9.2h-2.9z" />
    </svg>
  );
}

function LogArticleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.25 4.75h11.5a1.5 1.5 0 0 1 1.5 1.5v11.5a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5V6.25a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M8.25 8.25h7.5" />
      <path d="M8.25 12h7.5" />
      <path d="M8.25 15.75h5.25" />
    </svg>
  );
}

function LogFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.75 7.25a1.5 1.5 0 0 1 1.5-1.5h4.35l2.15 2.15h5a1.5 1.5 0 0 1 1.5 1.5v8.35a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5V7.25Z" />
    </svg>
  );
}

function ConfigTerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7.25 4.25h6.15l3.35 3.35v10.65a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5V5.75a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M13.25 4.5v3.35h3.35" />
      <path d="m10 11.25-1.75 1.75L10 14.75" />
      <path d="m14 11.25 1.75 1.75L14 14.75" />
      <path d="m12.8 10.75-1.6 4.5" />
    </svg>
  );
}

function SelectChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7 9.5 5 5 5-5" />
    </svg>
  );
}

export function ControlCenterPage() {
  const {
    services,
    loading,
    error,
    installBuiltinFromBundle,
    installBuiltin,
    initialize,
    start,
    stop,
    restart,
    readConfig,
    writeConfig,
    refresh,
    installPlugin,
    uninstallPlugin,
  } = useServices();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeId, setActiveId] = useState<ServiceId | null>(null);
  const [selectedServiceId, setSelectedServiceId] =
    useState<ServiceId | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    serviceId: ServiceId;
    scope: ActionScope;
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [isBatchStarting, setIsBatchStarting] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<ServiceGroupKey | null>(
    "market",
  );
  const [configCache, setConfigCache] = useState<ConfigCache>({});
  const [configOriginalCache, setConfigOriginalCache] = useState<ConfigCache>(
    {},
  );
  const [configMeta, setConfigMeta] = useState<ConfigMetaCache>({});
  const [activeConfigKeyByService, setActiveConfigKeyByService] = useState<
    Record<ServiceId, string>
  >({});
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [helpTip, setHelpTip] = useState<HelpTipState | null>(null);
  const [configFileSelectOpen, setConfigFileSelectOpen] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);

  const serviceById = useMemo(
    () => new Map(services.map((service) => [service.id, service])),
    [services],
  );
  const coreModules = useMemo<CoreModuleEntry[]>(
    () =>
      CORE_MODULES.map((module) => ({
        ...module,
        service: serviceById.get(module.id) ?? null,
      })),
    [serviceById],
  );
  const coreServices = useMemo(
    () =>
      coreModules
        .map((module) => module.service)
        .filter((service): service is ServiceState => Boolean(service)),
    [coreModules],
  );
  const marketServices = useMemo(
    () => services.filter((service) => service.kind === "plugin"),
    [services],
  );
  const navigationState = location.state as {
    startupFailure?: {
      serviceId: ServiceId | null;
      message: string;
    };
    selectedServiceId?: ServiceId;
  } | null;
  const startupFailure = navigationState?.startupFailure;
  const selectedServiceIdFromNavigation = navigationState?.selectedServiceId;

  useEffect(() => {
    const currentGroupIds = [
      ...coreModules.map((module) => module.id),
      ...marketServices.map((service) => service.id),
    ];

    if (currentGroupIds.length === 0) {
      setSelectedServiceId(null);
      return;
    }

    setSelectedServiceId((current) =>
      current && currentGroupIds.includes(current)
        ? current
        : currentGroupIds[0],
    );
  }, [coreModules, marketServices]);

  useEffect(() => {
    if (!startupFailure) {
      return;
    }

    if (startupFailure.serviceId) {
      setSelectedServiceId(startupFailure.serviceId);
    }
    if (startupFailure.message) {
      setFeedback(startupFailure.message);
    }
  }, [startupFailure]);

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFeedback((current) => (current === feedback ? "" : current));
    }, FEEDBACK_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [feedback]);

  useEffect(() => {
    if (!detailDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailDialogOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailDialogOpen]);

  useEffect(() => {
    if (!helpTip) {
      return;
    }

    const closeHelpTip = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-service-help-tip-root]")
      ) {
        return;
      }
      setHelpTip(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHelpTip(null);
      }
    };
    const closeOnViewportChange = () => setHelpTip(null);

    window.addEventListener("pointerdown", closeHelpTip);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeHelpTip);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [helpTip]);

  useEffect(() => {
    if (!configFileSelectOpen) {
      return;
    }

    const closeConfigFileSelect = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-config-file-select-root]")
      ) {
        return;
      }
      setConfigFileSelectOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfigFileSelectOpen(false);
      }
    };

    window.addEventListener("pointerdown", closeConfigFileSelect);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeConfigFileSelect);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [configFileSelectOpen]);

  useEffect(() => {
    if (!selectedServiceIdFromNavigation) {
      return;
    }
    setSelectedServiceId(selectedServiceIdFromNavigation);
  }, [selectedServiceIdFromNavigation]);

  const serviceCounts = {
    total: services.length,
    running: services.filter((service) => service.status === "running")
      .length,
  };
  const selectedCoreModule =
    coreModules.find((module) => module.id === selectedServiceId) ??
    coreModules[0] ??
    null;
  const selectedMarketService =
    marketServices.find((service) => service.id === selectedServiceId) ??
    null;
  const activeDetailService =
    selectedMarketService ?? selectedCoreModule?.service ?? null;
  const activeCoreModule = selectedMarketService ? null : selectedCoreModule;
  const selectedConfigKey = activeDetailService
    ? activeConfigKeyByService[activeDetailService.id]
    : undefined;
  const selectedConfigFile =
    activeDetailService?.configFiles.find(
      (configFile) => configFile.key === selectedConfigKey,
    ) ??
    activeDetailService?.configFiles[0] ??
    null;
  const serviceConfigCache = activeDetailService
    ? (configCache[activeDetailService.id] ?? {})
    : {};
  const serviceConfigOriginalCache = activeDetailService
    ? (configOriginalCache[activeDetailService.id] ?? {})
    : {};
  const serviceConfigMeta = activeDetailService
    ? (configMeta[activeDetailService.id] ?? {})
    : {};
  const selectedConfigMeta = selectedConfigFile
    ? serviceConfigMeta[selectedConfigFile.key]
    : undefined;
  const selectedConfigContent = selectedConfigFile
    ? (serviceConfigCache[selectedConfigFile.key] ?? "")
    : "";
  const selectedConfigOriginalContent = selectedConfigFile
    ? (serviceConfigOriginalCache[selectedConfigFile.key] ?? "")
    : "";
  const selectedConfigDirty = selectedConfigFile
    ? selectedConfigContent !== selectedConfigOriginalContent
    : false;
  const activeDetailServiceId = activeDetailService?.id ?? "";
  const selectedConfigKeyForRead = selectedConfigFile?.key ?? "";
  const selectedConfigMetaLoaded = Boolean(
    activeDetailService &&
    selectedConfigFile &&
    configMeta[activeDetailService.id]?.[selectedConfigFile.key],
  );
  const errorLogDisplay = activeDetailService
    ? getErrorLogDisplay(activeDetailService)
    : "未声明";
  const detailEndpoint = activeDetailService?.healthMeta.webUrl ?? "";
  const configDirectoryPaths = activeDetailService
    ? getConfigDirectoryPaths(activeDetailService.configFiles)
    : [];
  const activeDetailName = activeDetailService
    ? getServiceDisplayName(
      activeDetailService.id,
      activeDetailService.name,
    )
    : "";
  const activeDetailDescription = activeDetailService
    ? activeCoreModule?.description ||
    activeDetailService.description ||
    "基础设施服务"
    : "";

  function selectService(cardId: ServiceId) {
    setSelectedServiceId(cardId);
    setHelpTip(null);
    setConfigFileSelectOpen(false);
  }

  function selectConfigFile(configKey: string) {
    if (!activeDetailService) {
      return;
    }
    setActiveConfigKeyByService((current) => ({
      ...current,
      [activeDetailService.id]: configKey,
    }));
    setConfigFileSelectOpen(false);
  }

  function openServiceHelp(
    cardId: ServiceId,
    label: string,
    description: string,
    anchor: HTMLElement,
  ) {
    const anchorRect = anchor.getBoundingClientRect();
    const pageRect = pageRef.current?.getBoundingClientRect();
    setHelpTip((current) =>
      current?.serviceId === cardId
        ? null
        : {
          serviceId: cardId,
          label,
          description,
          top:
            anchorRect.top -
            (pageRect?.top ?? 0) +
            anchorRect.height / 2,
          left: anchorRect.right - (pageRect?.left ?? 0) + 10,
        },
    );
  }

  function openServiceDetail(cardId: ServiceId) {
    setSelectedServiceId(cardId);
    setHelpTip(null);
    setConfigFileSelectOpen(false);
    setDetailDialogOpen(true);
  }

  function handleServiceCardKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    cardId: ServiceId,
  ) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    selectService(cardId);
  }

  useEffect(() => {
    if (
      !activeDetailServiceId ||
      !selectedConfigKeyForRead ||
      selectedConfigMetaLoaded
    ) {
      return;
    }

    let cancelled = false;
    void readConfig(activeDetailServiceId, selectedConfigKeyForRead)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setConfigCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: result.content,
          },
        }));
        setConfigOriginalCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: result.content,
          },
        }));
        setConfigMeta((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: {
              path: result.path,
              exists: result.exists,
              source: result.source,
            },
          },
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setConfigCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]:
              current[activeDetailServiceId]?.[
              selectedConfigKeyForRead
              ] ?? "",
          },
        }));
        setConfigOriginalCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]:
              current[activeDetailServiceId]?.[
              selectedConfigKeyForRead
              ] ?? "",
          },
        }));
        setConfigMeta((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: {
              path: "",
              exists: false,
              source: "missing",
            },
          },
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeDetailServiceId,
    readConfig,
    selectedConfigKeyForRead,
    selectedConfigMetaLoaded,
  ]);

  async function openLogViewer(
    service: ServiceState,
    target: ServiceLogTarget,
    title: string,
  ) {
    await window.electronAPI.services.openLogViewer({
      serviceId: service.id,
      target,
      title,
    });
  }

  async function revealServicePath(
    targetPath: string,
    targetType: "file" | "directory",
  ) {
    try {
      const result = await window.electronAPI.services.revealPath(
        targetPath,
        { targetType },
      );
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }

  function invalidateConfig(serviceId: ServiceId) {
    setConfigCache((current) => {
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
    setConfigOriginalCache((current) => {
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
    setConfigMeta((current) => {
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
  }

  function toggleGroup(group: ServiceGroupKey) {
    if (group === "core") {
      const nextSelectedCore =
        coreModules.find((module) => module.id === selectedServiceId) ??
        coreModules[0] ??
        null;
      if (nextSelectedCore) {
        setSelectedServiceId(nextSelectedCore.id);
      }
      return;
    }

    setExpandedGroup((current) => {
      const nextExpanded = current === "market" ? null : "market";
      if (nextExpanded === "market") {
        const nextSelectedMarket =
          marketServices.find(
            (service) => service.id === selectedServiceId,
          ) ??
          marketServices[0] ??
          null;
        if (nextSelectedMarket) {
          setSelectedServiceId(nextSelectedMarket.id);
        }
      }
      return nextExpanded;
    });
  }

  async function runAction(
    serviceId: ServiceId,
    scope: ActionScope,
    action: () => Promise<{ ok: boolean; message: string }>,
    options: { invalidateConfig?: boolean } = {},
  ) {
    setActiveId(serviceId);
    if (scope === "lifecycle") {
      setPendingAction({ serviceId, scope });
    }
    try {
      const result = await action();
      setFeedback(result.message);
      if (result.ok && options.invalidateConfig) {
        invalidateConfig(serviceId);
      }
    } catch (reason) {
      setFeedback(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setActiveId((current) => (current === serviceId ? null : current));
      setPendingAction((current) =>
        current?.serviceId === serviceId ? null : current,
      );
      await refresh();
    }
  }

  async function handleInstallPlugin() {
    try {
      const result = await installPlugin();
      setFeedback(result.message);
      if (result.ok && result.serviceId) {
        invalidateConfig(result.serviceId);
        setSelectedServiceId(result.serviceId);
      }
    } catch (reason) {
      setFeedback(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }

  async function handleQuickStart() {
    const orderedServices = QUICK_START_ORDER.map((serviceId) =>
      serviceById.get(serviceId),
    ).filter((service): service is ServiceState => Boolean(service));

    if (orderedServices.length === 0) {
      setFeedback("当前没有可一键启动的服务。容器仓库需要手动启动。");
      return;
    }

    {
      feedback || error ? (
        <PageFeedbackStack
          items={[
            ...(feedback ? [{
              id: "control-center-feedback",
              tone: "success" as const,
              message: feedback
            }] : []),
            ...(error ? [{
              id: "control-center-error",
              tone: "error" as const,
              message: error
            }] : [])
          ]}
        />
      ) : null
    }
    { loading ? <div className="loading-box">正在读取服务状态…</div> : null }

    const startedNames: string[] = [];
    const skippedNames: string[] = [];
    const failedMessages: string[] = [];

    try {
      for (const service of orderedServices) {
        if (service.status === "running") {
          skippedNames.push(
            getServiceDisplayName(service.id, service.name),
          );
          continue;
        }

        try {
          const result = await start(service.id);
          if (result.ok) {
            startedNames.push(
              getServiceDisplayName(service.id, service.name),
            );
          } else {
            failedMessages.push(
              `${getServiceDisplayName(service.id, service.name)}：${result.message}`,
            );
          }
        } catch (reason) {
          failedMessages.push(
            `${getServiceDisplayName(service.id, service.name)}：${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      }

      const summary = [
        startedNames.length > 0
          ? `已启动 ${startedNames.join("、")}`
          : "",
        skippedNames.length > 0
          ? `已跳过运行中的 ${skippedNames.join("、")}`
          : "",
        failedMessages.length > 0 ? failedMessages.join("；") : "",
      ]
        .filter(Boolean)
        .join("。");

      setFeedback(summary || "一键启动完成。");
    } finally {
      setIsBatchStarting(false);
    }
  }

  const metaItems: MetaItem[] = activeDetailService
    ? [
      {
        key: "pidFile",
        label: "进程 ID (PID)",
        value: getPidDisplay(activeDetailService),
        title: getPidDisplay(activeDetailService),
        actions: activeDetailService.healthMeta.pidFilePath
          ? [
            {
              label: "显示",
              icon: "folder",
              onAction: () =>
                void revealServicePath(
                  activeDetailService.healthMeta
                    .pidFilePath,
                  "file",
                ),
            },
          ]
          : undefined,
      },
      {
        key: "description",
        label: "描述",
        value: activeDetailDescription || "未声明",
        title: activeDetailDescription || "未声明",
      },
      {
        key: "installDir",
        label: "安装目录",
        value: activeDetailService.installDir || "未声明",
        title: activeDetailService.installDir || "未声明",
        actions: activeDetailService.installDir
          ? [
            {
              label: "打开",
              icon: "folder",
              onAction: () =>
                void revealServicePath(
                  activeDetailService.installDir,
                  "directory",
                ),
            },
          ]
          : undefined,
      },
      {
        key: "configDirs",
        label: "配置目录",
        value:
          configDirectoryPaths.length > 0
            ? configDirectoryPaths.join("、")
            : "未声明",
        title:
          configDirectoryPaths.length > 0
            ? configDirectoryPaths.join("\n")
            : "未声明",
        actions:
          configDirectoryPaths.length > 0
            ? configDirectoryPaths.map(
              (directoryPath, index) => ({
                label:
                  configDirectoryPaths.length === 1
                    ? "打开"
                    : `打开 ${index + 1}`,
                icon: "folder",
                onAction: () =>
                  void revealServicePath(
                    directoryPath,
                    "directory",
                  ),
              }),
            )
            : undefined,
      },
      {
        key: "logFile",
        label: "主日志路径",
        value:
          activeDetailService.healthMeta.logFilePath || "未声明",
        title:
          activeDetailService.healthMeta.logFilePath || "未声明",
        actions: activeDetailService.healthMeta.logFilePath
          ? [
            {
              label: "查看日志",
              icon: "article",
              onAction: () =>
                void openLogViewer(
                  activeDetailService,
                  "main",
                  `${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} · 日志文件`,
                ),
            },
            {
              label: "显示",
              icon: "folder",
              onAction: () =>
                void revealServicePath(
                  activeDetailService.healthMeta
                    .logFilePath,
                  "file",
                ),
            },
          ]
          : undefined,
      },
      {
        key: "errorLog",
        label: "错误日志路径",
        value: errorLogDisplay,
        title: errorLogDisplay,
        actions: activeDetailService.healthMeta.errorLogFilePath
          ? [
            {
              label: "查看日志",
              icon: "article",
              onAction: () =>
                void openLogViewer(
                  activeDetailService,
                  "error",
                  `${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} · 错误日志`,
                ),
            },
            {
              label: "显示",
              icon: "folder",
              onAction: () =>
                void revealServicePath(
                  activeDetailService.healthMeta
                    .errorLogFilePath,
                  "file",
                ),
            },
          ]
          : undefined,
      },
    ]
    : [];
  const activeDetailStatusText = activeDetailService?.statusLabel || "待接入";
  const activeDetailStatusDetail =
    activeDetailService &&
      activeDetailService.status !== "running" &&
      activeDetailService.message &&
      activeDetailService.message !== activeDetailService.statusLabel
      ? activeDetailService.message
      : "";
  const registeredStatusLabel = serviceCounts.total > 0 ? "活跃" : "空";
  const runningStatusLabel = serviceCounts.running > 0 ? "运行中" : "待命";

  return (
    <section ref={pageRef} className="control-center-page workspace-wide">
      <div className="page-head control-center-hero">
        <div className="control-center-hero-copy">
          <h1>控制中心</h1>
          <p>管理并监控您的基础设施服务集群。</p>
        </div>
        <div
          className="control-center-dashboard-metrics"
          aria-label="服务概览"
        >
          <div className="control-center-metric-card">
            <span className="summary-kicker">已注册服务</span>
            <div className="control-center-metric-value">
              <strong>{serviceCounts.total}</strong>
              <span className="control-center-metric-chip is-success">
                {registeredStatusLabel}
              </span>
            </div>
          </div>
          <div className="control-center-metric-card">
            <span className="summary-kicker">运行中实例</span>
            <div className="control-center-metric-value">
              <strong>{serviceCounts.running}</strong>
              <span className="control-center-metric-chip is-warning">
                {runningStatusLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      {feedback || error ? (
        <div className="control-center-feedback-anchor">
          <div
            className="control-center-feedback-layer"
            aria-live="polite"
          >
            {feedback ? (
              <div
                className="feedback-banner control-center-feedback-toast"
                role="status"
              >
                {feedback}
              </div>
            ) : null}
            {error ? (
              <div
                className="feedback-banner warning-banner control-center-feedback-toast"
                role="alert"
              >
                {error}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="loading-box">正在读取服务状态…</div>
      ) : null}

      <div className="control-center-shell">
        <aside
          className="service-sider service-catalog"
          aria-label="服务目录"
        >
          <div className="service-accordion">
            {[
              {
                key: "core" as const,
                title: "核心服务",
                subtitle: `${coreModules.length} 个核心服务`,
                services: coreModules,
                empty: "暂无核心服务",
              },
              {
                key: "market" as const,
                title: "功能市场",
                subtitle: `${marketServices.length} 个插件`,
                services: marketServices,
                empty: "暂无已导入插件",
              },
            ].map((group) => {
              const isOpen =
                group.key === "core"
                  ? true
                  : expandedGroup === group.key;

              return (
                <section
                  key={group.key}
                  className={`service-group${isOpen ? " is-open" : ""}`}
                >
                  <div className="service-group-head">
                    <button
                      type="button"
                      className="service-group-trigger"
                      onClick={() =>
                        toggleGroup(group.key)
                      }
                      aria-expanded={isOpen}
                    >
                      <div className="service-group-copy">
                        <h2>{group.title}</h2>
                        <span>{group.subtitle}</span>
                      </div>
                    </button>
                    {group.key === "core" ? (
                      <button
                        type="button"
                        className="service-catalog-quick-start"
                        onClick={() =>
                          void handleQuickStart()
                        }
                        disabled={isBatchStarting}
                      >
                        {isBatchStarting
                          ? "启动中..."
                          : "一键启动"}
                      </button>
                    ) : null}
                    {group.key === "market" ? (
                      <button
                        type="button"
                        className="service-catalog-import"
                        onClick={() =>
                          void handleInstallPlugin()
                        }
                      >
                        <span aria-hidden="true">
                          +
                        </span>
                        导入插件
                      </button>
                    ) : null}
                  </div>

                  {isOpen ? (
                    <div className="service-nav-list">
                      {group.services.length > 0 ? (
                        group.services.map((item) => {
                          const service =
                            "service" in item
                              ? item.service
                              : item;
                          const cardId =
                            "service" in item
                              ? item.id
                              : item.id;
                          const cardName =
                            "service" in item &&
                              service
                              ? getServiceDisplayName(
                                service.id,
                                item.name,
                              )
                              : item.name;
                          const isSelected =
                            selectedServiceId ===
                            cardId;
                          const isPendingLifecycle =
                            Boolean(service) &&
                            pendingAction?.scope ===
                            "lifecycle" &&
                            pendingAction.serviceId ===
                            service.id;
                          const statusLabel = service
                            ? service.statusLabel
                            : "待接入";
                          const statusClassName =
                            isPendingLifecycle
                              ? "loading"
                              : service
                                ? statusDotClass(
                                  service.status,
                                )
                                : "idle";
                          const helpDescription =
                            "service" in item &&
                              service
                              ? item.description ||
                              service.description ||
                              "暂无描述。"
                              : "service" in item
                                ? item.description ||
                                "暂无描述。"
                                : item.description ||
                                "暂无描述。";
                          const isHelpTipOpen =
                            helpTip?.serviceId ===
                            cardId;

                          return (
                            <div
                              key={cardId}
                              role="button"
                              tabIndex={0}
                              className={`service-nav-card is-compact-service${isSelected ? " is-active" : ""}`}
                              onClick={() =>
                                selectService(
                                  cardId,
                                )
                              }
                              onKeyDown={(
                                event,
                              ) =>
                                handleServiceCardKeyDown(
                                  event,
                                  cardId,
                                )
                              }
                              aria-pressed={
                                isSelected
                              }
                            >
                              <div className="service-nav-card-head">
                                <div className="service-nav-title-row">
                                  <h3>
                                    {
                                      cardName
                                    }
                                  </h3>
                                  {service ? (
                                    <span
                                      className="service-nav-help-wrap"
                                      data-service-help-tip-root
                                    >
                                      <button
                                        type="button"
                                        className="service-nav-help-button"
                                        onClick={(
                                          event,
                                        ) => {
                                          event.stopPropagation();
                                          openServiceHelp(
                                            cardId,
                                            cardName,
                                            helpDescription,
                                            event.currentTarget,
                                          );
                                        }}
                                        onKeyDown={(
                                          event,
                                        ) =>
                                          event.stopPropagation()
                                        }
                                        aria-label={`查看${cardName}说明`}
                                        aria-expanded={
                                          isHelpTipOpen
                                        }
                                        title="查看说明"
                                      >
                                        <ServiceHelpIcon />
                                      </button>
                                    </span>
                                  ) : null}
                                </div>
                                {service ? (
                                  <span
                                    className="service-nav-version-status"
                                    title={
                                      isPendingLifecycle
                                        ? "处理中"
                                        : `${service.version} · ${statusLabel}`
                                    }
                                  >
                                    <span
                                      className={`status-dot ${statusClassName}`}
                                      aria-hidden="true"
                                    />
                                    <span className="service-nav-version-inline">
                                      {
                                        service.version
                                      }
                                    </span>
                                  </span>
                                ) : (
                                  <span
                                    className="service-nav-version-status"
                                    title={
                                      statusLabel
                                    }
                                  >
                                    <span
                                      className={`status-dot ${statusClassName}`}
                                      aria-hidden="true"
                                    />
                                    <span className="service-nav-status-label">
                                      {
                                        statusLabel
                                      }
                                    </span>
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="service-group-empty">
                          {group.empty}
                        </div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </aside>

        {activeDetailService ? (
          <article className="control-center-detail">
            <section className="service-card control-center-service-hero">
              <div className="control-center-service-head">
                <div className="control-center-service-main">
                  <div
                    className="service-hero-icon"
                    aria-hidden="true"
                  >
                    <span />
                  </div>
                  <div className="service-hero-copy">
                    <div className="service-hero-title-line">
                      <h2>{activeDetailName}</h2>
                    </div>
                    <p>{activeDetailDescription}</p>
                  </div>
                </div>
                <div
                  className="service-title-actions service-primary-actions"
                  aria-label="服务快捷操作"
                >
                  {activeDetailService.kind === "builtin" &&
                    (activeDetailService.status ===
                      "not-installed" ||
                      activeDetailService.status ===
                      "stopped" ||
                      activeDetailService.status ===
                      "error") ? (
                    <button
                      type="button"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "lifecycle",
                          () =>
                            installBuiltin(
                              activeDetailService.id,
                            ),
                          {
                            invalidateConfig: true,
                          },
                        )
                      }
                      className="service-title-text-button service-action-button"
                      disabled={
                        activeId ===
                        activeDetailService.id
                      }
                      aria-label="重新安装"
                      title="重新安装"
                    >
                      <ReinstallServiceIcon />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="service-title-text-button service-action-button is-primary"
                    onClick={() =>
                      runAction(
                        activeDetailService.id,
                        "lifecycle",
                        () =>
                          start(
                            activeDetailService.id,
                          ),
                      )
                    }
                    disabled={
                      activeId === activeDetailService.id
                    }
                    aria-label="启动服务"
                    title="启动服务"
                  >
                    <StartServiceIcon />
                  </button>
                  <button
                    type="button"
                    className="service-title-text-button service-action-button is-danger"
                    onClick={() =>
                      runAction(
                        activeDetailService.id,
                        "lifecycle",
                        () =>
                          stop(
                            activeDetailService.id,
                          ),
                      )
                    }
                    disabled={
                      activeId === activeDetailService.id
                    }
                    aria-label="停止"
                    title="停止"
                  >
                    <StopServiceIcon />
                  </button>
                  <button
                    type="button"
                    className="service-title-text-button service-action-button is-warning"
                    onClick={() =>
                      runAction(
                        activeDetailService.id,
                        "lifecycle",
                        () =>
                          restart(
                            activeDetailService.id,
                          ),
                      )
                    }
                    disabled={
                      activeId === activeDetailService.id
                    }
                    aria-label="重启"
                    title="重启"
                  >
                    <RestartServiceIcon />
                  </button>
                  {activeDetailService.frontendMode !==
                    "none" &&
                    activeDetailService.status === "running" ? (
                    <button
                      type="button"
                      className="service-title-text-button service-action-button is-primary"
                      onClick={() =>
                        navigate(
                          `/service/${activeDetailService.id}`,
                        )
                      }
                      aria-label="打开前端"
                      title="打开前端"
                    >
                      <OpenFrontendIcon />
                    </button>
                  ) : null}
                  {activeDetailService.kind === "builtin" &&
                    activeDetailService.status ===
                    "not-installed" ? (
                    <button
                      type="button"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "lifecycle",
                          () =>
                            installBuiltinFromBundle(
                              activeDetailService.id,
                            ),
                          {
                            invalidateConfig: true,
                          },
                        )
                      }
                      className="service-title-text-button service-action-button is-primary"
                      disabled={
                        activeId ===
                        activeDetailService.id
                      }
                      aria-label="安装"
                      title="安装"
                    >
                      <InstallServiceIcon />
                    </button>
                  ) : null}
                  {shouldShowInitializeAction(
                    activeDetailService,
                  ) ? (
                    <button
                      type="button"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "lifecycle",
                          () =>
                            initialize(
                              activeDetailService.id,
                            ),
                          {
                            invalidateConfig: true,
                          },
                        )
                      }
                      className="service-title-text-button service-action-button is-primary"
                      disabled={
                        activeId ===
                        activeDetailService.id
                      }
                      aria-label={
                        activeDetailService.status ===
                          "initialization-required"
                          ? "初始化"
                          : "重新初始化"
                      }
                      title={
                        activeDetailService.status ===
                          "initialization-required"
                          ? "初始化"
                          : "重新初始化"
                      }
                    >
                      <RestartServiceIcon />
                    </button>
                  ) : null}
                  {activeDetailService.kind === "plugin" ? (
                    <button
                      type="button"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "lifecycle",
                          async () => {
                            const r =
                              await uninstallPlugin(
                                activeDetailService.id,
                              );
                            return {
                              ok: r.ok,
                              message: r.message,
                            };
                          },
                          { invalidateConfig: true },
                        )
                      }
                      className="service-title-text-button service-action-button"
                      disabled={
                        activeId ===
                        activeDetailService.id
                      }
                      aria-label="卸载插件"
                      title="卸载插件"
                    >
                      <UninstallServiceIcon />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="service-title-text-button service-action-button"
                    onClick={() =>
                      openServiceDetail(
                        activeDetailService.id,
                      )
                    }
                    aria-label="详情"
                    title="详情"
                  >
                    <ServiceInfoIcon />
                  </button>
                </div>
              </div>

              <div className="service-detail-metadata">
                <div className="service-detail-metadata-item">
                  <span>当前版本</span>
                  <strong>
                    {activeDetailService.version}
                  </strong>
                </div>
                <div className="service-detail-metadata-item">
                  <span>实例状态</span>
                  <strong
                    className={`service-status-text ${statusClass(activeDetailService.status)}`}
                  >
                    {activeDetailStatusText}
                  </strong>
                </div>
                <div className="service-detail-metadata-item is-log-actions">
                  <span>日志</span>
                  <div className="service-detail-log-actions">
                    <button
                      type="button"
                      className="service-detail-log-action"
                      onClick={() =>
                        void openLogViewer(
                          activeDetailService,
                          "main",
                          `${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} · 日志文件`,
                        )
                      }
                      disabled={
                        !activeDetailService.healthMeta
                          .logFilePath
                      }
                      aria-label="查看日志"
                      title="查看日志"
                    >
                      <LogArticleIcon />
                    </button>
                    <button
                      type="button"
                      className="service-detail-log-action"
                      onClick={() =>
                        void revealServicePath(
                          activeDetailService
                            .healthMeta.logFilePath,
                          "file",
                        )
                      }
                      disabled={
                        !activeDetailService.healthMeta
                          .logFilePath
                      }
                      aria-label="打开日志位置"
                      title="打开日志位置"
                    >
                      <LogFolderIcon />
                    </button>
                  </div>
                </div>
                <div className="service-detail-metadata-item is-endpoint">
                  <span>内部访问地址</span>
                  {detailEndpoint ? (
                    <a
                      href={detailEndpoint}
                      className="service-detail-link truncated-hover-value"
                      data-full-value={detailEndpoint}
                      onClick={(event) => {
                        if (
                          activeDetailService.frontendMode ===
                          "none"
                        ) {
                          return;
                        }
                        event.preventDefault();
                        navigate(
                          `/service/${activeDetailService.id}`,
                        );
                      }}
                    >
                      <span className="truncated-hover-text">
                        {detailEndpoint}
                      </span>
                    </a>
                  ) : (
                    <strong>未声明</strong>
                  )}
                </div>
              </div>
              {activeDetailStatusDetail ? (
                <div
                  className={`service-status-message ${statusClass(activeDetailService.status)}`}
                >
                  <p>{activeDetailStatusDetail}</p>
                </div>
              ) : null}
            </section>

            <section className="config-panel">
              <div className="config-head">
                <div className="config-title-main">
                  <div className="config-title-label">
                    <span
                      className="config-terminal-icon"
                      aria-hidden="true"
                    >
                      <ConfigTerminalIcon />
                    </span>
                    <h3>配置</h3>
                  </div>
                  {selectedConfigFile ? (
                    <div
                      className="config-file-select config-title-file-select"
                      data-config-file-select-root
                    >
                      <button
                        type="button"
                        className="config-file-select-trigger"
                        aria-label="选择配置文件"
                        aria-haspopup="listbox"
                        aria-expanded={
                          configFileSelectOpen
                        }
                        onClick={() =>
                          setConfigFileSelectOpen(
                            (current) => !current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key !==
                            "ArrowDown"
                          ) {
                            return;
                          }
                          event.preventDefault();
                          setConfigFileSelectOpen(
                            true,
                          );
                        }}
                      >
                        <span className="config-file-select-value">
                          {selectedConfigFile.label ||
                            selectedConfigFile.relativePath}{" "}
                          ·{" "}
                          {getConfigSourceLabel(
                            selectedConfigFile,
                            selectedConfigMeta,
                          )}
                        </span>
                        <SelectChevronIcon />
                      </button>
                      {configFileSelectOpen ? (
                        <div
                          className="config-file-select-panel"
                          role="listbox"
                          aria-label="选择配置文件"
                        >
                          {activeDetailService.configFiles.map(
                            (configFile) => {
                              const fileMeta =
                                serviceConfigMeta[
                                configFile
                                  .key
                                ];
                              const isSelected =
                                configFile.key ===
                                selectedConfigFile.key;
                              return (
                                <button
                                  key={
                                    configFile.key
                                  }
                                  type="button"
                                  className={`config-file-select-option${isSelected ? " is-selected" : ""}`}
                                  role="option"
                                  aria-selected={
                                    isSelected
                                  }
                                  onClick={() =>
                                    selectConfigFile(
                                      configFile.key,
                                    )
                                  }
                                >
                                  <span>
                                    {configFile.label ||
                                      configFile.relativePath}{" "}
                                    ·{" "}
                                    {getConfigSourceLabel(
                                      configFile,
                                      fileMeta,
                                    )}
                                  </span>
                                </button>
                              );
                            },
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {selectedConfigFile ? (
                  <div className="config-select-wrap">
                    <span
                      className={`config-status${selectedConfigDirty ? " is-dirty" : ""}`}
                    >
                      <span
                        className="config-status-dot"
                        aria-hidden="true"
                      />
                    </span>
                    <button
                      type="button"
                      className="action-button primary config-save-button"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "detail",
                          async () => {
                            const result =
                              await writeConfig(
                                activeDetailService.id,
                                selectedConfigFile.key,
                                selectedConfigContent,
                              );
                            if (result.ok) {
                              setConfigOriginalCache(
                                (current) => ({
                                  ...current,
                                  [activeDetailService.id]:
                                  {
                                    ...(current[
                                      activeDetailService
                                        .id
                                    ] ??
                                      {}),
                                    [selectedConfigFile.key]:
                                      selectedConfigContent,
                                  },
                                }),
                              );
                            }
                            return result;
                          },
                          {
                            invalidateConfig: true,
                          },
                        )
                      }
                      disabled={
                        activeId ===
                        activeDetailService.id ||
                        !selectedConfigDirty
                      }
                    >
                      保存
                    </button>
                  </div>
                ) : null}
              </div>
              {activeDetailService.configFiles.length > 0 &&
                selectedConfigFile ? (
                <>
                  <textarea
                    className="config-editor"
                    value={selectedConfigContent}
                    onChange={(event) =>
                      setConfigCache((current) => ({
                        ...current,
                        [activeDetailService.id]: {
                          ...(current[
                            activeDetailService.id
                          ] ?? {}),
                          [selectedConfigFile.key]:
                            event.target.value,
                        },
                      }))
                    }
                    spellCheck={false}
                  />
                  {selectedConfigMeta?.source ===
                    "template" ? (
                    <p className="service-message">
                      当前内容来自模板，保存或初始化后才会写入目标文件。
                    </p>
                  ) : null}
                  {selectedConfigMeta?.source ===
                    "missing" ? (
                    <p className="service-message">
                      当前文件尚未创建，保存后会写入目标路径。
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="service-message">
                  该服务未声明可编辑配置文件。
                </p>
              )}
            </section>

            {detailDialogOpen ? (
              <div
                className="service-detail-dialog-backdrop"
                onClick={() => setDetailDialogOpen(false)}
              >
                <section
                  className="service-detail-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label={`${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} 详情`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="service-detail-dialog-head">
                    <h3>
                      {getServiceDisplayName(
                        activeDetailService.id,
                        activeDetailService.name,
                      )}
                    </h3>
                    <button
                      type="button"
                      className="service-detail-dialog-close"
                      onClick={() =>
                        setDetailDialogOpen(false)
                      }
                      aria-label="关闭详情"
                    >
                      &times;
                    </button>
                  </div>
                  <dl className="service-detail-list">
                    {metaItems.map((item) => (
                      <div
                        key={item.key}
                        className="service-detail-list-item"
                      >
                        <dt>{item.label}</dt>
                        <dd>
                          <span
                            className="service-detail-path-value"
                            title={item.title}
                          >
                            {item.value}
                          </span>
                          {item.actions?.map(
                            (action) => (
                              <button
                                key={
                                  action.label
                                }
                                type="button"
                                className="service-detail-log-action"
                                onClick={
                                  action.onAction
                                }
                                disabled={
                                  action.disabled
                                }
                                aria-label={
                                  action.label
                                }
                                title={
                                  action.label
                                }
                              >
                                {action.icon ===
                                  "article" ? (
                                  <LogArticleIcon />
                                ) : (
                                  <LogFolderIcon />
                                )}
                              </button>
                            ),
                          )}
                        </dd>
                      </div>
                    ))}
                    <div className="service-detail-list-item">
                      <dt>配置文件</dt>
                      <dd>
                        {activeDetailService.configFiles
                          .length > 0 ? (
                          <div className="service-detail-config-files">
                            {activeDetailService.configFiles.map(
                              (configFile) => {
                                const fileMeta =
                                  serviceConfigMeta[
                                  configFile
                                    .key
                                  ];
                                return (
                                  <div
                                    key={
                                      configFile.key
                                    }
                                    className="service-detail-config-file"
                                  >
                                    <div className="service-detail-config-file-main">
                                      <span>
                                        {
                                          configFile.absolutePath
                                        }
                                      </span>
                                    </div>
                                    <span
                                      className={`config-file-source ${getConfigSourceClass(configFile, fileMeta)}`}
                                    >
                                      {getConfigSourceLabel(
                                        configFile,
                                        fileMeta,
                                      )}
                                    </span>
                                    <button
                                      type="button"
                                      className="service-detail-log-action"
                                      onClick={() =>
                                        void revealServicePath(
                                          configFile.absolutePath,
                                          "file",
                                        )
                                      }
                                      aria-label="显示配置文件位置"
                                      title="显示配置文件位置"
                                    >
                                      <LogFolderIcon />
                                    </button>
                                  </div>
                                );
                              },
                            )}
                          </div>
                        ) : (
                          <span>未声明</span>
                        )}
                      </dd>
                    </div>
                    <div className="service-detail-list-item">
                      <dt>前置条件</dt>
                      <dd>
                        {activeDetailService.healthMeta
                          .prerequisites.length >
                          0 ? (
                          <div className="service-detail-prereqs">
                            {activeDetailService.healthMeta.prerequisites.map(
                              (item) => (
                                <span
                                  key={item}
                                >
                                  {item}
                                </span>
                              ),
                            )}
                          </div>
                        ) : (
                          <span>无</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            ) : null}
          </article>
        ) : activeCoreModule ? (
          <article className="service-card control-center-detail">
            <div className="service-card-head">
              <div>
                <p className="service-kicker">默认集成模块</p>
                <h2>{activeCoreModule.name}</h2>
              </div>
              <span className="status-pill idle">待接入</span>
            </div>

            <p className="service-description">
              {activeCoreModule.description}
            </p>
            <p className="service-message">
              该模块会默认展示在控制中心中。当前运行时还没有读到对应服务清单，请确认内置资源已同步到应用后再进行配置和安装。
            </p>
          </article>
        ) : (
          <div className="loading-box control-center-empty">
            暂无已登记服务。
          </div>
        )}
      </div>

      {helpTip ? (
        <div
          className="service-nav-help-tip service-nav-help-tip-portal"
          role="tooltip"
          data-service-help-tip-root
          aria-label={`${helpTip.label}说明`}
          style={{
            top: `${helpTip.top}px`,
            left: `${helpTip.left}px`,
          }}
        >
          {helpTip.description}
        </div>
      ) : null}
    </section>
  );
}
