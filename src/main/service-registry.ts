import path from "node:path";
import type { ServiceId, ServiceKind, PluginManifest } from "../shared/contracts";

export interface BuiltinServiceDefinition {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  assetFileName: string;
  bundleTopLevelDir: string;
  hasFrontend: boolean;
  configFiles: Array<{
    key: string;
    label: string;
    relativePath: string;
    templateRelativePath?: string;
    required: boolean;
  }>;
  importTargets: Array<{
    key: string;
    label: string;
    relativePath: string;
    required: boolean;
  }>;
  runtime: {
    pidRelativePath: string;
    logRelativePath: string;
    startCommand: string[];
    stopCommand: string[];
    requiredPaths: string[];
  };
  web: {
    routePath: string;
    portEnvKey: string;
    defaultPort: number;
  };
  prerequisites: string[];
}

export const builtinServices: BuiltinServiceDefinition[] = [
  {
    id: "agent-container-hub",
    name: "Container Hub",
    kind: "builtin",
    version: "v0.1.0",
    description: "宿主机容器服务，负责为后续智能体运行时提供沙箱能力。",
    assetFileName: "agent-container-hub-program-v0.1.0-darwin-arm64.tar.gz",
    bundleTopLevelDir: "agent-container-hub",
    hasFrontend: false,
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      }
    ],
    importTargets: [],
    runtime: {
      pidRelativePath: path.join(".runtime", "agent-container-hub.pid"),
      logRelativePath: path.join(".runtime", "agent-container-hub.log"),
      startCommand: ["./start.sh", "--daemon"],
      stopCommand: ["./stop.sh"],
      requiredPaths: [
        "agent-container-hub",
        "start.sh",
        "stop.sh",
        ".env.example",
        path.join("configs", "environments")
      ]
    },
    web: {
      routePath: "",
      portEnvKey: "BIND_ADDR",
      defaultPort: 11960
    },
    prerequisites: ["Docker 或 Podman"]
  },
  {
    id: "zenmind-app-server",
    name: "认证服务",
    kind: "builtin",
    version: "v0.1.0",
    description: "认证与管理服务，提供 OAuth2/OIDC、管理后台、App 访问令牌和设备管理。",
    assetFileName: "zenmind-app-server-program-v0.1.0-darwin-arm64.tar.gz",
    bundleTopLevelDir: "zenmind-app-server",
    hasFrontend: true,
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      }
    ],
    importTargets: [],
    runtime: {
      pidRelativePath: path.join(".runtime", "app-server.pid"),
      logRelativePath: path.join(".runtime", "app-server.log"),
      startCommand: ["./start.sh", "--daemon"],
      stopCommand: ["./stop.sh"],
      requiredPaths: [
        "app-server",
        "start.sh",
        "stop.sh",
        ".env.example",
        "schema.sql",
        path.join("frontend", "dist", "index.html")
      ]
    },
    web: {
      routePath: "/admin/",
      portEnvKey: "SERVER_PORT",
      defaultPort: 11950
    },
    prerequisites: []
  }
];

const pluginServices = new Map<string, BuiltinServiceDefinition>();

export function registerPlugin(manifest: PluginManifest): BuiltinServiceDefinition {
  const def: BuiltinServiceDefinition = {
    id: manifest.id,
    name: manifest.name,
    kind: "plugin",
    version: manifest.version,
    description: manifest.description,
    assetFileName: "",
    bundleTopLevelDir: manifest.id,
    hasFrontend: manifest.hasFrontend,
    configFiles: (manifest.configFiles ?? []).map((c) => ({ ...c })),
    importTargets: [],
    runtime: {
      pidRelativePath: manifest.runtime.pidRelativePath,
      logRelativePath: manifest.runtime.logRelativePath,
      startCommand: manifest.runtime.startCommand,
      stopCommand: manifest.runtime.stopCommand,
      requiredPaths: []
    },
    web: manifest.web
      ? { routePath: manifest.web.routePath, portEnvKey: manifest.web.portEnvKey, defaultPort: manifest.web.defaultPort }
      : { routePath: "", portEnvKey: "", defaultPort: 0 },
    prerequisites: []
  };
  pluginServices.set(manifest.id, def);
  return def;
}

export function unregisterPlugin(serviceId: string) {
  pluginServices.delete(serviceId);
}

export function getAllServices(): BuiltinServiceDefinition[] {
  return [...builtinServices, ...pluginServices.values()];
}

export function getBuiltinService(serviceId: ServiceId): BuiltinServiceDefinition {
  const service = builtinServices.find((item) => item.id === serviceId) ?? pluginServices.get(serviceId);
  if (!service) {
    throw new Error(`unknown service id: ${serviceId}`);
  }
  return service;
}
