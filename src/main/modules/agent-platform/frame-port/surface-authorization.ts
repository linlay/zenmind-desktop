import { type WebContents } from "electron";
import { readAgentWebclientAgentRouteKey } from "../../../../shared/agent-webclient-routes";
import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource,
} from "../../../../shared/canonical-chat-sync";
import { type AgentWebclientBridgeFailure, type AgentWebclientSurfaceKind } from "../../../../shared/contracts";
import { decodeRoutePathSegment } from "../../../../shared/route-path";
import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID,
  SELECTION_EXPLAIN_SURFACE_ID,
} from "../../../../shared/surface-identity";
import { type BrowserSurfaceRegistry, type RegisteredWebviewSurfaceTarget } from "../../web-surfaces";
import type { FramePortOptions } from "../ipc.shared";
import {
  LogicalSession,
  SURFACE_REGISTRATION_WAIT_MS,
  StreamBinding,
  SurfaceContext,
  failure,
  protocolError,
  readOwner,
  readText,
} from "../ipc.shared";

export interface SurfaceAuthorizationPort {
  readonly options: {
    browserSurfaces: Pick<FramePortOptions["browserSurfaces"], "resolveWebviewSurfaceTarget" | "waitForWebviewSurfaceTargetMatching">;
    realtimeBroker: Pick<FramePortOptions["realtimeBroker"], "appendDebugTrace">;
    isTrustedAgentWebclientSession: FramePortOptions["isTrustedAgentWebclientSession"];
  };
}

export function trustedKind(value: unknown): AgentWebclientSurfaceKind | null {
  return value === "agent-chat" ||
    value === "agent-copilot" ||
    value === "agent-overview" ||
    value === "agent-debug" ||
    value === "agent-btw" ||
    value === "agent-selection-explain" ||
    value === "agent-project" ||
    value === "agent-management"
    ? value
    : null;
}

export function rootObserverKind(target: RegisteredWebviewSurfaceTarget) {
  if (target.surfaceId === MAIN_CHAT_SURFACE_ID && target.surfaceRole === "main-chat") return "main_chat" as const;
  if (target.surfaceId === COPILOT_DOCK_SURFACE_ID && target.surfaceRole === "copilot-dock") return "copilot_dock" as const;
  if (target.surfaceId === KANBAN_CHAT_SURFACE_ID && target.surfaceRole === "kanban-chat") return "kanban_chat" as const;
  if (
    target.surfaceId === SELECTION_EXPLAIN_SURFACE_ID &&
    target.surfaceRole === "selection-explain"
  ) return "selection_explain" as const;
  return null;
}

export type RootObserverContextSource = Pick<
  RegisteredWebviewSurfaceTarget,
  "surfaceId" | "registrationId" | "surfaceRole" | "surfaceIdentityKey" | "ownerChatId"
>;

export function rootObserverContextId(
  target: RootObserverContextSource,
  payloadChatId = "",
) {
  const chatId = target.ownerChatId?.trim() || payloadChatId.trim();
  const fallback = `${target.surfaceId}:${target.registrationId}`;
  if (target.surfaceRole !== "copilot-dock") return chatId || fallback;
  return [target.surfaceIdentityKey?.trim() || fallback, chatId].filter(Boolean).join(":");
}

export function createRootObserverToken(target: RegisteredWebviewSurfaceTarget, contextId: string) {
  return [
    target.surfaceId,
    target.registrationId,
    target.ownerWebContentsId,
    target.webContentsId,
    contextId,
  ].join(":");
}

export function rootObserverNewChatSourceKey(target: { pageRouteIdentity?: string }) {
  const source = readAgentWebclientNewChatSource(target.pageRouteIdentity ?? "");
  return source ? JSON.stringify([source.agentKey, source.newChat]) : "";
}

export function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function mayAwaitSurfaceRegistration(
  sender: WebContents,
  isTrustedSession: (sender: WebContents) => boolean,
) {
  return !sender.isDestroyed() &&
    sender.getType() === "webview" &&
    isTrustedSession(sender);
}

export function authorizeSurface(
  sender: WebContents,
  browserSurfaces: Pick<BrowserSurfaceRegistry, "resolveWebviewSurfaceTarget">,
  isTrustedSession: (sender: WebContents) => boolean,
): SurfaceContext | AgentWebclientBridgeFailure {
  const target = browserSurfaces.resolveWebviewSurfaceTarget(sender.id);
  const kind = trustedKind(target?.surfaceType);
  if (
    !target ||
    target.webContentsId !== sender.id ||
    !kind ||
    target.serviceId !== "agent-webclient" ||
    !isTrustedSession(sender) ||
    sender.isDestroyed() ||
    sender.getType() !== "webview" ||
    !sameOrigin(sender.getURL(), target.currentUrl)
  ) {
    return failure("surface_unavailable", "sender is not a trusted Agent WebClient surface");
  }
  return { sender, target, kind };
}

