import { type App } from "electron";
import { type ServiceLayout } from "./layout";
import { resolvePreferredAgentPlatformRuntimeRoot } from "./runtime-paths";
import { type DesktopServiceConfigResetContext } from "./desktop-config-upgrade";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { ServiceCommandKind, CORE_SERVICE_IDS } from "./manager-contracts";
import { getDesktopManagedCommandPort, getDesktopManagedContainerHubBindAddr } from "./host-policy";
import { getDesktopSsoAccessTokenFilePath } from "../../../infrastructure/filesystem/user-paths";

export function appendAgentPlatformDesktopDeployArgs(
  command: string[],
  app: App,
  layout: ServiceLayout,
  containerHubBaseUrl: string,
  publicKeySourceFile: string
) {
  return [
    ...command,
    "--output-dir", layout.configDir,
    "--ap-runtime-dir", resolvePreferredAgentPlatformRuntimeRoot(app),
    "--container-hub-base-url", containerHubBaseUrl,
    "--public-key-source-file", publicKeySourceFile
  ];
}

export function appendAgentContainerHubDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendIdentityCenterDesktopDeployArgs(command: string[], layout: ServiceLayout) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendAgentWebclientDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendDesktopConfigResetDeployArgs(
  command: string[],
  context: DesktopServiceConfigResetContext | undefined
) {
  if (!context || context.desktopConfigReset === false) {
    return command;
  }
  return [
    ...command,
    "--desktop-config-reset",
    "--desktop-config-backup-dir", context.backupDir,
    "--desktop-version-from", context.fromVersion,
    "--desktop-version-to", context.toVersion
  ];
}

export function appendAgentPlatformRuntimeResourceDeployArgs(
  command: string[],
  service: ServiceDefinition,
  context: DesktopServiceConfigResetContext | undefined,
  desktopDeviceId: string
) {
  if (!context?.runtimeResourceSource) {
    return command;
  }
  if (service.desktop.runtimeResources !== "v1") {
    throw new Error(
      "agent-platform bundle does not declare desktop.runtimeResources=v1; install a current Platform bundle before Desktop env upgrade."
    );
  }
  const normalizedDeviceId = desktopDeviceId.trim();
  if (!normalizedDeviceId) {
    throw new Error("agent-platform runtime resource migration requires a Desktop device id.");
  }
  return [
    ...command,
    ...(context.desktopConfigReset === false
      ? [
          "--desktop-version-from", context.fromVersion,
          "--desktop-version-to", context.toVersion
        ]
      : []),
    "--runtime-resource-source", context.runtimeResourceSource,
    ...(context.runtimeResourcePreviousSource
      ? ["--runtime-resource-previous-source", context.runtimeResourcePreviousSource]
      : []),
    "--runtime-resource-mode", context.runtimeResourceMode ?? "version-change",
    "--desktop-device-id", normalizedDeviceId
  ];
}

export function appendDesktopManagedLayoutFlags(
  app: App,
  service: ServiceDefinition,
  command: string[],
  layout: ServiceLayout,
  kind: ServiceCommandKind
) {
  if (service.id === "agent-platform") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--port", String(getDesktopManagedCommandPort(service)),
      "--identity-file", getDesktopSsoAccessTokenFilePath(app)
    ];
  }

  if (service.id === "agent-container-hub") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--data-dir", layout.dataDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--bind-addr", getDesktopManagedContainerHubBindAddr(service)
    ];
  }

  if (service.id === "identity-center") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--data-dir", layout.dataDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--port", String(getDesktopManagedCommandPort(service))
    ];
  }

  if (service.id === "agent-webclient" && kind === "deploy") {
    return command;
  }

  return command;
}

export function isDaemonStartArg(value: string) {
  return value.trim().toLowerCase() === "--daemon" || value.trim().toLowerCase() === "-daemon";
}

export function getDesktopStartCommand(service: Pick<ServiceDefinition, "id" | "kind" | "startCommand">) {
  if (service.kind !== "builtin" || !CORE_SERVICE_IDS.has(service.id)) {
    return service.startCommand;
  }

  let command = [...service.startCommand];
  if (service.id === "agent-platform") {
    const withoutRuntimeMode: string[] = [];
    for (let index = 0; index < command.length; index += 1) {
      const arg = command[index];
      if (arg === "--runtime-mode") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--runtime-mode=")) continue;
      withoutRuntimeMode.push(arg);
    }
    command = withoutRuntimeMode;
    const daemonIndex = command.findIndex(isDaemonStartArg);
    if (daemonIndex >= 0) command.splice(daemonIndex, 0, "--runtime-mode=desktop");
    else command.push("--runtime-mode=desktop");
  }
  if (!command.some(isDaemonStartArg)) {
    command.push("--daemon");
  }
  return command;
}
