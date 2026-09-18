import { createWebSurfaceId } from "../../../../shared/web-surface";
import type { WebContents } from "electron";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import type { SiteControlScope } from "../cdp/site-scope";
import { AwcpManualBindings } from "./discovery-binding";

export const AWCP_PROTOCOL_VERSION = 1;
export const AWCP_ACTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const AWCP_LIMITS = Object.freeze({
  maxActionLength: 128,
  maxRevisionLength: 128,
  maxRequestIdLength: 128,
  maxTitleLength: 128,
  maxDescriptionLength: 16 * 1024,
  maxExamples: 32,
  maxErrorMessageLength: 4096,
  maxErrorDetailsBytes: 128 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxSections: 128,
  maxIndexBytes: 64 * 1024,
  maxSectionBytes: 256 * 1024,
});

export type AwcpManualPayload = Record<string, never> | { section: string; revision: string };

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

type AwcpManualIndex = {
  revision: string;
  site: { name: string; description: string };
  sections: Array<{ section: string; title: string }>;
};

type AwcpManualSection = {
  revision: string;
  section: string;
  description: string;
  inputSchema: Record<string, unknown>;
  examples?: Record<string, unknown>[];
};

export type AwcpManualResponse =
  | ({ ok: true; method: "AWCP.getManual" } & AwcpManualIndex)
  | ({ ok: true; method: "AWCP.getManual" } & AwcpManualSection);

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
  "stale_revision",
  "invalid_arguments",
  "execution_failed",
  "cancelled",
  "duplicate_request",
]);

export class AwcpGuestBridge {
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly manuals = new AwcpManualBindings();

  constructor(private readonly browserSurfaces: Pick<BrowserSurfaceRegistry, "findWebContentsById">) {}

  async manual(
    requestId: string,
    input: unknown,
    scope: SiteControlScope,
    signal?: AbortSignal,
    surfaceId?: string,
  ): Promise<AwcpManualResponse> {
    assertToken("requestId", requestId, AWCP_LIMITS.maxRequestIdLength);
    const payload = validateManualPayload(input);
    return this.withGuest(requestId, scope, signal, surfaceId, false, async (guest, lifecycleFailure) => {
      if ("section" in payload) {
        const bindingFailure = this.manuals.rejection(scope, guest, payload.revision);
        if (bindingFailure) {
          throw awcpPreflightFailure(bindingFailure, "The section request does not match the current page manual binding.");
        }
        if (this.manuals.actionKnown(scope, payload.section) === false) {
          throw awcpPreflightFailure("action_not_found", "The requested AWCP manual section is unavailable.");
        }
      }
      const value = await this.readPageManual(guest, payload, lifecycleFailure);
      if ("section" in payload) {
        const manualError = validateManualError(value, payload.section);
        if (manualError === "stale_revision") {
          this.manuals.invalidate(scope);
          throw awcpPreflightFailure("stale_revision", "The AWCP page revision changed. Read the directory again.");
        }
        if (manualError === "section_not_found") {
          throw awcpPreflightFailure("action_not_found", "The requested AWCP manual section is unavailable.");
        }
        const section = validateManualSection(value, payload.section, payload.revision);
        const bindingFailure = this.manuals.rejection(scope, guest, payload.revision);
        if (bindingFailure) {
          throw awcpPreflightFailure(bindingFailure, "The page manual binding changed while reading the section.");
        }
        if (this.manuals.actionKnown(scope, payload.section) === false) {
          throw awcpPreflightFailure("action_not_found", "The requested AWCP manual section is no longer available.");
        }
        this.manuals.rememberSection(scope, guest, section.revision, section.section);
        return { ok: true, method: "AWCP.getManual", ...section };
      }
      const index = validateManualIndex(value);
      this.manuals.rememberIndex(scope, guest, index.revision, index.sections.map(({ section }) => section));
      return { ok: true, method: "AWCP.getManual", ...index };
    });
  }

