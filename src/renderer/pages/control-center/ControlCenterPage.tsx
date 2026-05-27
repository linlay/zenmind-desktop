import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ServiceConfigFile,
  ServiceConfigReadResult,
  ServiceId,
  ServiceLogTarget,
  ServiceState,
} from "@shared/contracts";
import { useServices } from "../../services/ServicesContext";
import { useLocation, useNavigate } from "react-router-dom";
import { PageFeedbackStack } from "../../components/PageFeedbackStack";
import { useI18n } from "../../i18n/useI18n";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";

type CoreModuleDefinition = {
  id: ServiceId;
  nameKey: TranslationKey;
  descriptionKey: TranslationKey;
};

const CORE_MODULES: readonly CoreModuleDefinition[] = [
  {
    id: "zenmind-app-server",
    nameKey: "controlCenter.service.authentication.name",
    descriptionKey: "controlCenter.service.authentication.description",
  },
  {
    id: "agent-platform",
    nameKey: "controlCenter.service.agentPlatform.name",
    descriptionKey: "controlCenter.service.agentPlatform.description",
  },
  {
    id: "agent-webclient",
    nameKey: "service.agentWebclientDisplayName",
    descriptionKey: "controlCenter.service.agentWebclient.description",
  },
  {
    id: "agent-container-hub",
    nameKey: "controlCenter.service.containerHub.name",
    descriptionKey: "controlCenter.service.containerHub.description",
  },
];

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
type CoreModuleEntry = CoreModuleDefinition & {
  name: string;
  description: string;
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

function getCoreModuleDefinition(serviceId: ServiceId) {
  return CORE_MODULES.find((module) => module.id === serviceId) ?? null;
}

function getLocalizedServiceDisplayName(
  serviceId: ServiceId,
  serviceName: string,
  t: TranslateFunction,
) {
  const coreModule = getCoreModuleDefinition(serviceId);
  return coreModule ? t(coreModule.nameKey) : serviceName;
}

function getLocalizedServiceDescription(
  service: Pick<ServiceState, "id" | "description">,
  t: TranslateFunction,
) {
  const coreModule = getCoreModuleDefinition(service.id);
  if (coreModule) {
    return t(coreModule.descriptionKey);
  }
  return service.description || t("controlCenter.fallback.description");
}

function getServiceStatusLabel(
  status: ServiceState["status"],
  t: TranslateFunction,
) {
  switch (status) {
    case "not-installed":
      return t("controlCenter.status.notInstalled");
    case "initialization-required":
      return t("controlCenter.status.initializationRequired");
    case "stopped":
      return t("controlCenter.status.stopped");
    case "running":
      return t("controlCenter.status.running");
    case "config-required":
      return t("controlCenter.status.configRequired");
    case "dependency-missing":
      return t("controlCenter.status.dependencyMissing");
    case "error":
      return t("controlCenter.status.error");
    default:
      return t("controlCenter.status.pending");
  }
}

function formatNameList(names: string[], t: TranslateFunction) {
  return names.join(t("controlCenter.list.separator"));
}

function shouldShowInitializeAction(service: ServiceState) {
  return service.status === "initialization-required";
}

function getErrorLogDisplay(service: ServiceState, t: TranslateFunction) {
  if (service.healthMeta.errorLogFilePath) {
    return service.healthMeta.errorLogFilePath;
  }
  if (service.healthMeta.logFilePath) {
    return t("service.noIndependentErrorLog");
  }
  return t("service.notDeclared");
}

function getConfigSourceLabel(
  configFile: ServiceConfigFile,
  t: TranslateFunction,
  meta?: ConfigMeta,
) {
  if (meta?.source === "file") {
    return t("controlCenter.config.source.file");
  }
  if (meta?.source === "template") {
    return t("controlCenter.config.source.template");
  }
  if (meta?.source === "missing") {
    return t("controlCenter.config.source.missing");
  }
  if (configFile.exists) {
    return t("controlCenter.config.source.file");
  }
  return t("controlCenter.config.source.pending");
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

function getPidDisplay(service: ServiceState, t: TranslateFunction) {
  if (service.healthMeta.pid) {
    return String(service.healthMeta.pid);
  }
  if (service.healthMeta.pidFilePath) {
    return t("service.pidFile", { path: service.healthMeta.pidFilePath });
  }
  return t("service.notDeclared");
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
      className="service-action-icon service-action-icon-restart"
      viewBox="0 -960 960 960"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M440-122q-121-15-200.5-105.5T160-440q0-66 26-126.5T260-672l57 57q-38 34-57.5 79T240-440q0 88 56 155.5T440-202v80Zm80 0v-80q87-16 143.5-83T720-440q0-100-70-170t-170-70h-3l44 44-56 56-140-140 140-140 56 56-44 44h3q134 0 227 93t93 227q0 121-79.5 211.5T520-122Z" />
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
  const { t } = useI18n();
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
        name: t(module.nameKey),
        description: t(module.descriptionKey),
        service: serviceById.get(module.id) ?? null,
      })),
    [serviceById, t],
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
    ? getErrorLogDisplay(activeDetailService, t)
    : t("service.notDeclared");
  const detailEndpoint = activeDetailService?.healthMeta.webUrl ?? "";
  const configDirectoryPaths = activeDetailService
    ? getConfigDirectoryPaths(activeDetailService.configFiles)
    : [];
  const activeDetailName = activeDetailService
    ? getLocalizedServiceDisplayName(
      activeDetailService.id,
      activeDetailService.name,
      t,
    )
    : "";
  const activeDetailDescription = activeDetailService
    ? activeCoreModule?.description ||
    getLocalizedServiceDescription(activeDetailService, t)
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
      setFeedback(t("controlCenter.feedback.noQuickStartServices"));
      return;
    }

    const startedNames: string[] = [];
    const skippedNames: string[] = [];
    const failedMessages: string[] = [];

    try {
      for (const service of orderedServices) {
        if (service.status === "running") {
          skippedNames.push(
            getLocalizedServiceDisplayName(service.id, service.name, t),
          );
          continue;
        }

        try {
          const result = await start(service.id);
          if (result.ok) {
            startedNames.push(
              getLocalizedServiceDisplayName(service.id, service.name, t),
            );
          } else {
            failedMessages.push(
              t("controlCenter.feedback.serviceFailed", {
                name: getLocalizedServiceDisplayName(service.id, service.name, t),
                message: result.message,
              }),
            );
          }
        } catch (reason) {
          failedMessages.push(
            t("controlCenter.feedback.serviceFailed", {
              name: getLocalizedServiceDisplayName(service.id, service.name, t),
              message: reason instanceof Error ? reason.message : String(reason),
            }),
          );
        }
      }

      const summary = [
        startedNames.length > 0
          ? t("controlCenter.feedback.startedNames", {
            names: formatNameList(startedNames, t),
          })
          : "",
        skippedNames.length > 0
          ? t("controlCenter.feedback.skippedNames", {
            names: formatNameList(skippedNames, t),
          })
          : "",
        failedMessages.length > 0
          ? failedMessages.join(t("controlCenter.feedback.separator"))
          : "",
      ]
        .filter(Boolean)
        .join(t("controlCenter.feedback.sentenceSeparator"));

      setFeedback(summary || t("controlCenter.feedback.quickStartDone"));
    } finally {
      setIsBatchStarting(false);
    }
  }

  const metaItems: MetaItem[] = activeDetailService
    ? [
      {
        key: "pidFile",
        label: t("controlCenter.meta.pid"),
        value: getPidDisplay(activeDetailService, t),
        title: getPidDisplay(activeDetailService, t),
        actions: activeDetailService.healthMeta.pidFilePath
          ? [
            {
              label: t("controlCenter.meta.show"),
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
        label: t("controlCenter.meta.description"),
        value: activeDetailDescription || t("service.notDeclared"),
        title: activeDetailDescription || t("service.notDeclared"),
      },
      {
        key: "installDir",
        label: t("controlCenter.meta.installDir"),
        value: activeDetailService.installDir || t("service.notDeclared"),
        title: activeDetailService.installDir || t("service.notDeclared"),
        actions: activeDetailService.installDir
          ? [
            {
              label: t("common.open"),
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
        label: t("controlCenter.meta.configDirs"),
        value:
          configDirectoryPaths.length > 0
            ? formatNameList(configDirectoryPaths, t)
            : t("service.notDeclared"),
        title:
          configDirectoryPaths.length > 0
            ? configDirectoryPaths.join("\n")
            : t("service.notDeclared"),
        actions:
          configDirectoryPaths.length > 0
            ? configDirectoryPaths.map(
              (directoryPath, index) => ({
                label:
                  configDirectoryPaths.length === 1
                    ? t("common.open")
                    : t("controlCenter.meta.openPathWithIndex", {
                      index: index + 1,
                    }),
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
        label: t("controlCenter.meta.mainLogPath"),
        value:
          activeDetailService.healthMeta.logFilePath || t("service.notDeclared"),
        title:
          activeDetailService.healthMeta.logFilePath || t("service.notDeclared"),
        actions: activeDetailService.healthMeta.logFilePath
          ? [
            {
              label: t("controlCenter.viewLog"),
              icon: "article",
              onAction: () =>
                void openLogViewer(
                  activeDetailService,
                  "main",
                  t("controlCenter.logs.mainTitle", {
                    name: activeDetailName,
                  }),
                ),
            },
            {
              label: t("controlCenter.meta.show"),
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
        label: t("controlCenter.meta.errorLogPath"),
        value: errorLogDisplay,
        title: errorLogDisplay,
        actions: activeDetailService.healthMeta.errorLogFilePath
          ? [
            {
              label: t("controlCenter.viewLog"),
              icon: "article",
              onAction: () =>
                void openLogViewer(
                  activeDetailService,
                  "error",
                  t("controlCenter.logs.errorTitle", {
                    name: activeDetailName,
                  }),
                ),
            },
            {
              label: t("controlCenter.meta.show"),
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
  const activeDetailStatusText = activeDetailService
    ? getServiceStatusLabel(activeDetailService.status, t)
    : t("controlCenter.status.pending");
  const activeDetailStatusDetail =
    activeDetailService &&
      activeDetailService.status !== "running" &&
      activeDetailService.message &&
      activeDetailService.message !== activeDetailService.statusLabel
      ? activeDetailService.message
      : "";
  const registeredStatusLabel =
    serviceCounts.total > 0
      ? t("controlCenter.metrics.active")
      : t("controlCenter.metrics.empty");
  const runningStatusLabel =
    serviceCounts.running > 0
      ? t("controlCenter.metrics.running")
      : t("controlCenter.metrics.standby");

  return (
    <section ref={pageRef} className="control-center-page workspace-wide">
      <div className="page-head control-center-hero">
        <div className="control-center-hero-copy">
          <h1>{t("controlCenter.title")}</h1>
          <p>{t("controlCenter.copy")}</p>
        </div>
        <div
          className="control-center-dashboard-metrics"
          aria-label={t("controlCenter.metrics.ariaLabel")}
        >
          <div className="control-center-metric-card">
            <span className="summary-kicker">
              {t("controlCenter.metrics.registeredServices")}
            </span>
            <div className="control-center-metric-value">
              <strong>{serviceCounts.total}</strong>
              <span className="control-center-metric-chip is-success">
                {registeredStatusLabel}
              </span>
            </div>
          </div>
          <div className="control-center-metric-card">
            <span className="summary-kicker">
              {t("controlCenter.metrics.runningInstances")}
            </span>
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
        <PageFeedbackStack
          items={[
            ...(feedback
              ? [
                {
                  id: "control-center-feedback",
                  tone: "success" as const,
                  message: feedback,
                },
              ]
              : []),
            ...(error
              ? [
                {
                  id: "control-center-error",
                  tone: "error" as const,
                  message: error,
                },
              ]
              : []),
          ]}
        />
      ) : null}
      {loading ? (
        <div className="loading-box">
          {t("controlCenter.loadingServices")}
        </div>
      ) : null}

      <div className="control-center-shell">
        <aside
          className="service-sider service-catalog"
          aria-label={t("controlCenter.catalog.ariaLabel")}
        >
          <div className="service-accordion">
            {[
              {
                key: "core" as const,
                title: t("controlCenter.group.core"),
                subtitle: t("controlCenter.group.coreSubtitle", {
                  count: coreModules.length,
                }),
                services: coreModules,
                empty: t("controlCenter.group.coreEmpty"),
              },
              {
                key: "market" as const,
                title: t("controlCenter.group.market"),
                subtitle: t("controlCenter.group.marketSubtitle", {
                  count: marketServices.length,
                }),
                services: marketServices,
                empty: t("controlCenter.group.marketEmpty"),
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
                          ? t("controlCenter.quickStarting")
                          : t("controlCenter.quickStart")}
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
                        {t("controlCenter.importPlugin")}
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
                              ? getLocalizedServiceDisplayName(
                                service.id,
                                item.name,
                                t,
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
                            ? getServiceStatusLabel(service.status, t)
                            : t("controlCenter.status.pending");
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
                              getLocalizedServiceDescription(service, t)
                              : "service" in item
                                ? item.description ||
                                t("controlCenter.fallback.description")
                                : item.description ||
                                t("controlCenter.fallback.description");
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
                                        aria-label={t("controlCenter.help.viewServiceDescription", {
                                          name: cardName,
                                        })}
                                        aria-expanded={
                                          isHelpTipOpen
                                        }
                                        data-tooltip={t("controlCenter.help.viewDescription")}
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
                                        ? t("controlCenter.status.processing")
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
                  aria-label={t("controlCenter.actions.ariaLabel")}
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
                      aria-label={t("controlCenter.actions.reinstall")}
                      data-tooltip={t("controlCenter.actions.reinstall")}
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
                    aria-label={t("controlCenter.actions.start")}
                    data-tooltip={t("controlCenter.actions.start")}
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
                    aria-label={t("controlCenter.actions.stop")}
                    data-tooltip={t("controlCenter.actions.stop")}
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
                    aria-label={t("controlCenter.actions.restart")}
                    data-tooltip={t("controlCenter.actions.restart")}
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
                      aria-label={t("controlCenter.actions.openFrontend")}
                      data-tooltip={t("controlCenter.actions.openFrontend")}
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
                      aria-label={t("controlCenter.actions.install")}
                      data-tooltip={t("controlCenter.actions.install")}
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
                          ? t("controlCenter.actions.initialize")
                          : t("controlCenter.actions.reinitialize")
                      }
                      data-tooltip={
                        activeDetailService.status ===
                          "initialization-required"
                          ? t("controlCenter.actions.initialize")
                          : t("controlCenter.actions.reinitialize")
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
                      aria-label={t("controlCenter.actions.uninstallPlugin")}
                      data-tooltip={t("controlCenter.actions.uninstallPlugin")}
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
                    aria-label={t("controlCenter.actions.details")}
                    data-tooltip={t("controlCenter.actions.details")}
                  >
                    <ServiceInfoIcon />
                  </button>
                </div>
              </div>

              <div className="service-detail-metadata">
                <div className="service-detail-metadata-item">
                  <span>{t("controlCenter.meta.currentVersion")}</span>
                  <strong>
                    {activeDetailService.version}
                  </strong>
                </div>
                <div className="service-detail-metadata-item">
                  <span>{t("controlCenter.meta.instanceStatus")}</span>
                  <strong
                    className={`service-status-text ${statusClass(activeDetailService.status)}`}
                  >
                    {activeDetailStatusText}
                  </strong>
                </div>
                <div className="service-detail-metadata-item is-log-actions">
                  <span>{t("controlCenter.logs")}</span>
                  <div className="service-detail-log-actions">
                    <button
                      type="button"
                      className="service-detail-log-action"
                      onClick={() =>
                        void openLogViewer(
                          activeDetailService,
                          "main",
                          t("controlCenter.logs.mainTitle", {
                            name: activeDetailName,
                          }),
                        )
                      }
                      disabled={
                        !activeDetailService.healthMeta
                          .logFilePath
                      }
                      aria-label={t("controlCenter.viewLog")}
                      title={t("controlCenter.viewLog")}
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
                      aria-label={t("controlCenter.openLogLocation")}
                      title={t("controlCenter.openLogLocation")}
                    >
                      <LogFolderIcon />
                    </button>
                  </div>
                </div>
                <div className="service-detail-metadata-item is-endpoint">
                  <span>{t("controlCenter.meta.endpoint")}</span>
                  {detailEndpoint ? (
                    <a
                      href={detailEndpoint}
                      className="service-detail-link truncated-hover-value"
                      data-full-value={detailEndpoint}
                      onClick={(event) => {
                        event.preventDefault();
                        if (
                          activeDetailService.frontendMode ===
                          "none"
                        ) {
                          if (detailEndpoint) {
                            void window.electronAPI.shell.openExternal(detailEndpoint);
                          }
                          return;
                        }
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
                    <strong>{t("service.notDeclared")}</strong>
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
                    <h3>{t("controlCenter.config")}</h3>
                  </div>
                  {selectedConfigFile ? (
                    <div
                      className="config-file-select config-title-file-select"
                      data-config-file-select-root
                    >
                      <button
                        type="button"
                        className="config-file-select-trigger"
                        aria-label={t("controlCenter.config.selectFile")}
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
                            t,
                            selectedConfigMeta,
                          )}
                        </span>
                        <SelectChevronIcon />
                      </button>
                      {configFileSelectOpen ? (
                        <div
                          className="config-file-select-panel"
                          role="listbox"
                          aria-label={t("controlCenter.config.selectFile")}
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
                                      t,
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
                      {t("common.save")}
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
                      {t("controlCenter.config.templateNotice")}
                    </p>
                  ) : null}
                  {selectedConfigMeta?.source ===
                    "missing" ? (
                    <p className="service-message">
                      {t("controlCenter.config.missingNotice")}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="service-message">
                  {t("controlCenter.config.empty")}
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
                  aria-label={t("controlCenter.dialog.ariaLabel", {
                    name: activeDetailName,
                  })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="service-detail-dialog-head">
                    <h3>{activeDetailName}</h3>
                    <button
                      type="button"
                      className="service-detail-dialog-close"
                      onClick={() =>
                        setDetailDialogOpen(false)
                      }
                      aria-label={t("controlCenter.dialog.close")}
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
                      <dt>{t("controlCenter.meta.configFiles")}</dt>
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
                                        t,
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
                                      aria-label={t("controlCenter.config.showFileLocation")}
                                      title={t("controlCenter.config.showFileLocation")}
                                    >
                                      <LogFolderIcon />
                                    </button>
                                  </div>
                                );
                              },
                            )}
                          </div>
                        ) : (
                          <span>{t("service.notDeclared")}</span>
                        )}
                      </dd>
                    </div>
                    <div className="service-detail-list-item">
                      <dt>{t("controlCenter.meta.prerequisites")}</dt>
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
                          <span>{t("common.none")}</span>
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
                <p className="service-kicker">
                  {t("controlCenter.empty.defaultIntegratedModule")}
                </p>
                <h2>{activeCoreModule.name}</h2>
              </div>
              <span className="status-pill idle">
                {t("controlCenter.status.pending")}
              </span>
            </div>

            <p className="service-description">
              {activeCoreModule.description}
            </p>
            <p className="service-message">
              {t("controlCenter.empty.coreModuleNotLoaded")}
            </p>
          </article>
        ) : (
          <div className="loading-box control-center-empty">
            {t("controlCenter.empty.noRegisteredServices")}
          </div>
        )}
      </div>

      {helpTip ? (
        <div
          className="service-nav-help-tip service-nav-help-tip-portal"
          role="tooltip"
          data-service-help-tip-root
          aria-label={t("controlCenter.help.tipAriaLabel", {
            name: helpTip.label,
          })}
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
