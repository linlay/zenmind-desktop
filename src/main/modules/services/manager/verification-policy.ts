import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { type ServiceState, type ServiceDesiredStatus, type ServiceVerification } from "../../../../shared/contracts";
import { type HttpProbeResult } from "./service-probes";
import { ServiceVerificationOptions, DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS } from "./manager-contracts";
import { isProcessRunning } from "./process-cleanup";
import { isHostManagedService } from "./host-policy";
import { getAgentWebclientHostState } from "../agent-webclient-host";
import { listListeningPids } from "./managed-cleanup";
import { pidMatchesInstallDir } from "./process-identity";
import { t } from "../../../support/i18n/main-i18n";

export function buildVerificationResult(
  service: ServiceDefinition,
  state: ServiceState,
  desired: ServiceDesiredStatus,
  probes: HttpProbeResult[] = [],
  options: Pick<ServiceVerificationOptions, "skipManagedPortProbe"> = {}
): ServiceVerification {
  const installDir = getInstallDirFromState(state);
  const pid = state.healthMeta.pid;
  const pidAlive = desired === "running" ? isProcessRunning(pid) : !pid || !isProcessRunning(pid);
  const port = state.healthMeta.port ?? 0;
  const skipManagedPortProbe =
    options.skipManagedPortProbe === true &&
    desired === "running" &&
    service.id !== "agent-container-hub";
  const hostManagedState = isHostManagedService(service) ? getAgentWebclientHostState(service.id) : null;
  const hostManagedPortPid = hostManagedState?.running && hostManagedState.port === port
    ? process.pid
    : null;
  const listeningPids = port > 0 && !skipManagedPortProbe && !hostManagedPortPid ? listListeningPids(port) : [];
  const managedPortPid = hostManagedPortPid ?? (skipManagedPortProbe
    ? null
    : listeningPids.find((candidatePid) => (
      installDir ? pidMatchesInstallDir(candidatePid, installDir) : true
    )) ?? null);
  const portListening = hostManagedPortPid
    ? true
    : skipManagedPortProbe
    ? state.status === "running"
    : port > 0 ? Boolean(managedPortPid) : desired === "running";
  const httpProbe = probes.find((probe) => probe.target === state.healthMeta.webUrl);
  const runtimeInfoProbe = probes.find((probe) => probe.target.includes("/api/runtime-info"));
  const issues: string[] = [];

  if (desired === "running") {
    if (state.status !== "running") {
      issues.push(t("service.verify.statusStill", { status: state.status }));
    }
    if (pid && !isProcessRunning(pid)) {
      issues.push(t("service.verify.pidMissing", { pid }));
    }
    if (!pid) {
      issues.push(t("service.verify.noValidPid"));
    }
    if (service.id === "agent-container-hub") {
      if (port > 0 && !managedPortPid) {
        issues.push(t("service.verify.portNoManagedProcess", { port }));
      }
      if (httpProbe && !httpProbe.ok) {
        issues.push(t("service.verify.probeFailed", {
          target: httpProbe.target,
          message: httpProbe.message || t("service.probeHttpUnavailable")
        }));
      }
      if (runtimeInfoProbe) {
        const looksJson = /application\/json/iu.test(runtimeInfoProbe.contentType || "")
          || /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "");
        if (!runtimeInfoProbe.ok || !looksJson) {
          issues.push(runtimeInfoProbe.ok
            ? t("service.verify.runtimeInfoNotJson", { statusCode: runtimeInfoProbe.statusCode })
            : t("service.verify.probeFailed", {
                target: "/api/runtime-info",
                message: runtimeInfoProbe.message || t("service.probeHttpUnavailable")
              }));
        }
      } else {
        issues.push(t("service.verify.runtimeInfoMissing"));
      }
    }
  } else {
    if (state.status === "running") {
      issues.push(t("service.verify.stillRunning"));
    }
    if (pid && isProcessRunning(pid)) {
      issues.push(t("service.verify.pidStillRunning", { pid }));
    }
    if (port > 0 && managedPortPid) {
      issues.push(t("service.verify.portStillManaged", { port, pid: managedPortPid }));
    }
  }

  const baseVerified = desired === "running"
    ? state.status === "running" && pidAlive
    : state.status !== "running" && pidAlive && !managedPortPid;
  const strictVerified = service.id === "agent-container-hub" && desired === "running"
    ? baseVerified && portListening && probes.every((probe) => probe.ok) && Boolean(runtimeInfoProbe)
    : baseVerified;

  return {
    verified: strictVerified && issues.length === 0,
    desired,
    actualStatus: state.status,
    pidAlive,
    portListening,
    managedPortPid,
    httpOk: httpProbe ? httpProbe.ok : null,
    runtimeInfoOk: runtimeInfoProbe ? runtimeInfoProbe.ok && (
      /application\/json/iu.test(runtimeInfoProbe.contentType || "") ||
      /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "")
    ) : null,
    checkedAt: new Date().toISOString(),
    issues,
    probes: probes.map((probe) => ({
      target: probe.target,
      ok: probe.ok,
      statusCode: probe.statusCode,
      contentType: probe.contentType,
      message: probe.message
    }))
  };
}

export function getInstallDirFromState(state: ServiceState) {
  return state.installDir || "";
}

export function hasVerifyRunningRequirements(service: ServiceDefinition) {
  return service.desktop.capabilities.requires.some((requirement) => requirement.phase === "verifyRunning");
}

export function getDependencyRunningVerificationTimeoutMs() {
  const raw = Number.parseInt(process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS;
}