  async invoke(
    requestId: string,
    input: unknown,
    scope: SiteControlScope,
    signal?: AbortSignal,
    surfaceId?: string,
  ): Promise<AwcpActionResponse> {
    const payload = validateInvokePayload(requestId, input);
    return this.withGuest(requestId, scope, signal, surfaceId, true, async (guest, lifecycleFailure) => {
      const bindingFailure = this.manuals.rejection(scope, guest, payload.revision);
      if (bindingFailure) {
        throw awcpPreflightFailure(bindingFailure, "The invocation does not match the current page manual binding.");
      }
      if (!this.manuals.sectionRead(scope, payload.action)) {
        const reason = this.manuals.actionKnown(scope, payload.action) === false ? "action_not_found" : "manual_required";
        throw awcpPreflightFailure(reason, reason === "manual_required"
          ? "Read this AWCP manual section before invoking it."
          : "The AWCP action is unavailable.");
      }

      const changedBinding = this.manuals.rejection(scope, guest, payload.revision);
      if (changedBinding) throw awcpPreflightFailure(changedBinding, "The page changed before invocation.");
      if (signal?.aborted) throw awcpHostError("awcp_cancelled", "The AWCP invocation was cancelled before page execution.");
      await this.ensurePageProtocol(guest, lifecycleFailure);

      const envelope = JSON.stringify({ requestId, ...payload });
      const result = await Promise.race([
        guest.executeJavaScript(
          `globalThis.awcp.invoke(JSON.parse(${JSON.stringify(envelope)}))`,
          true,
        ),
        lifecycleFailure,
      ]);
      const response = validateActionResponse(result, requestId, payload.action);
      if (!response.ok && response.error.code === "stale_revision") this.manuals.invalidate(scope);
      return response;
    });
  }

  private async readPageManual(
    guest: WebContents,
    request: AwcpManualPayload,
    lifecycleFailure: Promise<never>,
  ): Promise<unknown> {
    await this.ensurePageProtocol(guest, lifecycleFailure);
    const envelope = JSON.stringify(request);
    const value = await Promise.race([
      guest.executeJavaScript(`globalThis.awcp.manual(JSON.parse(${JSON.stringify(envelope)}))`, true),
      lifecycleFailure,
    ]);
    assertJsonValue(value, "AWCP manual", "awcp_invalid_contract");
    return JSON.parse(JSON.stringify(value));
  }

  private async ensurePageProtocol(guest: WebContents, lifecycleFailure: Promise<never>) {
    const probe = await Promise.race([
      guest.executeJavaScript(`(() => {
        const api = globalThis.awcp;
        if (api === undefined || api === null) return { present: false };
        const entryType = typeof api;
        if (entryType !== "object" && entryType !== "function") return { present: true, entryType };
        const version = api.protocolVersion;
        const actualVersion = typeof version === "string"
          ? version.slice(0, 128)
          : typeof version === "number"
            ? (Number.isFinite(version) ? version : "number")
            : version === null || typeof version === "boolean"
              ? version
              : typeof version;
        return { present: true, entryType, actualVersion, manualType: typeof api.manual, invokeType: typeof api.invoke };
      })()`, true),
      lifecycleFailure,
    ]);
    assertPlainRecord(probe, "AWCP protocol probe", "awcp_invalid_contract");
    if (probe.present === false) {
      throw awcpHostError("awcp_protocol_unavailable", "The authorized page does not expose AWCP.");
    }
    if (probe.present !== true) {
      throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP protocol probe.");
    }
    if ((probe.entryType !== "object" && probe.entryType !== "function") || probe.actualVersion === "undefined") {
      throw awcpHostError("awcp_invalid_contract", "The authorized page exposes an invalid AWCP entry point.");
    }
    if (probe.actualVersion !== AWCP_PROTOCOL_VERSION) {
      throw awcpHostError(
        "awcp_unsupported_protocol",
        "The authorized page exposes an unsupported AWCP protocol version.",
        { supportedVersions: [AWCP_PROTOCOL_VERSION], actualVersion: probe.actualVersion },
      );
    }
    if (probe.manualType !== "function" || probe.invokeType !== "function") {
      throw awcpHostError("awcp_invalid_contract", "The authorized page exposes an invalid AWCP entry point.");
    }
  }

  private async withGuest<T>(
    requestId: string,
    scope: SiteControlScope,
    signal: AbortSignal | undefined,
    surfaceId: string | undefined,
    cancelPageInvocation: boolean,
    execute: (guest: WebContents, lifecycleFailure: Promise<never>) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(requestId)) {
      throw awcpHostError("awcp_duplicate_request", "AWCP request id is already active.");
    }
    const surface = scope.readContainer();
    const tab = surface.tabs?.find((candidate) => surfaceId
      ? createWebSurfaceId(surface.id, surface.targetGeneration, candidate.tabId) === surfaceId
      : candidate.tabId === surface.activeTabId);
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

