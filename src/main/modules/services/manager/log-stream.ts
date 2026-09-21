import { type App } from "electron";
import {
  type ServiceId,
  type ServiceLogsMeta,
  type ServiceLogTarget,
  type ServiceLogReadOptions,
  type ServiceLogReadResult,
  type ServiceLogStreamOptions
} from "../../../../shared/contracts";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getServiceState } from "./service-state";
import fs from "node:fs";
import {
  readServiceLogFile,
  normalizeLogStreamOffset,
  LOG_READ_WINDOW_BYTES,
  readLogRange,
  normalizeLogStreamPollInterval
} from "../../../support/logging/service-logs";
import { ServiceLogStreamCallback } from "./manager-contracts";
import { t } from "../../../support/i18n/main-i18n";

export async function getServiceLogsMeta(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceLogsMeta> {
  const state = await getServiceState(app, serviceId, { integrationPorts: ports });
  return {
    ok: true,
    logPath: state.healthMeta.logFilePath,
    exists: fs.existsSync(state.healthMeta.logFilePath)
  };
}

export async function readServiceLog(
  app: App,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogReadOptions = {},
  ports?: ServicesIntegrationPorts
): Promise<ServiceLogReadResult> {
  const state = await getServiceState(app, serviceId, { integrationPorts: ports });
  const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;
  return readServiceLogFile(filePath, options);
}

export function watchServiceLog(
  app: App,
  subscriptionId: string,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogStreamOptions = {},
  onEvent: ServiceLogStreamCallback,
  ports?: ServicesIntegrationPorts
) {
  let currentPath = "";
  let currentOffset = normalizeLogStreamOffset(options);
  let currentExists = false;
  let polling = false;
  let stopped = false;

  async function sendReset(message: string) {
    const result = await readServiceLog(app, serviceId, target, {}, ports);
    currentPath = result.path;
    currentOffset = result.endOffset;
    currentExists = result.exists;
    onEvent({
      subscriptionId,
      serviceId,
      target,
      type: "reset",
      path: result.path,
      exists: result.exists,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      hasPrevious: result.hasPrevious,
      totalBytes: result.totalBytes,
      message
    });
  }

  async function poll() {
    if (polling || stopped) {
      return;
    }

    polling = true;
    try {
      const state = await getServiceState(app, serviceId, { integrationPorts: ports });
      const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;

      if (!filePath) {
        if (currentPath || currentExists) {
          currentPath = "";
          currentOffset = 0;
          currentExists = false;
          onEvent({
            subscriptionId,
            serviceId,
            target,
            type: "reset",
            path: "",
            exists: false,
            content: "",
            startOffset: 0,
            endOffset: 0,
            hasPrevious: false,
            totalBytes: 0,
            message: t("service.logPathCleared")
          });
        }
        return;
      }

      if (currentPath && filePath !== currentPath) {
        await sendReset(t("service.logPathChanged"));
        return;
      }

      currentPath = filePath;

      if (!fs.existsSync(filePath)) {
        currentExists = false;
        return;
      }

      const stat = fs.statSync(filePath);
      const totalBytes = stat.size;
      if (totalBytes < currentOffset) {
        await sendReset(t("service.logRotated"));
        return;
      }

      currentExists = true;
      if (totalBytes <= currentOffset) {
        currentOffset = totalBytes;
        return;
      }

      const deltaBytes = totalBytes - currentOffset;
      if (deltaBytes > LOG_READ_WINDOW_BYTES) {
        await sendReset(t("service.logGrowingFast"));
        return;
      }

      const startOffset = currentOffset;
      const content = readLogRange(filePath, startOffset, totalBytes);
      currentOffset = totalBytes;
      if (content.length === 0) {
        return;
      }

      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "append",
        path: filePath,
        exists: true,
        content,
        startOffset,
        endOffset: totalBytes,
        hasPrevious: startOffset > 0,
        totalBytes
      });
    } catch (reason) {
      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "error",
        path: currentPath,
        exists: currentExists,
        content: "",
        startOffset: currentOffset,
        endOffset: currentOffset,
        hasPrevious: currentOffset > 0,
        totalBytes: currentOffset,
        message: reason instanceof Error ? reason.message : String(reason)
      });
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, normalizeLogStreamPollInterval(options));
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
