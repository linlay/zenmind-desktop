import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile, spawn, spawnSync } from "node:child_process";
import type { App } from "electron";
import type {
  MarketCommandResult,
  MarketInstallState,
  MarketItem,
  SandboxImageImportProgressEvent
} from "../../shared/contracts";
import {
  type ContainerEngineName,
  type ContainerEngineResolution,
  resolveContainerEngine
} from "../container-engine";
import { ContainerHubClient, type ContainerHubConfig, type ContainerHubEnvironment } from "../copilot/core/container-hub";
import { extractArchiveToDir, listArchiveEntries } from "../archive-utils";
import { readEnvFile } from "../env-file";
import { getServiceState } from "../services/manager";
import {
  asString,
  normalizeContainerHubBaseUrl,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const CONTAINER_HUB_SERVICE_ID = "agent-container-hub";
const IMAGE_COMMAND_TIMEOUT_MS = 300_000;

interface SandboxImageImportOptions {
  taskId?: string;
  onProgress?: (event: SandboxImageImportProgressEvent) => void;
}

type LocalContainerImage = {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
};

async function resolveContainerHubConfig(app: App, options: MarketplaceOptions = {}): Promise<ContainerHubConfig | null> {
  if (options.containerHubBaseUrl !== undefined) {
    return {
      baseURL: normalizeContainerHubBaseUrl(options.containerHubBaseUrl),
      authToken: asString(options.containerHubAuthToken).trim() || undefined
    };
  }

  try {
    const state = await getServiceState(app, CONTAINER_HUB_SERVICE_ID);
    if (state.status !== "running" || !state.healthMeta.webUrl) {
      return null;
    }
    const env = readEnvFile(path.join(state.installDir, ".env"));
    return {
      baseURL: normalizeContainerHubBaseUrl(state.healthMeta.webUrl),
      authToken: env.get("AUTH_TOKEN")?.trim() || undefined
    };
  } catch {
    return null;
  }
}

function sandboxBuildState(environment: ContainerHubEnvironment): MarketInstallState {
  if (environment.lastBuild?.status === "building" || environment.lastBuild?.status === "smoke_checking") {
    return "installing";
  }
  if (environment.lastBuild?.status === "failed") {
    return "failed";
  }
  return environment.available ? "installed" : "not-installed";
}

function sandboxEnvironmentToMarketItem(environment: ContainerHubEnvironment): MarketItem {
  const state = sandboxBuildState(environment);
  const imageRef = environment.imageRef || [environment.imageRepository, environment.imageTag].filter(Boolean).join(":");
  const tags = [
    environment.enabled ? "已启用" : "已停用",
    environment.availableBuildTargets.length > 0 ? `${environment.availableBuildTargets.length} 个构建目标` : null,
    environment.lastBuild?.target ? `目标 ${environment.lastBuild.target}` : null
  ].filter((tag): tag is string => Boolean(tag));

  return {
    id: environment.name,
    type: "sandbox-image",
    name: environment.name,
    version: environment.imageTag || "latest",
    description: environment.description,
    tags,
    state,
    source: "local",
    installedVersion: environment.available ? environment.imageTag || "latest" : undefined,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    environmentName: environment.name,
    imageRef,
    buildStatus: environment.lastBuild?.status,
    buildJobId: environment.lastBuild?.id,
    buildTargetCount: environment.availableBuildTargets.length,
    message: state === "failed"
      ? environment.lastBuild?.status || "构建失败"
      : state === "installing" ? "镜像构建中" : undefined
  };
}

function parseContainerImageList(raw: string): LocalContainerImage[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", repository = "", tag = "", size = "", ...createdAtParts] = line.split("\t");
      return {
        id: id.trim(),
        repository: repository.trim(),
        tag: tag.trim(),
        size: size.trim(),
        createdAt: createdAtParts.join("\t").trim()
      };
    })
    .filter((image) =>
      image.id &&
      image.repository &&
      image.tag &&
      image.repository !== "<none>" &&
      image.tag !== "<none>"
    );
}

