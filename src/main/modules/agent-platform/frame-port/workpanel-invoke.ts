import { type WebContents } from "electron";
import {
  AGENT_WEBCLIENT_BRIDGE_VERSION,
  isAgentWebclientBridgeVersion,
  isPlainBridgeRecord,
  type AgentWebclientBridgeFailure,
  type WorkPanelItem,
  type WorkPanelItemTargetInput,
  type WorkPanelOpenDocumentInput,
  type WorkPanelOpenItemInput,
  type WorkPanelOpenResourceInput,
  type WorkPanelWorkspace,
  type WorkPanelCapability,
  type WorkPanelDocumentOpenOptionsResult,
  type WorkPanelDocumentOpenCopyResult,
} from "../../../../shared/contracts";
import { normalizeWorkPanelDocumentSource, sameWorkPanelDocumentSource } from "../../../../shared/work-panel-document-source";
import { reportDeprecatedCompatibilityUse } from "../../../support/logging/deprecated-compatibility";
import type { FramePortOptions } from "../ipc.shared";
import { failure, readText, SURFACE_REGISTRATION_WAIT_MS } from "../ipc.shared";
import { authorizeSurface, mayAwaitSurfaceRegistration } from "./surface-authorization";

export interface WorkpanelInvokePort {
  readonly options: {
    browserSurfaces: FramePortOptions["browserSurfaces"];
    isTrustedAgentWebclientSession: FramePortOptions["isTrustedAgentWebclientSession"];
    normalizeWorkPanelOpenLocalResourceRequest: FramePortOptions["normalizeWorkPanelOpenLocalResourceRequest"];
    openResource: FramePortOptions["openResource"];
    openDocument: FramePortOptions["openDocument"];
    documentLocalOpen?: FramePortOptions["documentLocalOpen"];
    dispatchWorkPanel: FramePortOptions["dispatchWorkPanel"];
  };
}

export function normalizeDocumentWorkspacePath(value: unknown) {
  const requestedPath = typeof value === "string" ? value : "";
  return requestedPath.trim() && requestedPath.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(requestedPath)
    ? requestedPath.replace(/\\/gu, "/")
    : "";
}

