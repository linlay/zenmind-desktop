import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { Manifest } from "../shared/contracts";
import { readManifestFromArchive } from "./manifest-utils";
import { clearServices, registerService } from "./service-registry";

const manifestCache = new Map<string, { key: string; manifest: Manifest }>();
const FALLBACK_BUILTIN_MANIFESTS: Manifest[] = [
  {
    kind: "builtin",
    id: "agent-container-hub",
    name: "Container Hub",
    version: "v0.1.0",
    description: "宿主机容器服务，负责为后续智能体运行时提供沙箱能力。",
    frontend: {
      mode: "embedded",
      entry: "/",
      assetsPrefix: "/ui/",
      directAccess: true,
      hostManaged: false
    },
    api: {
      enabled: true
    },
    backend: {
      entry: "backend/agent-container-hub"
    },
    scripts: {
      start: ["start.sh", "--daemon"],
      stop: "stop.sh",
      deploy: "deploy.sh"
    },
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      }
    ],
    runtime: {
      pidRelativePath: "run/agent-container-hub.pid",
      logRelativePath: "run/agent-container-hub.log",
      requiredPaths: [
        "backend/agent-container-hub",
        "start.sh",
        "stop.sh",
        "deploy.sh",
        "scripts/program-common.sh",
        ".env.example",
        "manifest.json",
        "configs/environments"
      ]
    },
    web: {
      routePath: "/",
      portEnvKey: "BIND_ADDR",
      defaultPort: 11960
    },
    prerequisites: [
      "Docker 或 Podman"
    ]
  },
  {
    kind: "builtin",
    id: "agent-platform",
    name: "智能体平台",
    version: "v0.1.0",
    description: "AI Agent 运行时，提供对话、工具执行和沙箱能力。",
    frontend: {
      mode: "none"
    },
    backend: {
      entry: "backend/agent-platform-runner"
    },
    scripts: {
      start: ["start.sh", "--daemon"],
      stop: "stop.sh",
      deploy: "deploy.sh"
    },
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      },
      {
        key: "container-hub",
        label: "configs/container-hub.yml",
        relativePath: "configs/container-hub.yml",
        templateRelativePath: "configs/container-hub.example.yml",
        required: false
      },
      {
        key: "bash",
        label: "configs/bash.yml",
        relativePath: "configs/bash.yml",
        templateRelativePath: "configs/bash.example.yml",
        required: false
      },
      {
        key: "cors",
        label: "configs/cors.yml",
        relativePath: "configs/cors.yml",
        templateRelativePath: "configs/cors.example.yml",
        required: false
      }
    ],
    runtime: {
      pidRelativePath: "run/agent-platform-runner.pid",
      logRelativePath: "run/agent-platform-runner.log",
      requiredPaths: [
        "backend/agent-platform-runner",
        "start.sh",
        "stop.sh",
        "deploy.sh",
        "scripts/program-common.sh",
        ".env.example",
        "manifest.json",
        "configs",
        "runtime"
      ]
    },
    web: {
      routePath: "",
      portEnvKey: "SERVER_PORT",
      defaultPort: 11949
    }
  },
  {
    kind: "builtin",
    id: "zenmind-app-server",
    name: "认证服务",
    version: "v0.1.0",
    description: "认证与管理服务，提供 OAuth2/OIDC、管理后台、App 访问令牌和设备管理。",
    frontend: {
      mode: "embedded",
      dist: "frontend/dist",
      index: "index.html",
      spa: true
    },
    api: {
      enabled: true,
      adminBaseUrl: "/admin/api/",
      openidBaseUrl: "/api/openid/",
      oauth2BaseUrl: "/api/oauth2/"
    },
    backend: {
      entry: "backend/zenmind-app-server"
    },
    scripts: {
      start: ["start.sh", "--daemon"],
      stop: "stop.sh",
      deploy: "deploy.sh"
    },
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      }
    ],
    runtime: {
      pidRelativePath: "run/zenmind-app-server.pid",
      logRelativePath: "run/zenmind-app-server.log",
      requiredPaths: [
        "backend/zenmind-app-server",
        "start.sh",
        "stop.sh",
        "deploy.sh",
        "scripts/program-common.sh",
        ".env.example",
        "manifest.json",
        "frontend/dist/index.html"
      ]
    },
    web: {
      routePath: "/admin/",
      portEnvKey: "SERVER_PORT",
      defaultPort: 11950
    }
  }
] as const;

