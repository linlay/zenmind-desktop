import { type WebappEntry, type WebappRuntimeState, type WebappCommandResult, type WebappPublishResult } from "../../../shared/contracts";
import {
  type DesktopWebappSummary,
  type DesktopWebappRuntimeFailureDetails,
  type DesktopWebappPreferenceFailureDetails,
  type DesktopWebappPublishFailureDetails,
  type DesktopWebappInvalidResultDetails,
  type DesktopWebappInstallDiagnostic,
  type DesktopWebappInstallFailureDetails
} from "../../../shared/desktop-actions";
import { sanitizeActionErrorText, isActionCredentialKey } from "./diagnostics";
import { fail } from "./action-values";

export function compactWebappItem(item: WebappEntry | null | undefined): DesktopWebappSummary | undefined {
  if (!item) {
    return undefined;
  }
  return {
    id: item.id,
    label: item.label,
    version: item.version,
    target: item.target,
    openMode: item.openMode
  };
}

export function sanitizeWebappErrorText(value: string, _workspaceRoot = "") {
  return sanitizeActionErrorText(value);
}

export function sanitizeWebappDiagnosticValue(value: unknown, key = "", depth = 0, workspaceRoot = ""): unknown {
  if (isActionCredentialKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeWebappErrorText(value, workspaceRoot);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeWebappDiagnosticValue(item, key, depth + 1, workspaceRoot));
  }
  if (!value || typeof value !== "object" || depth >= 8) {
    return "[object]";
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = entryKey.replace(/[\s._-]+/gu, "").toLowerCase();
    if (normalizedKey === "items" || normalizedKey === "webapps") {
      continue;
    }
    output[entryKey] = sanitizeWebappDiagnosticValue(entryValue, entryKey, depth + 1, workspaceRoot);
  }
  return output;
}

export function projectWebappRuntimeState(state: WebappRuntimeState): WebappRuntimeState {
  return {
    id: state.id,
    entryKey: state.entryKey,
    kind: state.kind,
    status: state.status,
    version: state.version,
    target: state.target,
    launcher: state.launcher,
    ownership: state.ownership,
    runtimeVersion: state.runtimeVersion,
    externalId: state.externalId,
    prerequisiteIssues: state.prerequisiteIssues.map((issue) => ({
      code: issue.code,
      message: sanitizeWebappErrorText(issue.message),
      ...(issue.required === undefined ? {} : { required: issue.required }),
      ...(issue.detected === undefined ? {} : { detected: issue.detected })
    })),
    webUrl: sanitizeWebappErrorText(state.webUrl),
    backendUrl: sanitizeWebappErrorText(state.backendUrl),
    frontendPort: state.frontendPort,
    backendPort: state.backendPort,
    pid: state.pid,
    message: sanitizeWebappErrorText(state.message),
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    updatedAt: state.updatedAt
  };
}

export function webappRuntimeFailureDetails(
  webappId: string,
  operation: DesktopWebappRuntimeFailureDetails["operation"],
  command: WebappCommandResult
): DesktopWebappRuntimeFailureDetails {
  const item = compactWebappItem(command.item);
  return {
    webappId,
    operation,
    ...(item ? { item } : {}),
    ...(command.state ? { state: projectWebappRuntimeState(command.state) } : {})
  };
}

export function webappPreferenceFailureDetails(
  webappId: string,
  item: WebappEntry | null | undefined
): DesktopWebappPreferenceFailureDetails {
  const summary = compactWebappItem(item);
  return { webappId, ...(summary ? { item: summary } : {}) };
}

export function projectWebappPublishFailureDetails(
  webappId: string,
  operation: DesktopWebappPublishFailureDetails["operation"],
  result: WebappPublishResult
): DesktopWebappPublishFailureDetails {
  return {
    webappId,
    operation,
    info: {
      provider: result.info.provider,
      configured: result.info.configured,
      signedIn: result.info.signedIn,
      tunnelEnabled: result.info.tunnelEnabled,
      tunnelConnected: result.info.tunnelConnected,
      deviceId: result.info.deviceId,
      relayUrl: sanitizeWebappErrorText(result.info.relayUrl)
    },
    state: {
      id: result.state.id,
      provider: result.state.provider,
      status: result.state.status,
      name: result.state.name,
      routeId: result.state.routeId,
      publicHost: result.state.publicHost,
      url: sanitizeWebappErrorText(result.state.url),
      targetUrl: sanitizeWebappErrorText(result.state.targetUrl),
      active: result.state.active,
      message: sanitizeWebappErrorText(result.state.message),
      updatedAt: result.state.updatedAt
    }
  };
}

export function invalidWebappActionResult(
  action: string,
  webappId: string,
  operation: DesktopWebappInvalidResultDetails["operation"],
  missingFields: string[]
) {
  return fail(
    action,
    "invalid_action_result",
    `${action} succeeded without the required public result fields.`,
    { webappId, operation, missingFields } satisfies DesktopWebappInvalidResultDetails
  );
}

export function isWebappRuntimeStateFor(
  state: WebappRuntimeState | null,
  webappId: string
): state is WebappRuntimeState {
  return Boolean(state && state.id === webappId && typeof state.status === "string");
}

export function installFailureDetails(input: {
  archivePath: string;
  expectedId?: string;
  webappId?: string;
  executable?: string;
  selectedPath?: string;
  installPath?: string;
  item?: WebappEntry | null;
  diagnostic?: DesktopWebappInstallDiagnostic;
  workspaceRoot?: string;
}): DesktopWebappInstallFailureDetails {
  const diagnosticDetails = input.diagnostic?.details
    ? sanitizeWebappDiagnosticValue(input.diagnostic.details, "", 0, input.workspaceRoot) as Record<string, unknown>
    : undefined;
  const diagnostic = input.diagnostic
    ? {
        stage: input.diagnostic.stage,
        code: input.diagnostic.code,
        message: sanitizeWebappErrorText(input.diagnostic.message, input.workspaceRoot),
        ...(input.diagnostic.suggestion ? { suggestion: sanitizeWebappErrorText(input.diagnostic.suggestion, input.workspaceRoot) } : {}),
        ...(diagnosticDetails ? { details: diagnosticDetails } : {})
      }
    : undefined;
  const item = compactWebappItem(input.item);
  return {
    ...(input.webappId || input.expectedId ? { webappId: input.webappId || input.expectedId } : {}),
    operation: "install",
    ...(input.executable ? { executable: input.executable } : {}),
    ...(input.selectedPath ? { selectedPath: input.selectedPath } : {}),
    path: input.archivePath,
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(item ? { item } : {}),
    ...(diagnostic ? { diagnostic } : {})
  };
}
