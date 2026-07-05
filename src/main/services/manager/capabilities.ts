import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  ManifestCommand,
  ManifestDesktopCapabilityProvider,
  ServiceId
} from "../../../shared/contracts";
import { getDesktopDeviceInfo } from "../../desktop-device-info";
import { getDesktopDeviceId } from "../../device-identity";
import { readEnvFile } from "../../env-file";
import type { ServiceDefinition } from "../../manifest-utils";
import { getAllServices } from "../service-registry";
import { runExecFile, type ExecResult } from "./command-runner";
import {
  getServiceLayout,
  type ServiceLayout
} from "./layout";
import { t } from "../../i18n/main-i18n";

const SQLITE_BUSY_RETRY_DELAYS_MS = [150, 350, 700, 1_200];
const AUTH_PUBLIC_KEY_SIDECAR_FILE_NAMES = ["jwk-private.pem", "jwk-public.pem"] as const;
const DESKTOP_CAPABILITY_PROVIDER_PRIORITY: Record<string, ServiceId[]> = {
  "auth.publicKey": ["identity-center"],
  "auth.accessToken": ["identity-center"]
};

export type DesktopCapabilityResult = {
  id: string;
  providerServiceId: ServiceId;
  output: "file" | "stdoutLastLine";
  filePath?: string;
  text?: string;
  token?: string;
};

type ResolveDesktopCapabilityOptions = {
  ensureProviderInstall?: (service: ServiceDefinition) => Promise<void>;
  stack?: string[];
};

const pendingCapabilityResolutions = new Map<string, Promise<DesktopCapabilityResult>>();

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function removeFileIfExists(targetPath: string) {
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      fs.unlinkSync(targetPath);
    }
  } catch {
    // Best-effort cleanup only; capability validation below still reports missing outputs.
  }
}

function normalizeCommand(command: ManifestCommand | undefined) {
  if (!command) {
    return null;
  }
  const parts = Array.isArray(command) ? command : [command];
  const normalizedParts = parts.map((part) => part.trim()).filter(Boolean);
  if (normalizedParts.length === 0) {
    return null;
  }
  const [entry, ...args] = normalizedParts;
  const normalizedEntry =
    path.isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")
      ? entry
      : `./${entry}`;
  return [normalizedEntry, ...args];
}

function commandForCurrentPlatform(provider: ManifestDesktopCapabilityProvider) {
  if (process.platform === "win32") {
    return normalizeCommand(provider.windowsCommand ?? provider.command);
  }
  if (process.platform === "darwin") {
    return normalizeCommand(provider.darwinCommand ?? provider.command);
  }
  if (process.platform === "linux") {
    return normalizeCommand(provider.linuxCommand ?? provider.command);
  }
  return normalizeCommand(provider.command);
}

function parsePortValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  if (/^\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const portMatch = /:(\d+)(?:[/\s]|$)/u.exec(trimmed);
  return portMatch ? Number.parseInt(portMatch[1], 10) : 0;
}

function readAuthSettings(service: ServiceDefinition, layout: ServiceLayout) {
  const env = readEnvFile(layout.envPath);
  const port = parsePortValue(env.get(service.web.portEnvKey) ?? "") || service.web.defaultPort;
  const configuredDBPath = env.get("AUTH_DB_PATH")?.trim() ?? "";
  return {
    dbPath: configuredDBPath && path.isAbsolute(configuredDBPath)
      ? configuredDBPath
      : path.join(layout.dataDir, "auth.db"),
    issuer: env.get("AUTH_ISSUER")?.trim() || `http://127.0.0.1:${port}`,
    username: env.get("AUTH_APP_USERNAME")?.trim() || "app"
  };
}

function findCapabilityProvider(capabilityId: string) {
  const matches: Array<{ service: ServiceDefinition; provider: ManifestDesktopCapabilityProvider }> = [];
  for (const service of getAllServices()) {
    const provider = service.desktop.capabilities.provides.find((item) => item.id === capabilityId);
    if (provider) {
      matches.push({ service, provider });
    }
  }
  if (matches.length === 0) {
    throw new Error(`missing Desktop capability provider: ${capabilityId}`);
  }
  if (matches.length > 1) {
    for (const serviceId of DESKTOP_CAPABILITY_PROVIDER_PRIORITY[capabilityId] ?? []) {
      const preferred = matches.find((match) => match.service.id === serviceId);
      if (preferred) {
        return preferred;
      }
    }
    throw new Error(
      `ambiguous Desktop capability provider ${capabilityId}: ${matches.map((match) => match.service.id).join(", ")}`
    );
  }
  return matches[0];
}

