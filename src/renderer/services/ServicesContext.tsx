import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import type {
  ServiceCommandResult,
  ServiceConfigReadResult,
  ServiceId,
  ServiceImportResult,
  ServiceLogReadOptions,
  ServiceLogReadResult,
  ServiceLogTarget,
  ServiceLogsMeta,
  ServiceState,
  PluginInstallResult
} from "@shared/contracts";

interface ServicesContextValue {
  services: ServiceState[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  installBuiltinFromBundle: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  installBuiltin: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  initialize: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  start: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  stop: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  restart: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
  readConfig: (serviceId: ServiceId, key: string) => Promise<ServiceConfigReadResult>;
  writeConfig: (serviceId: ServiceId, key: string, content: string) => Promise<ServiceCommandResult>;
  importFile: (serviceId: ServiceId, key: string) => Promise<ServiceImportResult>;
  getLogsMeta: (serviceId: ServiceId) => Promise<ServiceLogsMeta>;
  readLog: (
    serviceId: ServiceId,
    target: ServiceLogTarget,
    options?: ServiceLogReadOptions
  ) => Promise<ServiceLogReadResult>;
  installPlugin: () => Promise<PluginInstallResult>;
  uninstallPlugin: (serviceId: ServiceId) => Promise<PluginInstallResult>;
}

const ServicesContext = createContext<ServicesContextValue | null>(null);
function createServicesSnapshot(services: ServiceState[]) {
  return JSON.stringify(services);
}

export function ServicesProvider({ children }: PropsWithChildren) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const servicesSnapshotRef = useRef(createServicesSnapshot([]));

  async function refresh() {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const refreshTask = (async () => {
      try {
        const next = await window.electronAPI.services.list();
        if (!mountedRef.current) {
          return;
        }

        const nextSnapshot = createServicesSnapshot(next);
        if (nextSnapshot !== servicesSnapshotRef.current) {
          servicesSnapshotRef.current = nextSnapshot;
          setServices(next);
        }

        setError((current) => (current ? "" : current));
      } catch (reason) {
        if (!mountedRef.current) {
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        refreshPromiseRef.current = null;
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    })();

    refreshPromiseRef.current = refreshTask;
    return refreshTask;
  }

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const refreshIfVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void refresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const removeServicesChangedListener = window.electronAPI.onServicesChanged(() => {
      void refresh();
    });

    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      removeServicesChangedListener();
    };
  }, []);

  async function wrapCommand(command: () => Promise<ServiceCommandResult>) {
    const result = await command();
    await refresh();
    return result;
  }

  const value: ServicesContextValue = {
    services,
    loading,
    error,
    refresh,
    installBuiltinFromBundle: (serviceId) =>
      wrapCommand(() => window.electronAPI.services.installBuiltinFromBundle(serviceId)),
    installBuiltin: (serviceId) =>
      wrapCommand(() => window.electronAPI.services.installBuiltin(serviceId)),
    initialize: (serviceId) =>
      wrapCommand(() => window.electronAPI.services.initialize(serviceId)),
    start: (serviceId) => wrapCommand(() => window.electronAPI.services.start(serviceId)),
    stop: (serviceId) => wrapCommand(() => window.electronAPI.services.stop(serviceId)),
    restart: (serviceId) => wrapCommand(() => window.electronAPI.services.restart(serviceId)),
    readConfig: (serviceId, key) => window.electronAPI.services.readConfig(serviceId, key),
    writeConfig: (serviceId, key, content) =>
      wrapCommand(() => window.electronAPI.services.writeConfig(serviceId, key, content)),
    importFile: async (serviceId, key) => {
      const result = await window.electronAPI.services.importFile(serviceId, key);
      await refresh();
      return result;
    },
    getLogsMeta: (serviceId) => window.electronAPI.services.getLogsMeta(serviceId),
    readLog: (serviceId, target, options) => window.electronAPI.services.readLog(serviceId, target, options),
    installPlugin: async () => {
      const result = await window.electronAPI.plugins.install();
      await refresh();
      return result;
    },
    uninstallPlugin: async (serviceId) => {
      const result = await window.electronAPI.plugins.uninstall(serviceId);
      await refresh();
      return result;
    }
  };

  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices() {
  const context = useContext(ServicesContext);
  if (!context) {
    throw new Error("useServices must be used within ServicesProvider");
  }
  return context;
}
