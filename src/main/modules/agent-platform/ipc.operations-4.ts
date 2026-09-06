import type { App, WebContents } from "electron";

import { randomUUID } from "node:crypto";

import {
  AGENT_WEBCLIENT_BRIDGE_VERSION,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
  isAgentWebclientBridgeVersion,
  isPlainBridgeRecord,
  type AgentPlatformRequestFrame,
  type AgentWebclientBridgeErrorCode,
  type AgentWebclientBridgeFailure,
  type AgentWebclientPlatformFramePortCloseInput,
  type AgentWebclientPlatformFramePortEvent,
  type AgentWebclientPlatformFramePortOpenInput,
  type AgentWebclientPlatformFramePortSendInput,
  type DesktopPlatformConnectionState,
  type DesktopPlatformSessionClose,
  type AgentWebclientRunOwner,
  type AgentWebclientSurfaceKind,
  type WorkPanelBridgeResult,
  type WorkPanelItem,
  type WorkPanelItemTargetInput,
  type WorkPanelWorkspace,
  type WorkPanelOpenItemInput,
  type WorkPanelOpenDocumentInput,
  type WorkPanelOpenDocumentResult,
  type WorkPanelOpenResourceInput,
  type WorkPanelOpenResourceResult,
  type CanonicalChatSyncRequest,
  type CanonicalChatSyncResult,
} from "../../../shared/contracts";

import type { AgentAuthIssueResult, ServiceState } from "../../../shared/contracts";

import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../web-surfaces";

import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "./realtime/realtime-broker";

import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "../../../shared/surface-identity";

import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource,
} from "../../../shared/canonical-chat-sync";

import { readAgentWebclientAgentRouteKey } from "../../../shared/agent-webclient-routes";

import { requireAgentPlatformEpochMillis } from "../../../shared/time-contract";

import { isDesktopDevelopmentRuntime } from "../../infrastructure/electron/development-runtime";

import { reportDeprecatedCompatibilityUse } from "../../support/logging/deprecated-compatibility";

import type { RegisterAgentWebclientBridgeIpcHandlersContext } from "./ipc.shared";

import { AGENT_PLATFORM_SERVICE_ID, ClosedLogicalSessionDiagnostic, FrameErrorOptions, LIVE_CHAT_SURFACE_IDS, LIVE_REQUEST_TYPES, LogicalSession, MAX_SERIALIZED_FRAME_BYTES, PlatformFrameRecord, RootObserverContextSource, SURFACE_REGISTRATION_WAIT_MS, StreamBinding, SurfaceContext, authorizeSurface, bridgeErrorCode, bridgeErrorWithMetadata, createRootObserverToken, describeMainChatRouteIdentity, failure, frameError, frameErrorOptions, mainChatQueryRouteAgentKeys, mainChatQueryTargetIsReady, mainChatQueryTargetIsTransitional, mayAwaitSurfaceRegistration, normalizeDocumentWorkspacePath, parseRequestFrame, protocolError, readNormalizedStreamEvent, readOwner, readText, resolveNewChatQuerySource, rootObserverContextId, rootObserverKind, sameNewChatSource, sameOrigin, sameOwner, sessionKey, streamBindingDiagnostic, trustedKind, updateBindingFromFrame, validateMainChatQueryAgentIdentity, validateMainChatQuerySenderChatIdentity, validateMainChatQueryTargetAgentIdentity } from "./ipc.shared";

export function registerAgentWebclientBridgeIpcHandlers_handleClose_1(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, event: any, input: AgentWebclientPlatformFramePortCloseInput): void {
    const session = factoryContext.resolveSession(event.sender, readText(input?.sessionId));
    if (!session)
        return;
    for (const binding of session.streams.values()) {
        binding.suppressed = true;
        void factoryContext.detachBinding(session, binding).catch(() => undefined);
    }
    factoryContext.closeSession(session, input?.reason === "surface_inactive" ? "surface_inactive" : "disposed");
}

export async function registerAgentWebclientBridgeIpcHandlers_handleWorkPanelInvoke_2(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, event: any, call: unknown): Promise<AgentWebclientBridgeFailure | { ok: true; workspaceId: string; itemId: string; renderer: "native-html" | "native-image"; } | { ok: true; workspaceId: string; item?: WorkPanelItem; state?: WorkPanelWorkspace; } | { ok: boolean; capabilities: ("workpanel.open" | "workpanel.activate" | "workpanel.close")[]; }> {
    const context = authorizeSurface(event.sender, factoryContext.options.browserSurfaces, factoryContext.options.isTrustedAgentWebclientSession);
    if ("ok" in context)
        return context;
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId)
        return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    const capabilities = [
        ...(context.kind === "agent-chat" || context.kind === "agent-copilot" || context.kind === "agent-overview"
            ? ["workpanel.open" as const]
            : []),
        "workpanel.activate" as const,
        "workpanel.close" as const,
    ];
    if (method === "getCapabilities")
        return { ok: true, capabilities };
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
        const normalizedResource = factoryContext.options.normalizeWorkPanelOpenLocalResourceRequest({
            ownerChatId,
            profile: resourceInput.profile,
            relativePath: resourceInput.relativePath,
        });
        if (!normalizedResource) {
            return failure("invalid_request", "Invalid native image resource path");
        }
        return factoryContext.options.openResource({
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
            return factoryContext.options.openDocument({
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
        const normalized = factoryContext.options.normalizeWorkPanelOpenLocalResourceRequest({
            ownerChatId,
            profile: sourceKind,
            relativePath: source.relativePath,
        });
        if (!normalized)
            return failure("invalid_request", "Invalid document resource path");
        return factoryContext.options.openDocument({
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
    return factoryContext.options.dispatchWorkPanel({
        action: method as "openItem" | "activateItem" | "closeItem",
        ownerChatId,
        args,
    });
}
