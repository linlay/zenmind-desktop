import type { WebContents } from "electron";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import type { SiteControlScope } from "../cdp/site-scope";
import {
  AwcpSchemaCompileError,
  compileAwcpSchema,
  type AwcpSchemaValidator,
  type AwcpSchemaViolation,
} from "./schema-validator";

export const AWCP_PROTOCOL_VERSION = 1;
export const AWCP_ACTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const AWCP_LIMITS = Object.freeze({
  maxActionLength: 128,
  maxRevisionLength: 128,
  maxRequestIdLength: 128,
  maxErrorMessageLength: 4096,
  maxErrorDetailsBytes: 128 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxActions: 128,
  maxDescriptionLength: 2048,
  maxSchemaDepth: 20,
  maxSnapshotBytes: 256 * 1024,
});

export type AwcpInvokePayload = {
  revision: string;
  action: string;
  args: Record<string, unknown>;
};

export type AwcpActionResponse =
  | { ok: true; requestId: string; action: string; result: unknown }
  | {
      ok: false;
      requestId: string;
      action: string;
      error: { code: string; message: string; details?: unknown };
    };

export type AwcpSnapshotResponse = {
  ok: true;
  method: "AWCP.getSnapshot";
  revision: string;
  actions: AwcpActionDescriptor[];
};

type AwcpActionDescriptor = {
  action: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

type AwcpActionSnapshot = {
  revision: string;
  actions: AwcpActionDescriptor[];
};

type PreparedActionContract = {
  input: AwcpSchemaValidator;
  output?: AwcpSchemaValidator;
};

type ActiveInvocation = {
  guest: WebContents;
  cancel(error: Error): void;
};

class AwcpHostError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AwcpHostError";
  }
}

const AWCP_ERROR_CODES = new Set([
  "action_not_found",
  "stale_snapshot",
  "invalid_arguments",
  "execution_failed",
  "cancelled",
  "duplicate_request",
]);

export class AwcpGuestBridge {
  private readonly active = new Map<string, ActiveInvocation>();

  constructor(private readonly browserSurfaces: Pick<BrowserSurfaceRegistry, "findWebContentsById">) {}

  async snapshot(
    requestId: string,
    scope: SiteControlScope,
    signal?: AbortSignal,
  ): Promise<AwcpSnapshotResponse> {
    assertToken("requestId", requestId, AWCP_LIMITS.maxRequestIdLength);
    return this.withGuest(requestId, scope, signal, false, async (guest, lifecycleFailure) => {
      const snapshot = await this.readValidatedSnapshot(guest, lifecycleFailure);
      return {
        ok: true,
        method: "AWCP.getSnapshot",
        revision: snapshot.revision,
        actions: snapshot.actions,
      };
    });
  }

  async invoke(
    requestId: string,
    input: unknown,
    scope: SiteControlScope,
    signal?: AbortSignal,
  ): Promise<AwcpActionResponse> {
    const payload = validateInvokePayload(requestId, input);
    return this.withGuest(requestId, scope, signal, true, async (guest, lifecycleFailure) => {
      const snapshot = await this.readValidatedSnapshot(guest, lifecycleFailure);
      if (snapshot.revision !== payload.revision) {
        return awcpBusinessFailure(requestId, payload.action, "stale_snapshot", "The AWCP snapshot is stale.");
      }
      const descriptor = snapshot.actions.find((candidate) => candidate.action === payload.action);
      if (!descriptor) {
        return awcpBusinessFailure(requestId, payload.action, "action_not_found", "The AWCP action is unavailable.");
      }
      const contract = prepareActionContract(descriptor);
      const inputViolations = contract.input(payload.args);
      if (inputViolations.length > 0) {
        return awcpBusinessFailure(
          requestId,
          payload.action,
          "invalid_arguments",
          "The AWCP action arguments do not satisfy inputSchema.",
          { violations: inputViolations },
        );
      }

      const envelope = JSON.stringify({ requestId, ...payload });
      const result = await Promise.race([
        guest.executeJavaScript(
          `globalThis.awcp.invoke(JSON.parse(${JSON.stringify(envelope)}))`,
          true,
        ),
        lifecycleFailure,
      ]);
      const response = validateActionResponse(result, requestId, payload.action);
      if (response.ok && contract.output) {
        const outputViolations = contract.output(response.result);
        if (outputViolations.length > 0) {
          throw awcpHostError(
            "awcp_invalid_response",
            "The page AWCP result does not satisfy its declared outputSchema.",
            { reason: "output_schema_mismatch", violations: outputViolations },
          );
        }
      }
      return response;
    });
  }

