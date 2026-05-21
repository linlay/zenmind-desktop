import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketInstallState, MarketItem } from "../../shared/contracts";
import { ContainerHubClient, type ContainerHubConfig, type ContainerHubEnvironment } from "../copilot/core/container-hub";
import { readEnvFile } from "../env-file";
import { getServiceState } from "../services/manager";
import {
  asString,
  normalizeContainerHubBaseUrl,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const CONTAINER_HUB_SERVICE_ID = "agent-container-hub";

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

export async function listSandboxImageMarketItems(
  app: App,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    return {
      items: [],
      offline: true,
      message: "沙箱镜像市场需要先启动 Container Hub。"
    };
  }

  try {
    const client = new ContainerHubClient(config);
    const environments = await client.listEnvironments();
    return {
      items: environments.map(sandboxEnvironmentToMarketItem),
      offline: false,
      message: ""
    };
  } catch (error) {
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

export const __sandboxImageMarketInternals = {
  resolveContainerHubConfig,
  sandboxEnvironmentToMarketItem
};
