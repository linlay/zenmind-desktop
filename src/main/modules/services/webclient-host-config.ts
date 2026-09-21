import { type ManifestDesktopHosting, type ManifestDesktopProxyRoute, DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING } from "../../../shared/contracts";
import { type ServiceDefinition } from "../../support/manifest/manifest-utils";
import { HostManagedDesktopHosting, AgentWebclientHostConfig, AgentWebclientHostRecord } from "./webclient-host-types";
import { type ServiceLayout } from "./manager/layout";
import path from "node:path";
import fs from "node:fs";
import { readEnvFile } from "../../infrastructure/filesystem/env-file";

export function normalizeEnvUrl(value: string | undefined, fallback?: string) {
  const raw = String(value ?? "").trim() || fallback || "";
  return raw ? new URL(raw) : null;
}

export function normalizeRoutePath(routePath: string | undefined, fallback = "/") {
  const trimmed = String(routePath ?? "").trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function cloneDesktopHosting(hosting: ManifestDesktopHosting): ManifestDesktopHosting {
  return {
    ...(hosting.runtimeConfig
      ? {
          runtimeConfig: {
            ...(hosting.runtimeConfig.path === undefined ? {} : { path: hosting.runtimeConfig.path }),
            ...(hosting.runtimeConfig.envKeys === undefined ? {} : { envKeys: [...hosting.runtimeConfig.envKeys] })
          }
        }
      : {}),
    ...(hosting.spaRoutes === undefined ? {} : { spaRoutes: [...hosting.spaRoutes] }),
    ...(hosting.proxyRoutes === undefined
      ? {}
      : {
          proxyRoutes: hosting.proxyRoutes.map((route) => ({
            ...route,
            ...(route.ssePaths === undefined ? {} : { ssePaths: [...route.ssePaths] }),
            ...(route.stripRequestHeaders === undefined ? {} : { stripRequestHeaders: [...route.stripRequestHeaders] }),
            ...(route.disabledResponse === undefined
              ? {}
              : {
                  disabledResponse: {
                    ...route.disabledResponse
                  }
                })
          }))
        })
  };
}

export function sortProxyRoutes(routes: ManifestDesktopProxyRoute[]) {
  return [...routes].sort((left, right) => {
    if (left.match !== right.match) {
      return left.match === "exact" ? -1 : 1;
    }
    return right.path.length - left.path.length;
  });
}

export function normalizeDesktopHosting(service: ServiceDefinition): HostManagedDesktopHosting {
  const serviceHosting = service.desktop?.hosting;
  const hosting = cloneDesktopHosting(
    serviceHosting || (
      service.id === "agent-webclient" && service.frontend.hostManaged === true
        ? DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
        : {}
    )
  );

  const defaultRuntimeConfig = DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING.runtimeConfig;
  return {
    runtimeConfigPath: normalizeRoutePath(hosting.runtimeConfig?.path, defaultRuntimeConfig?.path || "/runtime-config.js"),
    runtimeConfigEnvKeys: hosting.runtimeConfig?.envKeys?.length
      ? [...hosting.runtimeConfig.envKeys]
      : [...(defaultRuntimeConfig?.envKeys || [])],
    spaRoutePrefixes: hosting.spaRoutes?.map((routePath) => normalizeRoutePath(routePath)).filter(Boolean) || [],
    proxyRoutes: sortProxyRoutes(
      (hosting.proxyRoutes || []).map((route) => ({
        ...route,
        path: normalizeRoutePath(route.path),
        ssePaths: route.ssePaths?.map((routePath) => normalizeRoutePath(routePath)).filter(Boolean),
        stripRequestHeaders: route.stripRequestHeaders?.map((header) => header.trim()).filter(Boolean)
      }))
    )
  };
}

export function getFrontendDist(service: ServiceDefinition, layout: ServiceLayout) {
  const relativeDist = service.frontend.dist || path.join("frontend", "dist");
  return path.resolve(layout.programDir, relativeDist);
}

export function getFrontendIndex(service: ServiceDefinition, frontendDist: string) {
  return path.resolve(frontendDist, service.frontend.index || "index.html");
}

export function assertHostConfig(config: AgentWebclientHostConfig) {
  if (!config.port || config.port <= 0 || config.port > 65535) {
    throw new Error("agent-webclient host requires a valid port.");
  }
  const frontendDist = getFrontendDist(config.service, config.layout);
  const indexFile = getFrontendIndex(config.service, frontendDist);
  if (!fs.existsSync(indexFile)) {
    throw new Error(`agent-webclient frontend index.html not found: ${indexFile}`);
  }
  return { frontendDist, indexFile };
}

export function getEnvValue(record: AgentWebclientHostRecord, env: Map<string, string>, key: string) {
  return record.envOverrides.get(key) ?? env.get(key) ?? record.env.get(key);
}

export function resolveRouteTarget(record: AgentWebclientHostRecord, route: ManifestDesktopProxyRoute) {
  return normalizeEnvUrl(record.envOverrides.get(route.targetEnv) ?? record.env.get(route.targetEnv));
}

export function resolveRouteTargetFromEnv(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  env: Map<string, string>
) {
  return normalizeEnvUrl(getEnvValue(record, env, route.targetEnv));
}

export function isVoiceEnabled(record: AgentWebclientHostRecord, env: Map<string, string>) {
  return record.hosting.proxyRoutes.some((route) =>
    route.targetEnv === "VOICE_BASE_URL" && Boolean(resolveRouteTargetFromEnv(record, route, env))
  );
}

export function readRuntimeConfig(record: AgentWebclientHostRecord) {
  const currentEnv = readEnvFile(record.layout.envPath);
  const runtimeConfig = record.hosting.runtimeConfigEnvKeys.reduce<Record<string, string>>((result, key) => {
    result[key] = String(getEnvValue(record, currentEnv, key) ?? "").trim();
    return result;
  }, {});
  runtimeConfig.VOICE_ENABLED = String(isVoiceEnabled(record, currentEnv));
  return runtimeConfig;
}

export function createRuntimeConfigScript(runtimeConfig: Record<string, string>) {
  return `globalThis.__AGENT_WEBCLIENT_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;
}
