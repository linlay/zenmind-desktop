import { createWebSurfaceId } from "../../../../shared/web-surface";
import type { WebContents } from "electron";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import { PAGE_AUTOMATION_HELD_CODE, isPageAutomationHeld } from "../cdp/command-queue";
import type { SiteControlScope } from "../cdp/site-scope";
import { AwcpManualBindings } from "./discovery-binding";

import {
  AWCP_LIMITS, AWCP_PROTOCOL_VERSION,
  assertToken, assertJsonValue, assertPlainRecord,
  validateManualPayload, validateInvokePayload, validateManualIndex,
  validateManualSection, validateManualError, validateActionResponse,
  awcpHostError, awcpPreflightFailure, isAwcpHostError,
  type AwcpManualPayload, type AwcpActionResponse, type AwcpManualResponse,
} from "../../awcp";

// Keep the existing native module's public contract while both transports use
// the same protocol implementation through the AWCP domain entry point.
export { AWCP_PROTOCOL_VERSION, AWCP_ACTION_PATTERN, AWCP_LIMITS } from "../../awcp";
export type { AwcpManualPayload, AwcpInvokePayload, AwcpActionResponse, AwcpManualResponse } from "../../awcp";

type ActiveInvocation = {
  guest: WebContents;
  cancel(error: Error): void;
};

export class AwcpGuestBridge {
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly manuals = new AwcpManualBindings();

  constructor(private readonly browserSurfaces: Pick<BrowserSurfaceRegistry, "findWebContentsById"> & Partial<Pick<BrowserSurfaceRegistry, "ensureWebsiteBridge">>) {}

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
    // The first tool request may beat registration/dom-ready injection. Installation
    // is idempotent, URL-checked in both worlds, and runs only after scope validation.
    await Promise.race([this.browserSurfaces.ensureWebsiteBridge?.(guest), lifecycleFailure]);
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
    if (isPageAutomationHeld(guest.id)) {
      throw awcpHostError(PAGE_AUTOMATION_HELD_CODE, "Desktop is filling a saved password into this page. Wait and retry.");
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

function cancelGuest(guest: WebContents, requestId: string) {
  if (guest.isDestroyed()) return Promise.resolve();
  return guest.executeJavaScript(`globalThis.awcp?.cancel(${JSON.stringify(requestId)}) ?? false`, true)
    .then(() => undefined, () => undefined);
}
