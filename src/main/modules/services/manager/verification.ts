import { type App } from "electron";
import {
  type ServiceId,
  type ServiceDesiredStatus,
  type ServiceState,
  type ServiceVerification,
  type ServiceCommandResult
} from "../../../../shared/contracts";
import { ServiceVerificationOptions } from "./manager-contracts";
import { getService } from "../service-registry";
import { runStartupCheckpoint, beginStartupCheckpoints } from "../../../support/logging/startup-checkpoints";
import { getServiceState } from "./service-state";
import {
  type HttpProbeResult,
  probeHttpUrl,
  normalizeProbeUrl,
  getServiceVerificationDelayMs,
  CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS,
  delay
} from "./service-probes";
import { getServiceLayout } from "./layout";
import { buildVerificationResult, hasVerifyRunningRequirements, getDependencyRunningVerificationTimeoutMs } from "./verification-policy";
import { collectDesktopCapabilityRequirementIssues } from "./capability-requirements";
import { beginStartupTiming } from "../../../support/logging/startup-timing";
import { t } from "../../../support/i18n/main-i18n";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";

export async function collectServiceVerification(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus,
  options: ServiceVerificationOptions = {}
): Promise<{ state: ServiceState; verification: ServiceVerification }> {
  const service = getService(serviceId);
  const state = await runStartupCheckpoint(serviceId, "verification", "read-service-state", () => getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  }));
  const probes: HttpProbeResult[] = [];

  if (desired === "running" && state.status === "running" && state.healthMeta.webUrl) {
    const webUrl = state.healthMeta.webUrl;
    probes.push(await runStartupCheckpoint(serviceId, "verification", "http-service-root", () => probeHttpUrl(webUrl)));
    if (service.id === "agent-container-hub") {
      probes.push(await probeHttpUrl(normalizeProbeUrl(webUrl, "/api/runtime-info")));
    }
  }

  const layout = getServiceLayout(app, service);
  const baseVerification = buildVerificationResult(service, state, desired, probes, options);
  if (desired !== "running" || state.status !== "running") {
    return {
      state,
      verification: baseVerification
    };
  }

  const requirementIssues = await collectDesktopCapabilityRequirementIssues(
    app,
    service,
    layout,
    "verifyRunning",
    options
  );
  if (requirementIssues.length === 0) {
    return {
      state,
      verification: baseVerification
    };
  }

  return {
    state,
    verification: {
      ...baseVerification,
      verified: false,
      issues: [...baseVerification.issues, ...requirementIssues]
    }
  };
}

export async function verifyServiceState(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus,
  options: ServiceVerificationOptions = {}
): Promise<ServiceVerification> {
  const timing = beginStartupTiming("verifyServiceState", { serviceId, desired });
  const checkpoints = beginStartupCheckpoints(serviceId, `verify-${desired}`);
  let verified = false;
  try {
    const delayMs = getServiceVerificationDelayMs();
    const service = getService(serviceId);
    const retryUntil =
      service.id === "agent-container-hub" && desired === "running"
        ? Date.now() + CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS
        : hasVerifyRunningRequirements(service) && desired === "running"
        ? Date.now() + getDependencyRunningVerificationTimeoutMs()
        : 0;
    checkpoints.next("initial-probe");
    let current = await collectServiceVerification(app, serviceId, desired, options);
    if (current.verification.verified) {
      verified = true;
      return current.verification;
    }

    do {
      checkpoints.next("retry-delay");
      await delay(delayMs > 0 ? delayMs : 1500);
      checkpoints.next("retry-probe");
      current = await collectServiceVerification(app, serviceId, desired, options);
      if (current.verification.verified) {
        verified = true;
        return current.verification;
      }
    } while (
      retryUntil > 0 &&
      Date.now() < retryUntil &&
      shouldRetryServiceVerification(service, desired, current.verification)
    );

    verified = current.verification.verified;
    return current.verification;
  } finally {
    checkpoints.end(verified ? "succeeded" : "failed");
    timing.end({ verified });
  }
}

export function serviceVerificationFailureMessage(actionMessage: string, verification: ServiceVerification) {
  const issues = verification.issues.length > 0
    ? verification.issues.join(t("common.listSeparator"))
    : t("service.verify.actualStatus", { status: verification.actualStatus });
  return t("service.verify.failed", { actionMessage, issues });
}

export function shouldRetryServiceVerification(
  service: ServiceDefinition,
  desired: ServiceDesiredStatus,
  verification: ServiceVerification
) {
  const retriesContainerHub =
    service.id === "agent-container-hub" &&
    desired === "running" &&
    !verification.verified &&
    verification.actualStatus === "running" &&
    verification.pidAlive;
  const retriesVerifyRunningRequirements =
    hasVerifyRunningRequirements(service) &&
    desired === "running" &&
    !verification.verified &&
    verification.actualStatus === "running" &&
    verification.pidAlive;
  return retriesContainerHub || retriesVerifyRunningRequirements;
}

export async function attachServiceVerification(
  app: App,
  serviceId: ServiceId,
  result: ServiceCommandResult,
  desired: ServiceDesiredStatus,
  actionMessage: string,
  options: ServiceVerificationOptions = {}
): Promise<ServiceCommandResult> {
  const verification = await verifyServiceState(app, serviceId, desired, options);
  const service = await getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
  if (!verification.verified) {
    return {
      ...result,
      ok: false,
      message: serviceVerificationFailureMessage(actionMessage, verification),
      service,
      verification
    };
  }
  return {
    ...result,
    ok: true,
    service,
    verification
  };
}