function buildTemplateValues(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  provider: ManifestDesktopCapabilityProvider
) {
  const auth = readAuthSettings(service, layout);
  const desktopDeviceName = getDesktopDeviceInfo(app).deviceName;
  const outputPath = provider.outputPath
    ? path.normalize(renderTemplate(provider.outputPath, {
      "provider.programDir": layout.programDir,
      "provider.configDir": layout.configDir,
      "provider.dataDir": layout.dataDir,
      "provider.stateDir": layout.stateDir,
      "provider.logDir": layout.logDir,
      "auth.dbPath": auth.dbPath,
      "auth.issuer": auth.issuer,
      "auth.username": auth.username,
      "desktop.deviceId": getDesktopDeviceId(app),
      "desktop.deviceName": desktopDeviceName
    }))
    : "";

  const values: Record<string, string> = {
    "provider.programDir": layout.programDir,
    "provider.configDir": layout.configDir,
    "provider.dataDir": layout.dataDir,
    "provider.stateDir": layout.stateDir,
    "provider.logDir": layout.logDir,
    "provider.envPath": layout.envPath,
    "auth.dbPath": auth.dbPath,
    "auth.issuer": auth.issuer,
    "auth.username": auth.username,
    "desktop.deviceId": getDesktopDeviceId(app),
    "desktop.deviceName": desktopDeviceName,
    "output.path": outputPath,
    "output.dir": outputPath ? path.dirname(outputPath) : ""
  };

  const env = readEnvFile(layout.envPath);
  for (const [key, value] of env) {
    values[`provider.env.${key}`] = value;
  }
  return values;
}

function renderTemplate(value: string, values: Record<string, string>) {
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

function renderStringRecord(record: Record<string, string> | undefined, values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [key, renderTemplate(value, values)])
  );
}

function renderCommand(command: string[], values: Record<string, string>) {
  return command.map((part) => renderTemplate(part, values));
}

function cleanupDesktopCapabilitySidecars(
  provider: ManifestDesktopCapabilityProvider,
  values: Record<string, string>
) {
  if (provider.id !== "auth.publicKey") {
    return;
  }
  const outputPath = values["output.path"];
  if (!outputPath) {
    return;
  }
  const outputDir = path.dirname(outputPath);
  for (const fileName of AUTH_PUBLIC_KEY_SIDECAR_FILE_NAMES) {
    removeFileIfExists(path.join(outputDir, fileName));
  }
}

function isSqliteBusyError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /database is locked|SQLITE_BUSY|sqlite_busy|locking protocol|Error:\s*stepping,\s*database is locked|\(5\)/iu.test(message);
}

function isUnsupportedDeviceIdArgumentError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /unknown argument:\s*(?:--device-id|-DeviceId)|unrecognized (?:option|argument).*?(?:--device-id|-DeviceId)|(?:parameter cannot be found|\u627e\u4e0d\u5230\u4e0e\u53c2\u6570\u540d\u79f0).*?(?:--device-id|-DeviceId|DeviceId)/iu.test(message);
}

function removeDeviceIdArgs(command: string[]) {
  const next: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index];
    if (part === "--device-id" || part === "-DeviceId") {
      index += 1;
      continue;
    }
    next.push(part);
  }
  return next;
}

async function runCapabilityCommand(
  provider: ManifestDesktopCapabilityProvider,
  layout: ServiceLayout,
  command: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await runExecFile(command[0], command.slice(1), layout.programDir, {
        env: {
          ...Object.fromEntries(readEnvFile(layout.envPath)),
          ...env
        }
      });
    } catch (reason) {
      lastError = reason;
      if (!provider.retryOnSqliteBusy || !isSqliteBusyError(reason) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) {
        throw reason;
      }
      await delay(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function readJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    throw new Error("Desktop capability returned an invalid JWT access token.");
  }
  try {
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Desktop capability returned an unreadable JWT payload.");
  }
}

function validateJwtDeviceId(token: string, desktopDeviceId: string, exact: boolean) {
  const payload = readJwtPayload(token);
  const tokenDeviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (exact && tokenDeviceId !== desktopDeviceId) {
    throw new Error(t("service.capabilityDeviceMismatch"));
  }
  if (!exact && !tokenDeviceId) {
    throw new Error(t("service.capabilityDeviceMissing"));
  }
}