  private async readValidatedSnapshot(
    guest: WebContents,
    lifecycleFailure: Promise<never>,
  ): Promise<AwcpActionSnapshot> {
    const protocolVersion = await Promise.race([
      guest.executeJavaScript("globalThis.awcp?.protocolVersion ?? null", true),
      lifecycleFailure,
    ]);
    if (protocolVersion !== AWCP_PROTOCOL_VERSION) {
      throw awcpHostError("awcp_protocol_unavailable", "The authorized page does not expose AWCP protocol version 1.");
    }
    const snapshotValue = await Promise.race([
      guest.executeJavaScript("globalThis.awcp.snapshot()", true),
      lifecycleFailure,
    ]);
    const snapshot = validateActionSnapshot(snapshotValue);
    return JSON.parse(JSON.stringify(snapshot)) as AwcpActionSnapshot;
  }

  private async withGuest<T>(
    requestId: string,
    scope: SiteControlScope,
    signal: AbortSignal | undefined,
    cancelPageInvocation: boolean,
    execute: (guest: WebContents, lifecycleFailure: Promise<never>) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(requestId)) {
      throw awcpHostError("awcp_duplicate_request", "AWCP request id is already active.");
    }
    const surface = scope.readSurface();
    const tab = surface.tabs?.find((candidate) => candidate.tabId === surface.activeTabId);
    if (!tab) throw awcpHostError("awcp_target_unavailable", "The authorized page has no active tab.");
    scope.validateTab(tab);
    const guest = this.browserSurfaces.findWebContentsById(tab.webContentsId);
    if (!guest || guest.isDestroyed()) {
      throw awcpHostError("awcp_target_unavailable", "The authorized page guest is unavailable.");
    }

    let rejectLifecycle!: (error: Error) => void;
    let lifecycleFailed = false;
    const lifecycleFailure = new Promise<never>((_resolve, reject) => { rejectLifecycle = reject; });
    void lifecycleFailure.catch(() => undefined);
    const failLifecycle = (error: Error) => {
      if (lifecycleFailed) return;
      lifecycleFailed = true;
      if (cancelPageInvocation) void cancelGuest(guest, requestId);
      rejectLifecycle(error);
    };
    const active: ActiveInvocation = { guest, cancel: failLifecycle };
    this.active.set(requestId, active);

    const onDestroyed = () => failLifecycle(awcpHostError(
      "awcp_target_unavailable",
      cancelPageInvocation
        ? "The authorized page guest closed during the AWCP invocation."
        : "The authorized page guest closed during the AWCP snapshot request.",
    ));
    const onNavigation = (...eventArgs: unknown[]) => {
      if (eventArgs[3] === true) {
        failLifecycle(awcpHostError(
          "awcp_navigation_interrupted",
          cancelPageInvocation
            ? "The authorized page navigated during the AWCP invocation."
            : "The authorized page navigated during the AWCP snapshot request.",
        ));
      }
    };
    const onAbort = () => failLifecycle(awcpHostError(
      "awcp_cancelled",
      cancelPageInvocation ? "The AWCP invocation was cancelled." : "The AWCP snapshot request was cancelled.",
    ));
    const unsubscribeScope = scope.onRelease(() => failLifecycle(awcpHostError(
      "site_control_unavailable",
      cancelPageInvocation
        ? "The page control capability ended during the AWCP invocation."
        : "The page control capability ended during the AWCP snapshot request.",
    )));
    guest.once("destroyed", onDestroyed);
    guest.once("render-process-gone", onDestroyed);
    guest.on("did-start-navigation", onNavigation);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal?.aborted) onAbort();
      return await execute(guest, lifecycleFailure);
    } catch (error) {
      if (isAwcpHostError(error)) throw error;
      throw awcpHostError(
        "awcp_transport_failed",
        cancelPageInvocation
          ? "The authorized page AWCP invocation failed."
          : "The authorized page AWCP snapshot request failed.",
      );
    } finally {
      if (this.active.get(requestId) === active) this.active.delete(requestId);
      signal?.removeEventListener("abort", onAbort);
      unsubscribeScope();
      guest.off("destroyed", onDestroyed);
      guest.off("render-process-gone", onDestroyed);
      guest.off("did-start-navigation", onNavigation);
    }
  }

  cancel(requestId: string) {
    const invocation = this.active.get(requestId);
    if (!invocation) return false;
    invocation.cancel(awcpHostError("awcp_cancelled", "The AWCP invocation was cancelled."));
    return true;
  }

  dispose() {
    for (const invocation of [...this.active.values()]) {
      invocation.cancel(awcpHostError("awcp_cancelled", "The AWCP bridge stopped."));
    }
    this.active.clear();
  }
}