function localContainerImageToMarketItem(image: LocalContainerImage, engine: ContainerEngineName): MarketItem {
  const imageRef = `${image.repository}:${image.tag}`;
  const tags = [
    engine,
    image.size ? `大小 ${image.size}` : null,
    image.createdAt ? `创建 ${image.createdAt}` : null
  ].filter((tag): tag is string => Boolean(tag));

  return {
    id: imageRef,
    type: "sandbox-image",
    name: image.repository,
    version: image.tag || "latest",
    description: "本机容器引擎中的沙箱镜像。",
    tags,
    state: "installed",
    source: "local",
    installedVersion: image.tag || "latest",
    serviceId: CONTAINER_HUB_SERVICE_ID,
    imageRef,
    imageId: image.id,
    imageSize: image.size || undefined,
    imageCreatedAt: image.createdAt || undefined,
    containerEngine: engine,
    message: engine
  };
}

function listLocalContainerImages(): { engine: ContainerEngineResolution | null; items: MarketItem[]; message: string } {
  const engine = resolveContainerEngine();
  if (!engine) {
    return {
      engine: null,
      items: [],
      message: "未检测到可用的 Docker 或 Podman。"
    };
  }

  const result = spawnSync(engine.command, [
    "image",
    "ls",
    "--format",
    "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}"
  ], {
    encoding: "utf8",
    env: engine.env,
    timeout: 30_000
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      engine,
      items: [],
      message: detail || `${engine.name} image ls 执行失败。`
    };
  }

  return {
    engine,
    items: parseContainerImageList(result.stdout).map((image) => localContainerImageToMarketItem(image, engine.name)),
    message: ""
  };
}

function runEngineCommand(engine: ContainerEngineResolution, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(engine.command, args, {
      encoding: "utf8",
      env: engine.env,
      timeout: IMAGE_COMMAND_TIMEOUT_MS,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || `${engine.name} ${args.join(" ")} 执行失败。`));
        return;
      }
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      });
    });
  });
}

function emitSandboxImageImportProgress(
  options: SandboxImageImportOptions | undefined,
  event: Omit<SandboxImageImportProgressEvent, "taskId">
) {
  options?.onProgress?.({
    taskId: options.taskId,
    ...event
  });
}

function collectOutputLines(
  pending: string,
  chunk: string,
  emitLine: (line: string) => void
) {
  const next = `${pending}${chunk}`;
  const lines = next.split(/\r?\n/u);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) {
      emitLine(line.trim());
    }
  }
  return rest;
}

