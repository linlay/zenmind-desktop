import fs from "node:fs";

import http from "node:http";

import net from "node:net";

import path from "node:path";

import type { ChildProcess } from "node:child_process";

import type { App } from "electron";

import type {
  DesktopWebappChangedReason,
  WebappCommandResult,
  WebappEntry,
  WebappLauncherKind,
  WebappLogReadOptions,
  WebappLogReadResult,
  WebappLogTarget,
  WebappRuntimeCheckResult,
  WebappRuntimeState
} from "../../../../shared/contracts";

import type { WebappBridgeCapability } from "../../../../shared/webapp-bridge";

import { readServiceLogFile } from "../../../support/logging/service-logs";

import {
  isProcessRunning,
  listProcessTreePidsAsync,
  requestWindowsProcessTreeExitAsync,
  terminateCapturedProcessTreeAsync,
  terminateProcessTree
} from "../../services";

import {
  matchProcessInstallDirAsync,
  pidMatchesInstallDir,
} from "../../services";

import { delay, probeHttpUrl } from "../../services";

import {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsStateRoot
} from "../../../infrastructure/filesystem/user-paths";

import { t } from "../../../support/i18n/main-i18n";

import { startWebappGateway, type WebappGateway } from "./gateway";

import {
  checkWebappBackendPrerequisites,
  getWebappBackendLauncher,
  type WebappLauncherCheck,
  type WebappLauncherContext
} from "./launchers";

import {
  issueWebappActionToken,
  revokeWebappActionToken
} from "./action-tokens";

import { getWebappAllowedActions } from "./capability-policy";

import { getWebappDir, readWebappItems } from "./store";
import type { WebsIntegrationPorts } from "../integration-ports";

import { syncPublishedWebappRoute } from "./publisher";

import { HEALTH_MONITOR_FAILURE_THRESHOLD, HEALTH_MONITOR_INTERVAL_MS, HOST, RuntimeRecord, createBaseState, createLauncherContext, createStoppedState, findWebapp, getLogPath, launcherForItem, listStoredRuntimeStates, nowIso, pipeChildLogs, prerequisiteMessage, probeBackendHealthOnce, readStoredState, readStoredStateById, reservePort, revokeRecordActionTokens, shouldIssueBackendActionToken, stopRecordHealthMonitor, terminateRuntimeChild, terminateRuntimeProcessTree, waitForBackendHealth, writeLogLine, writeState } from "./runtime.part-1";

export class WebappRuntime {
  private readonly records = new Map<string, RuntimeRecord>();
  private publicationChangeListener: ((reason: DesktopWebappChangedReason, webappId: string) => void) | null = null;

  constructor(private readonly integrationPorts?: WebsIntegrationPorts) {}

  setPublicationChangeListener(
    listener: ((reason: DesktopWebappChangedReason, webappId: string) => void) | null
  ) {
    this.publicationChangeListener = listener;
  }