export function createWorkpanelInvoke(deps: WorkpanelInvokePort) {
  const openingGuests = new Set<number>();
  async function handleWorkPanelInvoke(event: { sender: WebContents }, call: unknown): Promise<AgentWebclientBridgeFailure | WorkPanelDocumentOpenOptionsResult | WorkPanelDocumentOpenCopyResult | { ok: true; workspaceId: string; itemId: string; renderer: "native-html" | "native-image"; } | { ok: true; workspaceId: string; item?: WorkPanelItem; state?: WorkPanelWorkspace; } | { ok: boolean; capabilities: WorkPanelCapability[]; }> {
    let context = authorizeSurface(event.sender, deps.options.browserSurfaces, deps.options.isTrustedAgentWebclientSession);
    if ("ok" in context && isPlainBridgeRecord(call) && call.method === "getCapabilities" &&
      !deps.options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id) &&
      mayAwaitSurfaceRegistration(event.sender, deps.options.isTrustedAgentWebclientSession)) {
      await deps.options.browserSurfaces.waitForWebviewSurfaceTargetMatching(event.sender.id, () => true, SURFACE_REGISTRATION_WAIT_MS);
      context = authorizeSurface(event.sender, deps.options.browserSurfaces, deps.options.isTrustedAgentWebclientSession);
    }
    if ("ok" in context)
      return context;
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId)
      return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    if (context.kind === "agent-selection-explain") {
      return method === "getCapabilities"
        ? { ok: true, capabilities: [] }
        : failure("capability_denied", "selection explanation cannot access WorkPanel");
    }
    const documentSurface = context.kind === "agent-management" &&
      context.target.surfaceLevel === "child" &&
      ["file", "artifact", "reference"].includes(context.target.surfaceRole);
    const documentSource = normalizeWorkPanelDocumentSource(context.target.documentSource);
    const localDocumentAllowed = Boolean(documentSurface && documentSource && deps.options.documentLocalOpen &&
      context.target.surfaceRole === (documentSource.kind === "workspace-file" ? "file" : documentSource.kind) &&
      (documentSource.kind === "workspace-file" || documentSource.chatId === ownerChatId));
    const capabilities: WorkPanelCapability[] = [
      ...(localDocumentAllowed ? ["workpanel.document.open-local" as const] : []),
      ...(localDocumentAllowed && deps.options.documentLocalOpen?.openDocument ? ["workpanel.document.open-local-direct" as const] : []),
      ...(context.kind === "agent-chat" || context.kind === "agent-copilot" || context.kind === "agent-overview"
        || documentSurface
        ? ["workpanel.open" as const]
        : []),
      "workpanel.activate" as const,
      "workpanel.close" as const,
    ];
    if (method === "getCapabilities")
      return { ok: true, capabilities };
    if (method === "getDocumentOpenOptions" || method === "openDocumentCopy" || method === "openDocumentInLocalApp") {
      if (!localDocumentAllowed || !documentSource || !deps.options.documentLocalOpen)
        return failure("capability_denied", "This surface cannot open local documents");
      if (method === "openDocumentInLocalApp" && !deps.options.documentLocalOpen.openDocument)
        return failure("capability_denied", "Direct document opening is unavailable");
      const opening = method !== "getDocumentOpenOptions";
      const input = isPlainBridgeRecord(record.input) ? record.input : {};
      if (!isAgentWebclientBridgeVersion(input.version))
        return failure("version_mismatch", `Desktop host bridge requires version ${AGENT_WEBCLIENT_BRIDGE_VERSION}`);
      const allowedKeys = opening ? ["version", "source", "applicationId"] : ["version", "source"];
      if (Object.keys(input).some((key) => !allowedKeys.includes(key)) ||
        !sameWorkPanelDocumentSource(input.source, documentSource))
        return failure("capability_denied", "Document does not match the host-owned WorkPanel item");
      const initial = { ...context.target };
      const initialUrl = event.sender.getURL();
      let documentInvalidated = false;
      const invalidateDocument = () => { documentInvalidated = true; };
      const onNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame) invalidateDocument();
      };
      const stillOwned = () => {
        if (documentInvalidated) return false;
        const current = authorizeSurface(event.sender, deps.options.browserSurfaces, deps.options.isTrustedAgentWebclientSession);
        return !("ok" in current) && current.kind === "agent-management" && current.target.surfaceLevel === "child" &&
          current.target.registrationId === initial.registrationId &&
          current.target.ownerWebContentsId === initial.ownerWebContentsId &&
          current.target.surfaceId === initial.surfaceId && current.target.ownerChatId === ownerChatId &&
          current.target.surfaceRole === initial.surfaceRole &&
          (!opening || current.target.active) &&
          event.sender.getURL() === initialUrl &&
          sameWorkPanelDocumentSource(current.target.documentSource, documentSource);
      };
      if (!stillOwned()) return failure("surface_unavailable", "Document surface is no longer available");
      if (opening && (typeof input.applicationId !== "string" || !input.applicationId.trim() || input.applicationId.length > 256))
        return failure("invalid_request", "Invalid local application identity");
      if (opening && openingGuests.has(event.sender.id))
        return failure("duplicate_id", "A local document open is already pending");
      if (opening) openingGuests.add(event.sender.id);
      // A reload can keep both URL and host registration id unchanged. Bind
      // in-flight native work to this document lifetime as well as its source.
      event.sender.on("did-start-navigation", onNavigation);
      event.sender.on("render-process-gone", invalidateDocument);
      event.sender.on("destroyed", invalidateDocument);
      try {
        if (method === "getDocumentOpenOptions") return await deps.options.documentLocalOpen.getOptions(documentSource, stillOwned);
        if (method === "openDocumentInLocalApp") return await deps.options.documentLocalOpen.openDocument!(documentSource, input.applicationId as string, stillOwned);
        return await deps.options.documentLocalOpen.openCopy(documentSource, input.applicationId as string, stillOwned);
      } finally {
        if (opening) openingGuests.delete(event.sender.id);
        event.sender.removeListener("did-start-navigation", onNavigation);
        event.sender.removeListener("render-process-gone", invalidateDocument);
        event.sender.removeListener("destroyed", invalidateDocument);
      }
    }
    const capabilityAllowed = method === "openItem" || method === "openResource" || method === "openDocument"
      ? capabilities.includes("workpanel.open")
      : method === "activateItem" || method === "closeItem";
    if (!capabilityAllowed)
      return failure("capability_denied", `${context.kind} cannot call ${method}`);
    const input = record.input as WorkPanelOpenItemInput | WorkPanelOpenResourceInput | WorkPanelOpenDocumentInput | WorkPanelItemTargetInput;
    const inputVersion: unknown = isPlainBridgeRecord(input)
      ? (input as Record<string, unknown>).version
      : undefined;
    const compatibleVersion = isAgentWebclientBridgeVersion(inputVersion) ||
      ((inputVersion === 4 || inputVersion === 5) && method !== "openResource" && method !== "openDocument") ||
      (inputVersion === 5 && method === "openResource");
    if (!compatibleVersion) {
      return failure("version_mismatch", `Desktop host bridge requires version ${AGENT_WEBCLIENT_BRIDGE_VERSION}`);
    }
    // Document guests may open a preview website in their registered owner Chat,
    // but do not inherit the Chat surface's native/document opening privileges.
    if (documentSurface && (method === "openItem" || method === "openResource" || method === "openDocument")) {
      const descriptor = (input as WorkPanelOpenItemInput).descriptor;
      if (method !== "openItem" || !isPlainBridgeRecord(descriptor) || descriptor.kind !== "web") {
        return failure("capability_denied", "Document surfaces may only open WorkPanel websites");
      }
      if (Object.keys(input).some((key) => !["version", "descriptor"].includes(key)) ||
        Object.keys(descriptor).some((key) => !["kind", "url", "title", "pinned", "closable"].includes(key))) {
        return failure("invalid_request", "Invalid document preview website request");
      }
      try {
        const url = new URL(readText(descriptor.url));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid URL");
      } catch {
        return failure("invalid_request", "Document preview requires an HTTP(S) URL without credentials");
      }
    }
    if (inputVersion === 4 || inputVersion === 5) {
      reportDeprecatedCompatibilityUse(inputVersion === 4 ? "agent-webclient.bridge-v4" : "agent-webclient.bridge-v5", { version: inputVersion, method });
    }
    if (method === "openResource") {
      const resourceInput = input as WorkPanelOpenResourceInput;
      const allowedKeys = new Set([
        "version", "profile", "agentKey", "chatId", "resourceId", "relativePath", "title",
      ]);
      if (Object.keys(resourceInput).some((key) => !allowedKeys.has(key)) ||
        (resourceInput.profile !== "artifact" && resourceInput.profile !== "reference") ||
        !readText(resourceInput.agentKey) ||
        !readText(resourceInput.chatId) ||
        !readText(resourceInput.resourceId) ||
        !readText(resourceInput.relativePath) ||
        (resourceInput.title !== undefined && !readText(resourceInput.title)))
        return failure("invalid_request", "Invalid native image resource request");
      if (resourceInput.chatId.trim() !== ownerChatId) {
        return failure("capability_denied", "Resource chat does not match the trusted owner Chat");
      }
      const normalizedResource = deps.options.normalizeWorkPanelOpenLocalResourceRequest({
        ownerChatId,
        profile: resourceInput.profile,
        relativePath: resourceInput.relativePath,
      });
      if (!normalizedResource) {
        return failure("invalid_request", "Invalid native image resource path");
      }
      return deps.options.openResource({
        ownerChatId,
        resource: {
          profile: resourceInput.profile,
          agentKey: resourceInput.agentKey.trim(),
          chatId: resourceInput.chatId.trim(),
          resourceId: resourceInput.resourceId.trim(),
          relativePath: normalizedResource.relativePath,
          ...(resourceInput.title ? { title: resourceInput.title.trim() } : {}),
        },
      });
    }
    if (method === "openDocument") {
      const documentInput = input as WorkPanelOpenDocumentInput;
      if (Object.keys(documentInput).some((key) => !["version", "source", "title"].includes(key)) ||
        !isPlainBridgeRecord(documentInput.source) ||
        (documentInput.title !== undefined && !readText(documentInput.title)))
        return failure("invalid_request", "Invalid native document request");
      const source = documentInput.source;
      const sourceKind = source.kind;
      const agentKey = readText(source.agentKey);
      if (!agentKey)
        return failure("invalid_request", "Invalid native document Agent");
      if (sourceKind === "workspace-file") {
        if (Object.keys(source).some((key) => !["kind", "agentKey", "path"].includes(key)) ||
          !readText(source.path))
          return failure("invalid_request", "Invalid workspace document request");
        const normalizedPath = normalizeDocumentWorkspacePath(source.path);
        if (!normalizedPath)
          return failure("invalid_request", "Invalid workspace document path");
        return deps.options.openDocument({
          ownerChatId,
          document: {
            source: { kind: "workspace-file", agentKey, path: normalizedPath },
            ...(documentInput.title ? { title: documentInput.title.trim() } : {}),
          },
        });
      }
      if (sourceKind !== "artifact" && sourceKind !== "reference") {
        return failure("invalid_request", "Invalid document source");
      }
      if (Object.keys(source).some((key) => !["kind", "agentKey", "chatId", "resourceId", "relativePath"].includes(key)) ||
        !readText(source.chatId) || !readText(source.resourceId) || !readText(source.relativePath) ||
        source.chatId.trim() !== ownerChatId)
        return failure("capability_denied", "Document does not match the trusted owner Chat");
      const normalized = deps.options.normalizeWorkPanelOpenLocalResourceRequest({
        ownerChatId,
        profile: sourceKind,
        relativePath: source.relativePath,
      });
      if (!normalized)
        return failure("invalid_request", "Invalid document resource path");
      return deps.options.openDocument({
        ownerChatId,
        document: {
          source: {
            kind: sourceKind,
            agentKey,
            chatId: ownerChatId,
            resourceId: source.resourceId.trim(),
            relativePath: normalized.relativePath,
          },
          ...(documentInput.title ? { title: documentInput.title.trim() } : {}),
        },
      });
    }
    if (method === "openItem" &&
      isPlainBridgeRecord((input as WorkPanelOpenItemInput).descriptor) &&
      (input as WorkPanelOpenItemInput).descriptor.kind === "native")
      return failure("capability_denied", "Native WorkPanel descriptors are host-only");
    const args = method === "openItem"
      ? { descriptor: (input as WorkPanelOpenItemInput).descriptor }
      : { itemId: (input as WorkPanelItemTargetInput).itemId };
    return deps.options.dispatchWorkPanel({
      action: method as "openItem" | "activateItem" | "closeItem",
      ownerChatId,
      args,
    });
  }
  return { handleWorkPanelInvoke };
}