export function resolveAttachChatId(context: SurfaceContext, payload: Record<string, unknown>): string {
  const payloadChatId = readText(payload.chatId);
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  if (rootObserverKind(context.target) !== "copilot_dock") return payloadChatId || ownerChatId;

  // Attach's wire payload identifies the Run, not its Chat. Unlike Main Chat,
  // the persistent Dock has no registered ownerChatId; its guest owns Chat navigation.
  const url = new URL(context.sender.getURL());
  const routeMatch = /^\/copilot\/([^/]+)$/u.exec(url.pathname);
  const agentKey = routeMatch ? decodeRoutePathSegment(routeMatch[1]) : null;
  const chatIds = url.searchParams.getAll("chatId");
  const chatId = chatIds[0]?.trim() || "";
  const owner = readOwner(payload);
  if (!agentKey || chatIds.length !== 1 || !chatId || url.searchParams.has("newChat")) {
    throw protocolError("Copilot attach requires a canonical guest Chat route");
  }
  if (owner?.kind !== "agent" || owner.agentKey !== agentKey ||
    (payloadChatId && payloadChatId !== chatId) || (ownerChatId && ownerChatId !== chatId)) {
    throw protocolError("Copilot attach identity does not match the current guest Chat");
  }
  return chatId;
}

export function sameNewChatSource(
  left: ReturnType<typeof readAgentWebclientNewChatSource>,
  right: ReturnType<typeof readAgentWebclientNewChatSource>,
) {
  return Boolean(
    left &&
    right &&
    left.agentKey === right.agentKey &&
    left.newChat === right.newChat
  );
}

export function describeMainChatRouteIdentity(value: string | undefined) {
  if (readAgentWebclientNewChatSource(value ?? "")) return "new-chat";
  if (readAgentWebclientCanonicalChatSource(value ?? "")) return "canonical";
  if (readAgentWebclientAgentRouteKey(value ?? "")) return "agent-route";
  return "invalid";
}

export function mainChatQueryRouteAgentKeys(target: RegisteredWebviewSurfaceTarget) {
  return [
    readAgentWebclientAgentRouteKey(target.currentUrl),
    readAgentWebclientAgentRouteKey(target.pageRouteIdentity ?? ""),
    readAgentWebclientAgentRouteKey(target.pageRoute ?? ""),
  ];
}