function getCapabilityCacheKey(app: App, capabilityId: string) {
  const appScope = (() => {
    try {
      return app.getPath("userData");
    } catch {
      return "unknown-user-data";
    }
  })();
  return `${appScope}\0${capabilityId}`;
}

async function resolveDesktopCapabilityInternal(
  app: App,
  capabilityId: string,
  options: ResolveDesktopCapabilityOptions = {}
): Promise<DesktopCapabilityResult> {
  const stack = options.stack ?? [];
  if (stack.includes(capabilityId)) {
    throw new Error(`Desktop capability dependency cycle: ${[...stack, capabilityId].join(" -> ")}`);
  }

  const { service, provider } = findCapabilityProvider(capabilityId);
  await options.ensureProviderInstall?.(service);
  const layout = getServiceLayout(app, service);
  if (!fs.existsSync(layout.programDir)) {
    throw new Error(t("service.capabilityProviderNotInstalled", { serviceId: service.id, capabilityId }));
  }

  for (const dependency of provider.dependsOn ?? []) {
    await resolveDesktopCapabilityWithPending(app, dependency, {
      ...options,
      stack: [...stack, capabilityId]
    });
  }

  const command = commandForCurrentPlatform(provider);
  if (!command) {
    throw new Error(t("service.capabilityPlatformCommandMissing", { serviceId: service.id, capabilityId }));
  }

  const values = buildTemplateValues(app, service, layout, provider);
  const renderedCommand = renderCommand(command, values);
  const renderedEnv = renderStringRecord(provider.env, values);
  const auth = readAuthSettings(service, layout);
  ensureDir(path.dirname(auth.dbPath));
  if (values["output.dir"]) {
    ensureDir(values["output.dir"]);
  }

  let result: ExecResult;
  let validateExactDeviceId = true;
  try {
    result = await runCapabilityCommand(provider, layout, renderedCommand, renderedEnv);
  } catch (reason) {
    if (!provider.allowDeviceIdFallback || !isUnsupportedDeviceIdArgumentError(reason)) {
      throw reason;
    }
    validateExactDeviceId = false;
    result = await runCapabilityCommand(provider, layout, removeDeviceIdArgs(renderedCommand), renderedEnv);
  } finally {
    cleanupDesktopCapabilitySidecars(provider, values);
  }

  const output = provider.output ?? "stdoutLastLine";
  if (output === "file") {
    const filePath = values["output.path"];
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`${service.id} capability ${capabilityId} did not produce file output: ${filePath || "(empty)"}`);
    }
    return {
      id: capabilityId,
      providerServiceId: service.id,
      output,
      filePath,
      text: fs.readFileSync(filePath, "utf8")
    };
  }

  const text = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)?.trim() ?? "";
  if (!text) {
    throw new Error(`${service.id} capability ${capabilityId} did not produce stdout output.`);
  }
  if (provider.validateJwtDeviceId) {
    validateJwtDeviceId(text, getDesktopDeviceId(app), validateExactDeviceId);
  }
  return {
    id: capabilityId,
    providerServiceId: service.id,
    output,
    text,
    token: text
  };
}

async function resolveDesktopCapabilityWithPending(
  app: App,
  capabilityId: string,
  options: ResolveDesktopCapabilityOptions = {}
) {
  if (options.stack?.includes(capabilityId)) {
    throw new Error(`Desktop capability dependency cycle: ${[...options.stack, capabilityId].join(" -> ")}`);
  }
  const cacheKey = getCapabilityCacheKey(app, capabilityId);
  const pending = pendingCapabilityResolutions.get(cacheKey);
  if (pending) {
    return pending;
  }

  const task = resolveDesktopCapabilityInternal(app, capabilityId, options).finally(() => {
    if (pendingCapabilityResolutions.get(cacheKey) === task) {
      pendingCapabilityResolutions.delete(cacheKey);
    }
  });
  pendingCapabilityResolutions.set(cacheKey, task);
  return task;
}

export async function resolveDesktopCapability(
  app: App,
  capabilityId: string,
  options: ResolveDesktopCapabilityOptions = {}
) {
  return resolveDesktopCapabilityWithPending(app, capabilityId, options);
}

export const __testInternals = {
  buildTemplateValues,
  commandForCurrentPlatform,
  isSqliteBusyError,
  isUnsupportedDeviceIdArgumentError,
  removeDeviceIdArgs,
  renderTemplate
};