    const operation = cancelPageInvocation ? "invocation" : "manual request";
    const onDestroyed = () => failLifecycle(awcpHostError(
      "awcp_target_unavailable",
      `The authorized page guest closed during the AWCP ${operation}.`,
    ));
    const onNavigation = (...eventArgs: unknown[]) => {
      if (eventArgs[3] === true) {
        failLifecycle(awcpHostError(
          "awcp_navigation_interrupted",
          `The authorized page navigated during the AWCP ${operation}.`,
        ));
      }
    };
    const onAbort = () => failLifecycle(awcpHostError(
      "awcp_cancelled",
      `The AWCP ${operation} was cancelled.`,
    ));
    const unsubscribeScope = scope.onRelease(() => failLifecycle(awcpHostError(
      "site_control_unavailable",
      `The page control capability ended during the AWCP ${operation}.`,
    )));
    guest.once("destroyed", onDestroyed);
    guest.once("render-process-gone", onDestroyed);
    guest.on("did-start-navigation", onNavigation);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal?.aborted) {
        onAbort();
        return await lifecycleFailure;
      }
      return await execute(guest, lifecycleFailure);
    } catch (error) {
      if (isAwcpHostError(error)) throw error;
      throw awcpHostError("awcp_transport_failed", `The authorized page AWCP ${operation} failed.`);
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
    this.manuals.dispose();
  }
}

function validateManualPayload(input: unknown): AwcpManualPayload {
  assertPlainRecord(input, "AWCP manual payload");
  const keys = Object.keys(input).sort();
  if (keys.length === 0) return {};
  assertExactKeys(input, ["revision", "section"], "AWCP manual payload");
  assertAction(input.section, "section");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength);
  return { section: input.section, revision: input.revision };
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

function validateManualIndex(input: unknown): AwcpManualIndex {
  assertPlainRecord(input, "AWCP manual index", "awcp_invalid_contract");
  assertExactKeys(input, ["revision", "sections", "site"], "AWCP manual index", "awcp_invalid_contract");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength, "awcp_invalid_contract");
  assertPlainRecord(input.site, "AWCP site", "awcp_invalid_contract");
  assertExactKeys(input.site, ["description", "name"], "AWCP site", "awcp_invalid_contract");
  assertText(input.site.name, "AWCP site name", AWCP_LIMITS.maxTitleLength);
  assertText(input.site.description, "AWCP site description", AWCP_LIMITS.maxDescriptionLength);
  if (!Array.isArray(input.sections) || input.sections.length > AWCP_LIMITS.maxSections) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP section index.");
  }
  let previous = "";
  for (const item of input.sections) {
    assertPlainRecord(item, "AWCP section summary", "awcp_invalid_contract");
    assertExactKeys(item, ["section", "title"], "AWCP section summary", "awcp_invalid_contract");
    assertAction(item.section, "section", "awcp_invalid_contract");
    if (item.section <= previous) {
      throw awcpHostError("awcp_invalid_contract", "AWCP sections must be strictly sorted.");
    }
    assertText(item.title, "AWCP section title", AWCP_LIMITS.maxTitleLength);
    previous = item.section;
  }
  if (Buffer.byteLength(stableAwcpJSON(input), "utf8") > AWCP_LIMITS.maxIndexBytes) {
    throw awcpHostError("awcp_invalid_contract", "The page AWCP manual index exceeds 64 KiB.");
  }
  return input as AwcpManualIndex;
}

function validateManualSection(input: unknown, requestedSection: string, requestedRevision: string): AwcpManualSection {
  assertPlainRecord(input, "AWCP manual section", "awcp_invalid_contract");
  const expected = Object.prototype.hasOwnProperty.call(input, "examples")
    ? ["description", "examples", "inputSchema", "revision", "section"]
    : ["description", "inputSchema", "revision", "section"];
  assertExactKeys(input, expected, "AWCP manual section", "awcp_invalid_contract");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength, "awcp_invalid_contract");
  assertAction(input.section, "section", "awcp_invalid_contract");
  if (input.section !== requestedSection || input.revision !== requestedRevision) {
    throw awcpHostError("awcp_invalid_contract", "The page returned a different AWCP manual section.");
  }
  assertText(input.description, "AWCP section description", AWCP_LIMITS.maxDescriptionLength);
  assertPlainRecord(input.inputSchema, "AWCP inputSchema", "awcp_invalid_contract");
  assertJsonValue(input.inputSchema, "AWCP inputSchema", "awcp_invalid_contract");
  if (Object.prototype.hasOwnProperty.call(input, "examples")) {
    if (!Array.isArray(input.examples) || input.examples.length > AWCP_LIMITS.maxExamples) {
      throw awcpHostError("awcp_invalid_contract", "AWCP examples must be a bounded array.");
    }
    input.examples.forEach((example, index) => {
      assertPlainRecord(example, `AWCP example ${index}`, "awcp_invalid_contract");
      assertJsonValue(example, `AWCP example ${index}`, "awcp_invalid_contract");
    });
  }
  if (Buffer.byteLength(stableAwcpJSON(input), "utf8") > AWCP_LIMITS.maxSectionBytes) {
    throw awcpHostError("awcp_invalid_contract", "The page AWCP manual section exceeds 256 KiB.");
  }
  return input as AwcpManualSection;
}

