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
  installPlugin: () => Promise<PluginInstallResult>;
  uninstallPlugin: (serviceId: ServiceId) => Promise<PluginInstallResult>;
}

const ServicesContext = createContext<ServicesContextValue | null>(null);

export function ServicesProvider({ children }: PropsWithChildren) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  async function refresh() {
    try {
      const next = await window.electronAPI.services.list();
      if (!mountedRef.current) {
        return;
      }
      setServices(next);
      setError("");
    } catch (reason) {
      if (!mountedRef.current) {
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
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