function mergeManifestObject<T>(base: T | undefined, override: T | undefined): T | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...(base as object),
    ...(override as object)
  } as T;
}

export function applyBuiltinManifestFallback(manifest: Manifest): Manifest {
  const fallback = FALLBACK_BUILTIN_MANIFESTS.find((candidate) => candidate.id === manifest.id);
  if (!fallback) {
    return manifest;
  }

  return {
    ...fallback,
    ...manifest,
    frontend: mergeManifestObject(fallback.frontend, manifest.frontend) ?? fallback.frontend,
    api: mergeManifestObject(fallback.api, manifest.api),
    backend: mergeManifestObject(fallback.backend, manifest.backend),
    scripts: mergeManifestObject(fallback.scripts, manifest.scripts) ?? fallback.scripts,
    configFiles: manifest.configFiles ?? fallback.configFiles,
    runtime: mergeManifestObject(fallback.runtime, manifest.runtime) ?? fallback.runtime,
    web: mergeManifestObject(fallback.web, manifest.web),
    prerequisites: manifest.prerequisites ?? fallback.prerequisites,
    desktop: mergeManifestObject(fallback.desktop, manifest.desktop)
  };
}

function isPackaged(app: App) {
  return app.isPackaged;
}

export function getBuiltinAssetsRoot(app: App) {
  if (process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT) {
    return process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  }
  return isPackaged(app)
    ? path.join(process.resourcesPath, "services")
    : path.join(process.cwd(), "build", "resources", "services");
}

function listBuiltinArchivePaths(root: string) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const extension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const archivePaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceDir = path.join(root, entry.name);
    for (const asset of fs.readdirSync(serviceDir, { withFileTypes: true })) {
      if (!asset.isFile() || !asset.name.endsWith(extension)) {
        continue;
      }
      archivePaths.push(path.join(serviceDir, asset.name));
    }
  }

  archivePaths.sort((left, right) => left.localeCompare(right));
  return archivePaths;
}

function readCachedManifest(tarPath: string) {
  const stat = fs.statSync(tarPath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = manifestCache.get(tarPath);
  if (cached && cached.key === cacheKey) {
    return cached.manifest;
  }

  const manifest = readManifestFromArchive(tarPath);
  manifestCache.set(tarPath, {
    key: cacheKey,
    manifest
  });
  return manifest;
}

function getCurrentManifestOs() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function getCurrentManifestArch() {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return process.arch;
  }
}

function getArchiveExtension() {
  return process.platform === "win32" ? ".zip" : ".tar.gz";
}

function isPlatformMatch(manifestOs: string) {
  return manifestOs.trim().toLowerCase() === getCurrentManifestOs();
}

function getFallbackAssetFileName(manifest: Manifest) {
  return `${manifest.id}-${manifest.version}-${getCurrentManifestOs()}-${getCurrentManifestArch()}${getArchiveExtension()}`;
}

function registerFallbackBuiltinServices() {
  for (const manifest of FALLBACK_BUILTIN_MANIFESTS) {
    registerService(manifest, {
      defaultKind: "builtin",
      desktop: {
        assetFileName: getFallbackAssetFileName(manifest),
        bundleTopLevelDir: manifest.id
      }
    });
  }
}

export function loadBuiltinServices(app: App) {
  clearServices("builtin");
  registerFallbackBuiltinServices();

  const builtinAssetsRoot = getBuiltinAssetsRoot(app);
  const loaded = [];
  for (const tarPath of listBuiltinArchivePaths(builtinAssetsRoot)) {
    const manifest = applyBuiltinManifestFallback(readCachedManifest(tarPath));
    if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
      continue;
    }
    const definition = registerService(manifest, {
      defaultKind: "builtin",
      desktop: {
        assetFileName: path.basename(tarPath)
      }
    });
    if (definition.kind === "builtin") {
      loaded.push(definition);
    }
  }

  return loaded;
}