function validateInvokePayload(requestId: unknown, input: unknown): AwcpInvokePayload {
  assertToken("requestId", requestId, AWCP_LIMITS.maxRequestIdLength);
  assertPlainRecord(input, "AWCP payload");
  assertExactKeys(input, ["action", "args", "revision"], "AWCP payload");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength);
  assertAction(input.action);
  assertPlainRecord(input.args, "AWCP args");
  assertJsonValue(input.args, "AWCP args");
  return input as AwcpInvokePayload;
}

function validateActionSnapshot(input: unknown): AwcpActionSnapshot {
  assertPlainRecord(input, "AWCP snapshot", "awcp_invalid_contract");
  assertJsonValue(input, "AWCP snapshot", "awcp_invalid_contract");
  assertExactKeys(input, ["actions", "revision"], "AWCP snapshot", "awcp_invalid_contract");
  if (typeof input.revision !== "string" || !input.revision || input.revision.length > AWCP_LIMITS.maxRevisionLength) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP snapshot revision.");
  }
  if (!Array.isArray(input.actions) || input.actions.length > AWCP_LIMITS.maxActions) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP action list.");
  }
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > AWCP_LIMITS.maxSnapshotBytes) {
    throw awcpHostError("awcp_invalid_contract", "The page AWCP snapshot exceeds 256 KiB.");
  }
  let previousAction = "";
  for (const candidate of input.actions) {
    validateActionDescriptor(candidate);
    if (candidate.action <= previousAction) {
      throw awcpHostError("awcp_invalid_contract", "The page AWCP actions are not strictly sorted.");
    }
    previousAction = candidate.action;
  }
  return input as AwcpActionSnapshot;
}

function validateActionDescriptor(input: unknown): asserts input is AwcpActionDescriptor {
  assertPlainRecord(input, "AWCP action descriptor", "awcp_invalid_contract");
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "action,description,inputSchema" && keys !== "action,description,inputSchema,outputSchema") {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP action descriptor.");
  }
  if (typeof input.action !== "string" || !input.action || input.action.length > AWCP_LIMITS.maxActionLength || !AWCP_ACTION_PATTERN.test(input.action)) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP action name.");
  }
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > AWCP_LIMITS.maxDescriptionLength) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP action description.");
  }
  assertPlainRecord(input.inputSchema, "AWCP inputSchema", "awcp_invalid_contract");
  assertMaximumDepth(input.inputSchema, AWCP_LIMITS.maxSchemaDepth, "AWCP inputSchema");
  if (Object.prototype.hasOwnProperty.call(input, "outputSchema")) {
    assertPlainRecord(input.outputSchema, "AWCP outputSchema", "awcp_invalid_contract");
    assertMaximumDepth(input.outputSchema, AWCP_LIMITS.maxSchemaDepth, "AWCP outputSchema");
  }
}

function prepareActionContract(descriptor: AwcpActionDescriptor): PreparedActionContract {
  try {
    return {
      input: compileAwcpSchema(descriptor.inputSchema),
      ...(Object.prototype.hasOwnProperty.call(descriptor, "outputSchema")
        ? { output: compileAwcpSchema(descriptor.outputSchema as Record<string, unknown>) }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof AwcpSchemaCompileError)) throw error;
    throw awcpHostError(
      "awcp_invalid_contract",
      "The page returned an AWCP schema that cannot be compiled.",
    );
  }
}

function assertMaximumDepth(root: unknown, maximum: number, name: string) {
  const visit = (value: unknown, depth: number, ancestors: Set<object>) => {
    if (!value || typeof value !== "object") return;
    if (depth > maximum) {
      throw awcpHostError("awcp_invalid_contract", `${name} exceeds the maximum depth.`);
    }
    if (ancestors.has(value)) {
      throw awcpHostError("awcp_invalid_contract", `${name} contains a cycle.`);
    }
    ancestors.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child, depth + 1, ancestors);
    }
    ancestors.delete(value);
  };
  visit(root, 0, new Set());
}