function runStreamingEngineCommand(
  engine: ContainerEngineResolution,
  args: string[],
  onOutput: (event: { line: string; stream: "stdout" | "stderr" }) => void
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.command, args, {
      env: engine.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let pendingStdout = "";
    let pendingStderr = "";

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const flushPendingOutput = () => {
      const stdoutLine = pendingStdout.trim();
      if (stdoutLine) {
        onOutput({ line: stdoutLine, stream: "stdout" });
      }
      const stderrLine = pendingStderr.trim();
      if (stderrLine) {
        onOutput({ line: stderrLine, stream: "stderr" });
      }
      pendingStdout = "";
      pendingStderr = "";
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${engine.name} ${args.join(" ")} 执行超时。`)));
    }, IMAGE_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pendingStdout = collectOutputLines(pendingStdout, chunk, (line) => onOutput({ line, stream: "stdout" }));
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      pendingStderr = collectOutputLines(pendingStderr, chunk, (line) => onOutput({ line, stream: "stderr" }));
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      flushPendingOutput();
      if (code !== 0) {
        const detail = String(stderr || stdout).trim();
        finish(() => reject(new Error(detail || `${engine.name} ${args.join(" ")} 执行失败。`)));
        return;
      }
      finish(() => resolve({ stdout, stderr }));
    });
  });
}

function parseLoadedImageRef(output: string) {
  const match = output.match(/Loaded image:\s*([^\s]+)/u);
  return match?.[1]?.trim() || "";
}

function findBundledImageArchiveEntry(sourcePath: string) {
  let entries: Set<string>;
  try {
    entries = listArchiveEntries(sourcePath);
  } catch {
    return "";
  }
  const imageEntries = [...entries].filter((entry) =>
    /(^|\/)images\/[^/]+\.(?:tar\.gz|tgz|tar)$/iu.test(entry)
  );
  if (imageEntries.length === 0) {
    return "";
  }
  if (imageEntries.length > 1) {
    throw new Error("镜像包内只能包含一个 images/ 下的镜像归档。");
  }
  return imageEntries[0];
}

function prepareImageArchiveForImport(sourcePath: string): { archivePath: string; cleanup: () => void } {
  const entry = findBundledImageArchiveEntry(sourcePath);
  if (!entry) {
    return {
      archivePath: sourcePath,
      cleanup: () => {}
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sandbox-image-"));
  try {
    extractArchiveToDir(sourcePath, tempRoot);
    const archivePath = path.join(tempRoot, entry);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`镜像包内未找到镜像归档：${entry}`);
    }
    return {
      archivePath,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function mergeSandboxMarketItems(localItems: MarketItem[], environmentItems: MarketItem[]) {
  const merged = new Map<string, MarketItem>();
  for (const item of localItems) {
    merged.set(item.imageRef || item.id, item);
  }
  for (const item of environmentItems) {
    const key = item.imageRef || item.id;
    const local = merged.get(key);
    if (!local) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      ...item,
      ...local,
      description: item.description || local.description,
      tags: Array.from(new Set([...item.tags, ...local.tags])),
      buildStatus: item.buildStatus,
      buildJobId: item.buildJobId,
      buildTargetCount: item.buildTargetCount,
      environmentName: item.environmentName,
      serviceId: item.serviceId
    });
  }
  return [...merged.values()];
}

export async function listSandboxImageMarketItems(
  app: App,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const localImages = listLocalContainerImages();
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    if (localImages.engine) {
      return {
        items: localImages.items,
        offline: false,
        message: localImages.message
      };
    }
    return {
      items: [],
      offline: true,
      message: localImages.message || "沙箱镜像市场需要先启动 Container Hub。"
    };
  }

  try {
    const client = new ContainerHubClient(config);
    const environments = await client.listEnvironments();
    const environmentItems = environments
      .filter((environment) => environment.available)
      .map(sandboxEnvironmentToMarketItem);
    return {
      items: mergeSandboxMarketItems(localImages.items, environmentItems),
      offline: false,
      message: localImages.message
    };
  } catch (error) {
    if (localImages.engine) {
      return {
        items: localImages.items,
        offline: false,
        message: `Container Hub 暂不可用，仅显示本机镜像：${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      items: [],
      offline: true,
      message: `沙箱镜像市场暂不可用：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function buildSandboxImage(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const environmentName = itemId.trim();
  if (!environmentName) {
    throw new Error("缺少沙箱环境名称。");
  }
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    throw new Error("沙箱镜像构建需要先启动 Container Hub。");
  }
  const client = new ContainerHubClient(config);
  const job = await client.startBuildJob(environmentName);
  return {
    ok: true,
    itemId: environmentName,
    type: "sandbox-image",
    state: "installing",
    message: job.id ? `已开始构建 ${environmentName}。` : `已提交 ${environmentName} 构建。`,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    environmentName,
    imageRef: job.imageRef,
    buildJobId: job.id,
    buildStatus: job.status,
    buildTarget: job.target
  };
}

export async function importSandboxImageFromPath(
  _app: App,
  sourcePath: string,
  options: SandboxImageImportOptions = {}
): Promise<MarketCommandResult> {
  const archivePath = sourcePath.trim();
  if (!archivePath) {
    throw new Error("缺少沙箱镜像压缩文件路径。");
  }
  if (!fs.existsSync(archivePath)) {
    throw new Error(`沙箱镜像压缩文件不存在：${archivePath}`);
  }
  emitSandboxImageImportProgress(options, {
    stage: "checking-engine",
    message: "正在检查 Docker / Podman 容器引擎。"
  });
  const engine = resolveContainerEngine();
  if (!engine) {
    emitSandboxImageImportProgress(options, {
      stage: "failed",
      message: "导入沙箱镜像需要可用的 Docker 或 Podman。",
      done: true,
      ok: false
    });
    throw new Error("导入沙箱镜像需要可用的 Docker 或 Podman。");
  }

  const prepared = prepareImageArchiveForImport(archivePath);
  try {
    emitSandboxImageImportProgress(options, {
      stage: "archive-ready",
      message: "已准备好镜像归档。",
      archivePath: prepared.archivePath,
      engine: engine.name
    });
    emitSandboxImageImportProgress(options, {
      stage: "loading",
      message: `${engine.name} 正在导入沙箱镜像。`,
      archivePath: prepared.archivePath,
      engine: engine.name
    });
    const result = await runStreamingEngineCommand(
      engine,
      ["image", "load", "-i", prepared.archivePath],
      ({ line, stream }) => {
        emitSandboxImageImportProgress(options, {
          stage: "output",
          message: line,
          archivePath: prepared.archivePath,
          engine: engine.name,
          stream
        });
      }
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const imageRef = parseLoadedImageRef(output) || path.basename(prepared.archivePath);
    emitSandboxImageImportProgress(options, {
      stage: "done",
      message: `${engine.name} 已导入沙箱镜像${imageRef ? `：${imageRef}` : "。"}`,
      archivePath: prepared.archivePath,
      engine: engine.name,
      imageRef,
      done: true,
      ok: true
    });
    return {
      ok: true,
      itemId: imageRef,
      type: "sandbox-image",
      state: "installed",
      message: `${engine.name} 已导入沙箱镜像${imageRef ? `：${imageRef}` : "。"}`,
      serviceId: CONTAINER_HUB_SERVICE_ID,
      imageRef
    };
  } catch (error) {
    emitSandboxImageImportProgress(options, {
      stage: "failed",
      message: error instanceof Error ? error.message : String(error),
      archivePath: prepared.archivePath,
      engine: engine.name,
      done: true,
      ok: false
    });
    throw error;
  } finally {
    prepared.cleanup();
  }
}

export async function deleteSandboxImage(
  _app: App,
  itemId: string
): Promise<MarketCommandResult> {
  const imageRef = itemId.trim();
  if (!imageRef) {
    throw new Error("缺少沙箱镜像名称。");
  }
  const engine = resolveContainerEngine();
  if (!engine) {
    throw new Error("删除沙箱镜像需要可用的 Docker 或 Podman。");
  }

  await runEngineCommand(engine, ["image", "rm", imageRef]);
  return {
    ok: true,
    itemId: imageRef,
    type: "sandbox-image",
    state: "not-installed",
    message: `${engine.name} 已删除沙箱镜像：${imageRef}`,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    imageRef
  };
}

export async function exportSandboxImageToPath(
  _app: App,
  itemId: string,
  targetPath: string
): Promise<MarketCommandResult> {
  const imageRef = itemId.trim();
  if (!imageRef) {
    throw new Error("缺少沙箱镜像名称。");
  }
  const outputPath = targetPath.trim();
  if (!outputPath) {
    throw new Error("缺少沙箱镜像导出路径。");
  }
  const engine = resolveContainerEngine();
  if (!engine) {
    throw new Error("导出沙箱镜像需要可用的 Docker 或 Podman。");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runEngineCommand(engine, ["image", "save", "-o", outputPath, imageRef]);
  return {
    ok: true,
    itemId: imageRef,
    type: "sandbox-image",
    state: "installed",
    message: `${engine.name} 已导出沙箱镜像：${imageRef}`,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    imageRef,
    filePath: outputPath
  };
}

export const __sandboxImageMarketInternals = {
  resolveContainerHubConfig,
  sandboxEnvironmentToMarketItem
};
