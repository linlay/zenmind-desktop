import path from "node:path";
import type { ServiceId, ServiceKind } from "../shared/contracts";

export interface BuiltinServiceDefinition {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  assetFileName: string;
  bundleTopLevelDir: string;
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
    id: "pan-webclient",
    name: "网盘",
    kind: "builtin",
    version: "v0.1.0",
    description: "内置网盘服务，包含 Go 后端和已构建 React 前端。",
    assetFileName: "pan-webclient-program-v0.1.0-darwin-arm64.tar.gz",
    bundleTopLevelDir: "pan-webclient",
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      }
    ],
    importTargets: [
      {
        key: "local-public-key",
        label: "RSA 公钥",
        relativePath: path.join("configs", "local-public-key.pem"),
        required: true
      }
    ],
    runtime: {
      pidRelativePath: path.join(".runtime", "pan-api.pid"),
      logRelativePath: path.join(".runtime", "pan-api.log"),
      startCommand: ["./start.sh"],
      stopCommand: ["./stop.sh"],
      requiredPaths: [
        "pan-api",
        "start.sh",
        "stop.sh",
        ".env.example",
        path.join("frontend", "dist", "index.html")
      ]
    },
    web: {
      routePath: "/pan/",
      portEnvKey: "API_PORT",
      defaultPort: 8080
    },
    prerequisites: ["导入 local-public-key.pem 真实 RSA 公钥"]
  }
];

export function getBuiltinService(serviceId: ServiceId): BuiltinServiceDefinition {
  const service = builtinServices.find((item) => item.id === serviceId);
  if (!service) {
    throw new Error(`unknown service id: ${serviceId}`);
  }
  return service;
}