function validateManualError(input: unknown, requestedSection: string): "section_not_found" | "stale_revision" | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "error")) return null;
  if (Object.keys(record).join(",") !== "error") {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  const error = record.error as Record<string, unknown>;
  if (Object.keys(error).sort().join(",") !== "code,message,section" ||
      (error.code !== "section_not_found" && error.code !== "stale_revision") ||
      error.section !== requestedSection || typeof error.message !== "string" || !error.message.trim() ||
      error.message.length > AWCP_LIMITS.maxErrorMessageLength) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  return error.code;
}

function stableAwcpJSON(value: unknown): string {
  const order = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(order);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, order(record[key])]));
    }
    return input;
  };
  return JSON.stringify(order(value));
}

function assertText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw awcpHostError("awcp_invalid_contract", `${name} must be non-empty and at most ${maximum} characters.`);
  }
}

function awcpPreflightFailure(
  reason: "stale_revision" | "action_not_found" | "page_changed" | "manual_required",
  message: string,
) {
  return awcpHostError("awcp_preflight_rejected", message, {
    reason, stage: "desktop_preflight", executionStarted: false,
  });
}

function validateActionResponse(input: unknown, requestId: string, action: string): AwcpActionResponse {
  assertPlainRecord(input, "AWCP response", "awcp_invalid_response");
  assertJsonValue(input, "AWCP response", "awcp_invalid_response");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > AWCP_LIMITS.maxResponseBytes) {
    throw awcpHostError("awcp_response_too_large", "The page AWCP response exceeds 64 MiB.");
  }
  if (input.requestId !== requestId || input.action !== action) {
    throw awcpHostError("awcp_response_mismatch", "The page AWCP response does not match its request.");
  }
  if (input.ok === true) {
    assertExactKeys(input, ["action", "ok", "requestId", "result"], "AWCP success response", "awcp_invalid_response");
    return input as AwcpActionResponse;
  }
  if (input.ok !== false) throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP response.");
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
  if (typeof input.error.message !== "string" || !input.error.message.trim() ||
      input.error.message.length > AWCP_LIMITS.maxErrorMessageLength) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error message.");
  }
  if (Object.prototype.hasOwnProperty.call(input.error, "details") &&
      Buffer.byteLength(JSON.stringify(input.error.details), "utf8") > AWCP_LIMITS.maxErrorDetailsBytes) {
    throw awcpHostError("awcp_invalid_response", "The page returned oversized AWCP error details.");
  }
  return input as AwcpActionResponse;
}

function assertAction(value: unknown, name = "action", code = "awcp_invalid_request"): asserts value is string {
  if (typeof value !== "string" || !value || value.length > AWCP_LIMITS.maxActionLength || !AWCP_ACTION_PATTERN.test(value)) {
    throw awcpHostError(code, `AWCP ${name} is invalid.`);
  }
}

function assertToken(
  name: string,
  value: unknown,
  maxLength: number,
  code = "awcp_invalid_request",
): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw awcpHostError(code, `AWCP ${name} is invalid.`);
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
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
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
    if (!value || typeof value !== "object") throw awcpHostError(code, `${name} contains a non-JSON value.`);
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
      for (const item of value) visit(item, ancestors);
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
  const statusCode = code === "awcp_invalid_request" || code === "awcp_preflight_rejected"
    ? 400
    : code === "awcp_duplicate_request" || code === "site_control_unavailable"
      ? 409
      : 502;
  return new AwcpHostError(code, statusCode, message, details);
}

function isAwcpHostError(error: unknown): error is AwcpHostError {
  return error instanceof AwcpHostError;
}
