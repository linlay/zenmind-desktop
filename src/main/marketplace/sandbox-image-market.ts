import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
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
  buildContainerEngineInvocation,
  resolveContainerEngine
} from "../container-engine";
import { ContainerHubClient, type ContainerHubConfig, type ContainerHubEnvironment } from "../copilot/core/container-hub";
import { extractArchiveToDir, listArchiveEntries } from "../archive-utils";
import { readEnvFile } from "../env-file";
import { getResponsiveServiceState } from "../services/manager";
import { t } from "../i18n/main-i18n";
import {
  asString,
  normalizeContainerHubBaseUrl,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const CONTAINER_HUB_SERVICE_ID = "agent-container-hub";
const IMAGE_COMMAND_TIMEOUT_MS = 300_000;
const LIST_IMAGE_COMMAND_TIMEOUT_MS = 30_000;
const CONTAINER_ENGINE_CACHE_SUCCESS_MS = 30_000;
const CONTAINER_ENGINE_CACHE_MISS_MS = 10_000;

let cachedContainerEngine:
  | { engine: ContainerEngineResolution | null; expiresAt: number; cacheKey: string }
  | null = null;

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

function sandboxImageImportedMessage(engineName: string, imageRef: string) {
  return imageRef
    ? t("market.sandbox.importedWithRef", { engine: engineName, imageRef })
    : t("market.sandbox.imported", { engine: engineName });
}

async function resolveContainerHubConfig(app: App, options: MarketplaceOptions = {}): Promise<ContainerHubConfig | null> {
  if (options.containerHubBaseUrl !== undefined) {
    return {
      baseURL: normalizeContainerHubBaseUrl(options.containerHubBaseUrl),
      authToken: asString(options.containerHubAuthToken).trim() || undefined
    };
  }

  try {
    const state = await getResponsiveServiceState(app, CONTAINER_HUB_SERVICE_ID);
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
    environment.enabled ? t("market.sandbox.environmentEnabled") : t("market.sandbox.environmentDisabled"),
    environment.availableBuildTargets.length > 0
      ? t("market.sandbox.buildTargetCount", { count: environment.availableBuildTargets.length })
      : null,
    environment.lastBuild?.target ? t("market.sandbox.buildTarget", { target: environment.lastBuild.target }) : null
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
      ? environment.lastBuild?.status || t("market.sandbox.buildFailed")
      : state === "installing" ? t("market.sandbox.imageBuilding") : undefined
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
    image.size ? t("market.sandbox.imageSize", { size: image.size }) : null,
    image.createdAt ? t("market.sandbox.imageCreated", { createdAt: image.createdAt }) : null
  ].filter((tag): tag is string => Boolean(tag));

  return {
    id: imageRef,
    type: "sandbox-image",
    name: image.repository,
    version: image.tag || "latest",
    description: t("market.sandbox.localImageDescription"),
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

function resolveCachedContainerEngine() {
  const now = Date.now();
  const cacheKey = [
    process.platform,
    process.env.PATH ?? "",
    process.env.Path ?? "",
    process.env.DESKTOP_CONTAINER_ENGINE_PATHS ?? "",
    process.env.ZENMIND_CONTAINER_ENGINE_PATHS ?? "",
    process.env.ProgramFiles ?? "",
    process.env.LOCALAPPDATA ?? ""
  ].join("\u0000");
  if (
    cachedContainerEngine &&
    cachedContainerEngine.cacheKey === cacheKey &&
    cachedContainerEngine.expiresAt > now
  ) {
    return cachedContainerEngine.engine;
  }
  const engine = resolveContainerEngine();
  cachedContainerEngine = {
    engine,
    expiresAt: now + (engine ? CONTAINER_ENGINE_CACHE_SUCCESS_MS : CONTAINER_ENGINE_CACHE_MISS_MS),
    cacheKey
  };
  return engine;
}

async function listLocalContainerImages(): Promise<{
  engine: ContainerEngineResolution | null;
  items: MarketItem[];
  message: string;
}> {
  const engine = resolveCachedContainerEngine();
  if (!engine) {
    return {
      engine: null,
      items: [],
      message: t("market.sandbox.noEngine")
    };
  }

  try {
    const result = await runEngineCommand(engine, [
      "image",
      "ls",
      "--format",
      "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}"
    ], LIST_IMAGE_COMMAND_TIMEOUT_MS);
    return {
      engine,
      items: parseContainerImageList(result.stdout).map((image) => localContainerImageToMarketItem(image, engine.name)),
      message: ""
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      engine,
      items: [],
      message: detail || t("market.sandbox.engineCommandFailed", { engine: engine.name, command: "image ls" })
    };
  }
}

function runEngineCommand(
  engine: ContainerEngineResolution,
  args: string[],
  timeoutMs = IMAGE_COMMAND_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  const invocation = buildContainerEngineInvocation(engine, args);
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, {
      encoding: "utf8",
      env: engine.env,
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || t("market.sandbox.engineCommandFailed", { engine: engine.name, command: args.join(" ") })));
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
  const invocation = buildContainerEngineInvocation(engine, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: engine.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
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
      finish(() => reject(new Error(t("market.sandbox.engineCommandTimeout", { engine: engine.name, command: args.join(" ") }))));
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
        finish(() => reject(new Error(detail || t("market.sandbox.engineCommandFailed", { engine: engine.name, command: args.join(" ") }))));
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
    throw new Error(t("market.sandbox.multipleBundledArchives"));
  }
  return imageEntries[0];
}

async function prepareImageArchiveForImport(sourcePath: string): Promise<{ archivePath: string; cleanup: () => void }> {
  const entry = findBundledImageArchiveEntry(sourcePath);
  if (!entry) {
    return {
      archivePath: sourcePath,
      cleanup: () => {}
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sandbox-image-"));
  try {
    await extractArchiveToDir(sourcePath, tempRoot);
    const archivePath = path.join(tempRoot, entry);
    if (!fs.existsSync(archivePath)) {
      throw new Error(t("market.sandbox.bundledArchiveMissing", { entry }));
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
  const [localImages, config] = await Promise.all([
    listLocalContainerImages(),
    resolveContainerHubConfig(app, options)
  ]);
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
      message: localImages.message || t("market.sandbox.requiresContainerHub")
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
        message: t("market.sandbox.hubUnavailableLocalOnly", { reason: error instanceof Error ? error.message : String(error) })
      };
    }
    return {
      items: [],
      offline: true,
      message: t("market.sandbox.unavailable", { reason: error instanceof Error ? error.message : String(error) })
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
    throw new Error(t("market.sandbox.missingEnvironmentName"));
  }
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    throw new Error(t("market.sandbox.buildRequiresContainerHub"));
  }
  const client = new ContainerHubClient(config);
  const job = await client.startBuildJob(environmentName);
  return {
    ok: true,
    itemId: environmentName,
    type: "sandbox-image",
    state: "installing",
    message: job.id
      ? t("market.sandbox.buildStarted", { environmentName })
      : t("market.sandbox.buildSubmitted", { environmentName }),
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
    throw new Error(t("market.sandbox.missingArchivePath"));
  }
  if (!fs.existsSync(archivePath)) {
    throw new Error(t("market.sandbox.archiveMissing", { archivePath }));
  }
  emitSandboxImageImportProgress(options, {
    stage: "checking-engine",
    message: t("market.sandbox.checkingEngine")
  });
  const engine = resolveContainerEngine();
  if (!engine) {
    emitSandboxImageImportProgress(options, {
      stage: "failed",
      message: t("market.sandbox.importRequiresEngine"),
      done: true,
      ok: false
    });
    throw new Error(t("market.sandbox.importRequiresEngine"));
  }

  const prepared = await prepareImageArchiveForImport(archivePath);
  try {
    emitSandboxImageImportProgress(options, {
      stage: "archive-ready",
      message: t("market.sandbox.archiveReady"),
      archivePath: prepared.archivePath,
      engine: engine.name
    });
    emitSandboxImageImportProgress(options, {
      stage: "loading",
      message: t("market.sandbox.importingEngine", { engine: engine.name }),
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
      message: sandboxImageImportedMessage(engine.name, imageRef),
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
      message: sandboxImageImportedMessage(engine.name, imageRef),
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
    throw new Error(t("market.sandbox.missingImageName"));
  }
  const engine = resolveContainerEngine();
  if (!engine) {
    throw new Error(t("market.sandbox.deleteRequiresEngine"));
  }

  await runEngineCommand(engine, ["image", "rm", imageRef]);
  return {
    ok: true,
    itemId: imageRef,
    type: "sandbox-image",
    state: "not-installed",
    message: t("market.sandbox.deleted", { engine: engine.name, imageRef }),
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
    throw new Error(t("market.sandbox.missingImageName"));
  }
  const outputPath = targetPath.trim();
  if (!outputPath) {
    throw new Error(t("market.sandbox.missingExportPath"));
  }
  const engine = resolveContainerEngine();
  if (!engine) {
    throw new Error(t("market.sandbox.exportRequiresEngine"));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runEngineCommand(engine, ["image", "save", "-o", outputPath, imageRef]);
  return {
    ok: true,
    itemId: imageRef,
    type: "sandbox-image",
    state: "installed",
    message: t("market.sandbox.exported", { engine: engine.name, imageRef }),
    serviceId: CONTAINER_HUB_SERVICE_ID,
    imageRef,
    filePath: outputPath
  };
}

export const __sandboxImageMarketInternals = {
  resolveContainerHubConfig,
  sandboxEnvironmentToMarketItem
};