export function validateMainChatQueryTargetAgentIdentity(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  if (
    target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  const owner = readOwner(payload);
  const routeAgentKeys = mainChatQueryRouteAgentKeys(target);
  if (
    !owner ||
    owner.kind !== "agent" ||
    routeAgentKeys.some((agentKey) => !agentKey || agentKey !== owner.agentKey)
  ) {
    throw protocolError("query Agent owner does not match its active Main Chat route");
  }
}

export function validateMainChatQueryAgentIdentity(
  context: SurfaceContext,
  payload: Record<string, unknown>,
) {
  if (
    context.target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    context.target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  validateMainChatQueryTargetAgentIdentity(context.target, payload);
  const owner = readOwner(payload);
  if (
    !owner ||
    owner.kind !== "agent" ||
    readAgentWebclientAgentRouteKey(context.sender.getURL()) !== owner.agentKey
  ) {
    throw protocolError("query Agent owner does not match its active Main Chat route");
  }
}

export function resolveNewChatQuerySource(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  if (target.surfaceId !== MAIN_CHAT_SURFACE_ID || target.surfaceType !== "agent-chat") return null;
  const ownerChatId = target.ownerChatId?.trim() || "";
  const guestSource = readAgentWebclientNewChatSource(target.currentUrl);
  const pageSource = readAgentWebclientNewChatSource(target.pageRouteIdentity ?? "");
  if (ownerChatId) {
    const payloadChatId = readText(payload.chatId);
    const pageCanonical = readAgentWebclientCanonicalChatSource(
      target.pageRouteIdentity ?? "",
    );
    if (!pageCanonical || pageCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its Desktop route");
    }
    if (guestSource) {
      if (payloadChatId === ownerChatId) return null;
      throw protocolError("new Chat query source does not match its active Main Chat route");
    }
    const guestCanonical = readAgentWebclientCanonicalChatSource(target.currentUrl);
    if (!guestCanonical || guestCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its guest route");
    }
    if (payloadChatId && payloadChatId !== ownerChatId) {
      throw protocolError("canonical Chat query does not match its active Main Chat owner");
    }
    return null;
  }
  if (!sameNewChatSource(guestSource, pageSource)) {
    throw protocolError("new Chat query requires an exact agentKey and newChat route source");
  }
  const expectedOwner = readOwner(payload);
  if (
    !expectedOwner ||
    expectedOwner.kind !== "agent" ||
    expectedOwner.agentKey !== guestSource!.agentKey
  ) {
    throw protocolError("new Chat query source does not match its active Main Chat route");
  }
  return {
    registrationId: target.registrationId,
    ownerWebContentsId: target.ownerWebContentsId,
    guestWebContentsId: target.webContentsId,
    agentKey: guestSource!.agentKey,
    newChat: guestSource!.newChat,
  };
}

export function validateMainChatQuerySenderChatIdentity(
  context: SurfaceContext,
  payload: Record<string, unknown>,
  newChatSource: StreamBinding["newChatSource"],
) {
  if (
    context.target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    context.target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  const senderUrl = context.sender.getURL();
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  if (ownerChatId) {
    const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
    if (senderNewChat) {
      if (readText(payload.chatId) === ownerChatId) return;
      throw protocolError("new Chat query source does not match its active Main Chat route");
    }
    const senderCanonical = readAgentWebclientCanonicalChatSource(senderUrl);
    if (!senderCanonical || senderCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its sender route");
    }
    return;
  }
  const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
  if (
    !newChatSource ||
    !senderNewChat ||
    senderNewChat.agentKey !== newChatSource.agentKey ||
    senderNewChat.newChat !== newChatSource.newChat
  ) {
    throw protocolError("new Chat query requires an exact agentKey and newChat sender route");
  }
}

export function mainChatQueryTargetIsReady(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  try {
    validateMainChatQueryTargetAgentIdentity(target, payload);
    resolveNewChatQuerySource(target, payload);
    return true;
  } catch {
    return false;
  }
}

export function mainChatQueryTargetIsTransitional(
  context: SurfaceContext,
  payload: Record<string, unknown>,
) {
  const target = context.target;
  if (
    target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    target.surfaceType !== "agent-chat"
  ) {
    return false;
  }
  const owner = readOwner(payload);
  if (!owner || owner.kind !== "agent") {
    return false;
  }
  const senderUrl = context.sender.getURL();
  if (readAgentWebclientAgentRouteKey(senderUrl) !== owner.agentKey) {
    return false;
  }

  const payloadChatId = readText(payload.chatId);
  const senderCanonical = readAgentWebclientCanonicalChatSource(senderUrl);
  if (senderCanonical) {
    return Boolean(payloadChatId && senderCanonical.chatId === payloadChatId);
  }
  const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
  return Boolean(senderNewChat && senderNewChat.agentKey === owner.agentKey);
}

export function createSurfaceAuthorization(deps: SurfaceAuthorizationPort) {
  // Capture values, not a mutable Registry record, across asynchronous work.
  function captureSurfaceAuthorization(context: SurfaceContext) {
    const { registrationId, surfaceId, ownerWebContentsId, ownerChatId, pageRouteIdentity, pageRoute, currentUrl } = context.target;
    const senderUrl = context.sender.getURL();
    return () => {
      const current = authorizeSurface(context.sender, deps.options.browserSurfaces, deps.options.isTrustedAgentWebclientSession);
      if ("ok" in current || current.target.registrationId !== registrationId ||
        current.target.surfaceId !== surfaceId || current.target.ownerWebContentsId !== ownerWebContentsId ||
        current.target.ownerChatId !== ownerChatId || current.target.pageRouteIdentity !== pageRouteIdentity ||
        current.target.currentUrl !== currentUrl || current.target.pageRoute !== pageRoute ||
        context.sender.getURL() !== senderUrl) {
        throw protocolError("Surface changed while opening the Platform Frame Port");
      }
      return current;
    };
  }

  async function resolveMainChatQueryAuthorization(input: {
    session: LogicalSession;
    context: SurfaceContext;
    payload: Record<string, unknown>;
  }): Promise<{ context: SurfaceContext; newChatSource: { registrationId: string; ownerWebContentsId: number; guestWebContentsId: number; agentKey: string; newChat: string; } | null; }> {
    try {
      validateMainChatQueryAgentIdentity(input.context, input.payload);
      const newChatSource = resolveNewChatQuerySource(input.context.target, input.payload);
      validateMainChatQuerySenderChatIdentity(input.context, input.payload, newChatSource);
      return {
        context: input.context,
        newChatSource,
      };
    }
    catch (error) {
      if (!mainChatQueryTargetIsTransitional(input.context, input.payload))
        throw error;
    }
    const initialTarget = input.context.target;
    const startedAt = Date.now();
    const trace = (state: "started" | "ready" | "failed", reason: string) => {
      const observedTarget = deps.options.browserSurfaces
        .resolveWebviewSurfaceTarget(input.context.sender.id);
      let senderRouteKind = "unavailable";
      try {
        senderRouteKind = describeMainChatRouteIdentity(input.context.sender.getURL());
      }
      catch {
        // A destroyed guest is reported as unavailable without changing failure handling.
      }
      deps.options.realtimeBroker.appendDebugTrace({
        layer: "surface-bridge",
        direction: "surface-to-desktop",
        data: {
          event: "main-chat-query-identity-convergence",
          state,
          reason,
          waitedMs: Date.now() - startedAt,
          generation: initialTarget.registrationId,
          observedGeneration: observedTarget?.registrationId || "",
          sameGeneration: observedTarget?.registrationId === initialTarget.registrationId,
          observedActive: observedTarget?.active === true,
          ownerPresent: Boolean(observedTarget?.ownerChatId?.trim()),
          routeKind: describeMainChatRouteIdentity(initialTarget.pageRouteIdentity),
          observedPageRouteKind: describeMainChatRouteIdentity(observedTarget?.pageRouteIdentity),
          observedGuestRouteKind: describeMainChatRouteIdentity(observedTarget?.currentUrl),
          senderRouteKind,
        },
        surfaceId: initialTarget.surfaceId,
        webContentsId: input.context.sender.id,
        surfaceKind: input.context.kind,
        surfaceRole: initialTarget.surfaceRole,
        surfaceLevel: initialTarget.surfaceLevel,
        interaction: initialTarget.interaction,
        route: initialTarget.pageRoute,
      });
    };
    trace("started", "registered_surface_identity_is_transitional");
    const abortController = new AbortController();
    const abortWait = () => abortController.abort();
    input.context.sender.once("destroyed", abortWait);
    input.context.sender.once("render-process-gone", abortWait);
    let matchedTarget: RegisteredWebviewSurfaceTarget | null = null;
    try {
      matchedTarget = await deps.options.browserSurfaces.waitForWebviewSurfaceTargetMatching(input.context.sender.id, (candidate) => candidate.registrationId === initialTarget.registrationId &&
        candidate.ownerWebContentsId === initialTarget.ownerWebContentsId &&
        candidate.surfaceId === MAIN_CHAT_SURFACE_ID &&
        candidate.active &&
        mainChatQueryTargetIsReady(candidate, input.payload), SURFACE_REGISTRATION_WAIT_MS, abortController.signal);
    }
    finally {
      input.context.sender.removeListener("destroyed", abortWait);
      input.context.sender.removeListener("render-process-gone", abortWait);
    }
    if (!matchedTarget || input.session.closed || input.context.sender.isDestroyed()) {
      trace("failed", matchedTarget ? "logical_session_changed" : "registration_wait_expired");
      throw protocolError("Main Chat identity did not converge before query authorization");
    }
    const nextContext = authorizeSurface(input.context.sender, deps.options.browserSurfaces, deps.options.isTrustedAgentWebclientSession);
    if ("ok" in nextContext ||
      nextContext.target.registrationId !== initialTarget.registrationId ||
      nextContext.target.ownerWebContentsId !== initialTarget.ownerWebContentsId ||
      !nextContext.target.active) {
      trace("failed", "surface_generation_changed");
      throw protocolError("Main Chat surface changed before query authorization completed");
    }
    try {
      validateMainChatQueryAgentIdentity(nextContext, input.payload);
      const newChatSource = resolveNewChatQuerySource(nextContext.target, input.payload);
      validateMainChatQuerySenderChatIdentity(nextContext, input.payload, newChatSource);
      trace("ready", nextContext.target.ownerChatId?.trim()
        ? "canonical_owner_registered"
        : "new_chat_source_registered");
      return { context: nextContext, newChatSource };
    }
    catch (error) {
      trace("failed", "identity_changed_after_registration_match");
      throw error;
    }
  }
  return { resolveMainChatQueryAuthorization, captureSurfaceAuthorization };
}