  emitLifecycleChange(reason: DesktopWebappChangedReason, webappId: string) {
    try {
      this.publicationChangeListener?.(reason, webappId);
    } catch (error) {
      console.warn(
        `[webapp] failed to emit ${reason} for ${webappId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  allowsLocalPageCapability(rawUrl: string, _capability: WebappBridgeCapability) {
    let origin = "";
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return false;
    }
    return [...this.records.values()].some((record) => {
      if (record.state.status !== "running") {
        return false;
      }
      try {
        return new URL(record.state.webUrl).origin === origin;
      } catch {
        return false;
      }
    });
  }

  private syncPublishedRoute(app: App, item: WebappEntry, state: WebappRuntimeState) {
    void syncPublishedWebappRoute(app, item, state, this.integrationPorts).then((publishState) => {
      if (!publishState?.active) {
        return;
      }
      this.publicationChangeListener?.(
        publishState.status === "published" ? "route-synced" : "publish-failed",
        item.id
      );
    });
  }

  private startHealthMonitor(app: App, record: RuntimeRecord) {
    if (!record.item.backend || !record.state.backendUrl) {
      return;
    }
    stopRecordHealthMonitor(record);
    record.healthTimer = setInterval(() => {
      if (record.healthProbeActive || record.state.status !== "running") {
        return;
      }
      record.healthProbeActive = true;
      void probeBackendHealthOnce(record.item, record.state.backendUrl).then(async (probe) => {
        if (record.state.status !== "running") {
          return;
        }
        if (probe.ok) {
          record.consecutiveHealthFailures = 0;
          return;
        }
        record.consecutiveHealthFailures += 1;
        if (record.consecutiveHealthFailures < HEALTH_MONITOR_FAILURE_THRESHOLD) {
          return;
        }
        const message = t("service.healthTimeout", {
          message: probe.message || record.state.backendUrl
        });
        stopRecordHealthMonitor(record);
        record.state = {
          ...record.state,
          status: "error",
          webUrl: "",
          frontendPort: null,
          message,
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(getLogPath(app, record.item.id, "error"), `[${nowIso()}] health monitor failed: ${message}`);
        const gateway = record.gateway;
        record.gateway = null;
        await gateway?.close().catch(() => undefined);
        revokeRecordActionTokens(record);
        if (record.child) {
          await terminateRuntimeChild(record.child, record.item.backend?.shutdownTimeoutMs);
          record.child = null;
        }
        this.emitLifecycleChange("updated", record.item.id);
      }).finally(() => {
        record.healthProbeActive = false;
      });
    }, HEALTH_MONITOR_INTERVAL_MS);
    record.healthTimer.unref();
  }

  checkRuntime(app: App, webappId: string): WebappRuntimeCheckResult {
    const item = findWebapp(app, webappId, this.integrationPorts);
    if (!item) {
      return {
        ready: false,
        launcher: "none",
        ownership: null,
        runtimeVersion: "",
        externalId: "",
        backendUrl: "",
        backendPort: null,
        issues: [{ code: "webapp_not_found", message: t("webapp.notFound") }],
        message: t("webapp.notFound")
      };
    }
    const check = checkWebappBackendPrerequisites(
      createLauncherContext(app, item, null, undefined, "", this.integrationPorts)
    );
    return {
      ready: check.ok,
      launcher: check.launcher,
      ownership: check.ownership,
      runtimeVersion: check.runtimeVersion,
      externalId: check.externalId,
      backendUrl: check.backendUrl,
      backendPort: check.backendPort,
      issues: check.issues,
      message: prerequisiteMessage(check)
    };
  }

  checkItemPrerequisites(
    app: App,
    item: WebappEntry,
    webappDir: string
  ): WebappLauncherCheck & { message: string } {
    const check = checkWebappBackendPrerequisites(
      createLauncherContext(app, item, null, webappDir, "", this.integrationPorts)
    );
    return {
      ok: check.ok,
      launcher: check.launcher,
      ownership: check.ownership,
      runtimeVersion: check.runtimeVersion,
      externalId: check.externalId,
      backendUrl: check.backendUrl,
      backendPort: check.backendPort,
      issues: check.issues,
      message: prerequisiteMessage(check)
    };
  }

  getStatus(app: App, webappId: string) {
    const id = webappId.trim();
    const record = this.records.get(id);
    if (record) {
      this.refreshRecordProcessState(app, record);
      return record.state;
    }
    const item = findWebapp(app, id, this.integrationPorts);
    if (!item) {
      return null;
    }
    const stored = readStoredState(app, item);
    if (
      stored?.ownership === "desktop" &&
      stored.pid &&
      isProcessRunning(stored.pid)
    ) {
      return {
        ...stored,
        status: "error",
        webUrl: "",
        message: t("service.runningUnmanagedProcess"),
        updatedAt: nowIso()
      } satisfies WebappRuntimeState;
    }
    return createStoppedState(item);
  }

  async start(app: App, webappId: string): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id, this.integrationPorts);
    if (!item) {
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }
    const existing = this.records.get(id);
    if (existing?.state.status === "running") {
      return { ok: true, item, state: existing.state, message: t("webapp.alreadyRunning", { label: item.label }) };
    }
    if (existing) {
      await this.stop(app, id);
    }

    const contextBase = createLauncherContext(app, item, null, undefined, "", this.integrationPorts);
    fs.mkdirSync(contextBase.dataDir, { recursive: true });
    fs.mkdirSync(contextBase.logDir, { recursive: true });
    fs.mkdirSync(contextBase.stateDir, { recursive: true });
    writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] starting ${id} version=${item.version} launcher=${launcherForItem(item)}`);

    const initialState = {
      ...createBaseState(item, "starting", t("webapp.starting")),
      startedAt: nowIso()
    };
    writeState(app, initialState);

    let record: RuntimeRecord = {
      item,
      webappDir: contextBase.webappDir,
      child: null,
      gateway: null,
      backendActionToken: "",
      pageActionToken: issueWebappActionToken(item, "localPageGateway"),
      healthTimer: null,
      healthProbeActive: false,
      consecutiveHealthFailures: 0,
      state: initialState
    };
    this.records.set(id, record);

    try {
      if (!item.backend) {
        const gateway = await startWebappGateway({
          app,
          integrationPorts: this.integrationPorts,
          item,
          webappDir: record.webappDir,
          backendUrl: "",
          pageActionToken: record.pageActionToken
        });
        record.gateway = gateway;
        record.state = {
          ...record.state,
          status: "running",
          webUrl: gateway.webUrl,
          frontendPort: gateway.port,
          message: t("webapp.started", { label: item.label }),
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] running web=${record.state.webUrl} backend=none`);
        this.syncPublishedRoute(app, item, record.state);
        return { ok: true, item, state: record.state, message: record.state.message };
      }

      const backendPort = await reservePort(0);
      const context = createLauncherContext(
        app,
        item,
        backendPort,
        undefined,
        "",
        this.integrationPorts
      );
      const launcher = getWebappBackendLauncher(item.backend);
      const preflight = launcher.validatePrerequisites(context);
      if (!preflight.ok) {
        record.state = {
          ...record.state,
          status: "blocked",
          runtimeVersion: preflight.runtimeVersion,
          externalId: preflight.externalId,
          prerequisiteIssues: preflight.issues,
          message: prerequisiteMessage(preflight),
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] blocked: ${record.state.message}`);
        revokeRecordActionTokens(record);
        return { ok: false, item, state: record.state, message: record.state.message };
      }

      if (shouldIssueBackendActionToken(item)) {
        record.backendActionToken = issueWebappActionToken(item, "backendActionToken");
      }
      const launchContext = createLauncherContext(
        app,
        item,
        backendPort,
        record.webappDir,
        record.backendActionToken,
        this.integrationPorts
      );
      const launched = launcher.start(launchContext);
      if (!launched.ok) {
        throw new Error(prerequisiteMessage(launched));
      }
      record.child = launched.child;
      record.state = {
        ...record.state,
        runtimeVersion: launched.runtimeVersion,
        externalId: launched.externalId,
        backendUrl: launched.backendUrl,
        backendPort: launched.backendPort,
        pid: launched.child?.pid ?? null,
        prerequisiteIssues: []
      };
      writeState(app, record.state);

      let spawnError: Promise<never> | null = null;
      if (launched.child) {
        pipeChildLogs(app, id, launched.child);
        spawnError = new Promise<never>((_resolve, reject) => {
          launched.child!.once("error", (error) => {
            writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend spawn failed: ${error.message}`);
            reject(error);
          });
        });
      }
      await (
        spawnError
          ? Promise.race([waitForBackendHealth(item, launched, launched.child), spawnError])
          : waitForBackendHealth(item, launched, null)
      );

      const gateway = await startWebappGateway({
        app,
        integrationPorts: this.integrationPorts,
        item,
        webappDir: record.webappDir,
        backendUrl: launched.backendUrl,
        pageActionToken: record.pageActionToken
      });
      record.gateway = gateway;
      record.state = {
        ...record.state,
        status: "running",
        webUrl: gateway.webUrl,
        frontendPort: gateway.port,
        message: t("webapp.started", { label: item.label }),
        updatedAt: nowIso()
      };
      writeState(app, record.state);
      writeLogLine(
        getLogPath(app, id, "main"),
        `[${nowIso()}] running web=${record.state.webUrl} backend=${record.state.backendUrl} launcher=${record.state.launcher}`
      );

      if (launched.child) {
        const child = launched.child;
        child.once("exit", (code, signal) => {
          const current = this.records.get(id);
          if (
            !current ||
            current.child !== child ||
            (current.state.status !== "running" && current.state.status !== "starting")
          ) {
            return;
          }
          if (child.pid) {
            terminateRuntimeProcessTree(child.pid);
          }
          revokeRecordActionTokens(current);
          stopRecordHealthMonitor(current);
          void current.gateway?.close();
          current.gateway = null;
          current.state = {
            ...current.state,
            status: "error",
            webUrl: "",
            frontendPort: null,
            message: t("service.processExited", { reason: code ?? signal ?? "unknown" }),
            updatedAt: nowIso()
          };
          writeState(app, current.state);
          writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend exited: ${code ?? signal ?? "unknown"}`);
        });
      }

      this.startHealthMonitor(app, record);
      this.syncPublishedRoute(app, item, record.state);
      return { ok: true, item, state: record.state, message: record.state.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record.gateway?.close().catch(() => undefined);
      stopRecordHealthMonitor(record);
      if (record.child) {
        await terminateRuntimeChild(record.child, item.backend?.shutdownTimeoutMs);
      }
      revokeRecordActionTokens(record);
      record.state = {
        ...record.state,
        status: "error",
        webUrl: "",
        frontendPort: null,
        message,
        updatedAt: nowIso()
      };
      writeState(app, record.state);
      writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] start failed: ${message}`);
      return { ok: false, item, state: record.state, message };
    }
  }

  async stop(
    app: App,
    webappId: string,
    message = t("webapp.stopped")
  ): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id, this.integrationPorts);
    const record = this.records.get(id);
    if (record) {
      stopRecordHealthMonitor(record);
      let gatewayFailureMessage = "";
      try {
        await record.gateway?.close();
      } catch (error) {
        const gatewayMessage = error instanceof Error ? error.message : String(error);
        gatewayFailureMessage = t("webapp.gatewayCloseFailed", { message: gatewayMessage });
      }
      record.gateway = null;
      revokeRecordActionTokens(record);
      if (record.child) {
        const terminated = await terminateRuntimeChild(
          record.child,
          record.item.backend?.shutdownTimeoutMs
        );
        if (!terminated) {
          const pid = record.child.pid ?? record.state.pid;
          const failureMessage = pid
            ? t("webapp.processTreeStillRunningWithPid", { pid })
            : t("webapp.processTreeStillRunning");
          record.state = {
            ...record.state,
            status: "error",
            webUrl: "",
            frontendPort: null,
            message: failureMessage,
            updatedAt: nowIso()
          };
          writeState(app, record.state);
          writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] ${failureMessage}`);
          return {
            ok: false,
            item: item ?? record.item,
            state: record.state,
            message: failureMessage
          };
        }
        record.child = null;
      }
      if (gatewayFailureMessage) {
        record.state = {
          ...record.state,
          status: "error",
          webUrl: "",
          frontendPort: null,
          pid: null,
          message: gatewayFailureMessage,
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(
          getLogPath(app, id, "error"),
          `[${nowIso()}] ${gatewayFailureMessage}`
        );
        return {
          ok: false,
          item: item ?? record.item,
          state: record.state,
          message: gatewayFailureMessage
        };
      }
      record.state = {
        ...record.state,
        status: "stopped",
        webUrl: "",
        frontendPort: null,
        pid: null,
        message,
        updatedAt: nowIso()
      };
      this.records.delete(id);
      writeState(app, record.state);
      writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] stopped ${id}`);
      return { ok: true, item: item ?? record.item, state: record.state, message };
    }
    const stored = item
      ? readStoredState(app, item)
      : readStoredStateById(app, id);
    if (!item && !stored) {
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }
    if (stored?.ownership === "desktop" && stored.pid && isProcessRunning(stored.pid)) {
      const identityMatch = await matchProcessInstallDirAsync(
        stored.pid,
        getWebappDir(app, id)
      );
      if (identityMatch === "unknown") {
        const failureMessage = t("webapp.processOwnershipUnknown", { pid: stored.pid });
        const failedState = {
          ...stored,
          status: "error" as const,
          message: failureMessage,
          updatedAt: nowIso()
        };
        writeState(app, failedState);
        return {
          ok: false,
          item,
          state: failedState,
          message: failureMessage
        };
      }
      if (identityMatch === "matched") {
        const capturedPids = await listProcessTreePidsAsync(stored.pid).catch(() => [stored.pid!]);
        const exitedGracefully = process.platform === "win32"
          ? await requestWindowsProcessTreeExitAsync(stored.pid, capturedPids)
          : false;
        const terminated = exitedGracefully ||
          await terminateCapturedProcessTreeAsync(stored.pid, capturedPids);
        const remainingPids = capturedPids.filter((pid) => isProcessRunning(pid));
        if (!terminated || remainingPids.length > 0) {
          const failureMessage = t("webapp.processTreeStillRunningWithPid", {
            pid: remainingPids.join(", ") || stored.pid
          });
          const failedState = {
            ...stored,
            status: "error" as const,
            message: failureMessage,
            updatedAt: nowIso()
          };
          writeState(app, failedState);
          return {
            ok: false,
            item,
            state: failedState,
            message: failureMessage
          };
        }
      }
    }
    const state = item
      ? createStoppedState(item, message)
      : {
          ...stored!,
          status: "stopped" as const,
          webUrl: "",
          frontendPort: null,
          pid: null,
          message,
          updatedAt: nowIso()
        };
    writeState(app, state);
    return { ok: true, item, state, message };
  }

  async restart(app: App, webappId: string) {
    await this.stop(app, webappId);
    return this.start(app, webappId);
  }

  async stopAll(app: App) {
    const ids = new Set([
      ...this.records.keys(),
      ...readWebappItems(app, process.platform, this.integrationPorts)
        .filter((item) => {
          const stored = readStoredState(app, item);
          return stored?.ownership === "desktop" && Boolean(stored.pid);
        })
        .map((item) => item.id),
      ...listStoredRuntimeStates(app)
        .filter((state) =>
          state.ownership === "desktop" && Boolean(state.pid)
        )
        .map((state) => state.id)
    ]);
    const results = await Promise.all([...ids].map((id) => this.stop(app, id)));
    return results;
  }

  listActivePorts(app: App) {
    const ports = new Map<string, { id: string; port: number }>();
    const items = readWebappItems(app, process.platform, this.integrationPorts);
    for (const item of items) {
      const record = this.records.get(item.id);
      const state = record?.state ?? readStoredState(app, item);
      if (state?.frontendPort) {
        ports.set(`${item.id}:gateway:${state.frontendPort}`, {
          id: `${item.id}:gateway`,
          port: state.frontendPort
        });
      }
      if (state?.ownership === "desktop" && state.backendPort) {
        ports.set(`${item.id}:backend:${state.backendPort}`, {
          id: `${item.id}:backend`,
          port: state.backendPort
        });
      }
    }
    const installedIds = new Set(items.map((item) => item.id));
    for (const state of listStoredRuntimeStates(app)) {
      if (installedIds.has(state.id)) {
        continue;
      }
      if (state.frontendPort) {
        ports.set(`${state.id}:gateway:${state.frontendPort}`, {
          id: `${state.id}:gateway`,
          port: state.frontendPort
        });
      }
      if (state.ownership === "desktop" && state.backendPort) {
        ports.set(`${state.id}:backend:${state.backendPort}`, {
          id: `${state.id}:backend`,
          port: state.backendPort
        });
      }
    }
    return [...ports.values()];
  }

  readLog(
    app: App,
    webappId: string,
    target: WebappLogTarget,
    options: WebappLogReadOptions = {}
  ): WebappLogReadResult {
    return readServiceLogFile(getLogPath(app, webappId.trim(), target), options);
  }

  private refreshRecordProcessState(app: App, record: RuntimeRecord) {
    if (!record.item.backend && record.gateway?.server.listening) {
      return;
    }
    if (record.child && record.child.exitCode === null && record.child.signalCode === null) {
      return;
    }
    if (record.state.status === "running" || record.state.status === "starting") {
      stopRecordHealthMonitor(record);
      revokeRecordActionTokens(record);
      record.state = {
        ...record.state,
        status: "error",
        webUrl: "",
        frontendPort: null,
        message: t("service.backendNotRunning"),
        updatedAt: nowIso()
      };
      writeState(app, record.state);
    }
  }
}

export const webappRuntime = new WebappRuntime();

export function createWebappRuntime(ports: WebsIntegrationPorts) {
  return new WebappRuntime(ports);
}

export const __testInternals = {
  HOST,
  reservePort
};