function awcpBusinessFailure(
  requestId: string,
  action: string,
  code: "stale_snapshot" | "action_not_found" | "invalid_arguments",
  message: string,
  details?: { violations: AwcpSchemaViolation[] },
): AwcpActionResponse {
  return {
    ok: false,
    requestId,
    action,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

function validateActionResponse(input: unknown, requestId: string, action: string): AwcpActionResponse {
  assertPlainRecord(input, "AWCP response", "awcp_invalid_response");
  assertJsonValue(input, "AWCP response", "awcp_invalid_response");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > AWCP_LIMITS.maxResponseBytes) {
    throw awcpHostError("awcp_response_too_large", "The page AWCP response exceeds 64 MiB.");
  }
  if (input.requestId !== requestId || input.action !== action) {
    throw awcpHostError("awcp_response_mismatch", "The page AWCP response does not match its request.");
  }
  if (input.ok === true) {
    assertExactKeys(input, ["action", "ok", "requestId", "result"], "AWCP success response", "awcp_invalid_response");
    return input as AwcpActionResponse;
  }
  if (input.ok !== false) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP response.");
  }
  assertExactKeys(input, ["action", "error", "ok", "requestId"], "AWCP failure response", "awcp_invalid_response");
  assertPlainRecord(input.error, "AWCP error", "awcp_invalid_response");
  const errorKeys = Object.keys(input.error).sort();
  if (errorKeys.join(",") !== "code,message" && errorKeys.join(",") !== "code,details,message") {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error.");
  }
  const code = input.error.code;
  if (typeof code !== "string" || (!AWCP_ERROR_CODES.has(code) && !/^action\..+$/.test(code))) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error code.");
  }
  if (typeof input.error.message !== "string" || input.error.message.length > AWCP_LIMITS.maxErrorMessageLength) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error message.");
  }
  if (Object.prototype.hasOwnProperty.call(input.error, "details") &&
      Buffer.byteLength(JSON.stringify(input.error.details), "utf8") > AWCP_LIMITS.maxErrorDetailsBytes) {
    throw awcpHostError("awcp_invalid_response", "The page returned oversized AWCP error details.");
  }
  return input as AwcpActionResponse;
}

function assertAction(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > AWCP_LIMITS.maxActionLength || !AWCP_ACTION_PATTERN.test(value)) {
    throw awcpHostError("awcp_invalid_request", "AWCP action is invalid.");
  }
}

function assertToken(name: string, value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw awcpHostError("awcp_invalid_request", `AWCP ${name} is invalid.`);
  }
}

function assertPlainRecord(
  value: unknown,
  name: string,
  code = "awcp_invalid_request",
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw awcpHostError(code, `${name} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw awcpHostError(code, `${name} must be a plain JSON object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  name: string,
  code = "awcp_invalid_request",
) {
  if (Object.keys(value).sort().join(",") !== expected.join(",")) {
    throw awcpHostError(code, `${name} has unsupported fields.`);
  }
}

function assertJsonValue(root: unknown, name: string, code = "awcp_invalid_request") {
  const visit = (value: unknown, ancestors: Set<object>) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      throw awcpHostError(code, `${name} contains a non-finite number.`);
    }
    if (!value || typeof value !== "object") {
      throw awcpHostError(code, `${name} contains a non-JSON value.`);
    }
    if (ancestors.has(value)) throw awcpHostError(code, `${name} contains a cycle.`);
    ancestors.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw awcpHostError(code, `${name} contains a symbol property.`);
    }
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw awcpHostError(code, `${name} contains a sparse or extended array.`);
      }
      for (let index = 0; index < value.length; index += 1) visit(value[index], ancestors);
      ancestors.delete(value);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw awcpHostError(code, `${name} contains a non-plain object.`);
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw awcpHostError(code, `${name} contains an accessor property.`);
      }
      visit(descriptor.value, ancestors);
    }
    ancestors.delete(value);
  };
  visit(root, new Set());
}

function cancelGuest(guest: WebContents, requestId: string) {
  if (guest.isDestroyed()) return Promise.resolve();
  return guest.executeJavaScript(`globalThis.awcp?.cancel(${JSON.stringify(requestId)}) ?? false`, true)
    .then(() => undefined, () => undefined);
}

function awcpHostError(code: string, message: string, details?: Record<string, unknown>) {
  const statusCode = code === "awcp_invalid_request"
    ? 400
    : code === "awcp_duplicate_request" || code === "site_control_unavailable"
      ? 409
      : 502;
  return new AwcpHostError(code, statusCode, message, details);
}

function isAwcpHostError(error: unknown): error is AwcpHostError {
  return error instanceof AwcpHostError;
}
