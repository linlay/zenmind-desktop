import path from "node:path";
import type {
  EnterpriseChatConversation,
  EnterpriseChatDesktopAction,
  EnterpriseChatDesktopActionStatus,
  EnterpriseChatExecuteActionInput,
  EnterpriseChatExecuteActionResult,
  EnterpriseChatMessage,
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";
import {
  getEnterpriseChatRemoteAction
} from "../../../shared/enterprise-chat-actions";
import {
  EnterpriseChatActionLedger,
  enterpriseChatActionScope,
  type EnterpriseChatActionLedgerEntry
} from "./action-ledger";
import { errorMessage, readText } from "./protocol-values";

export interface DesktopActionControllerDependencies {
  readonly snapshot: EnterpriseChatSnapshot;
  readonly getDeviceInfo: () => { deviceId: string; deviceName: string; };
  readonly serverUrl: string;
  readonly app: Electron.App;
  desktopActionLedgerPath: string;
  desktopActionLedger: EnterpriseChatActionLedger | null;
  getDesktopActionLedger(): EnterpriseChatActionLedger | null;
  currentDesktopActionScope(): string;
  handledDesktopActionResult(entry?: EnterpriseChatActionLedgerEntry): EnterpriseChatExecuteActionResult;
  desktopActionState(message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): "pending" | "executing" | "handled" | "not_executable" | undefined;
  notExecutableDesktopActionResult(message?: string): EnterpriseChatExecuteActionResult;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  createRemoteSupportAttachment(request: EnterpriseChatDesktopAction): Promise<string[]>;
  readonly executeDesktopAction?: ((request: EnterpriseChatDesktopAction & { messageId: string; conversationId: string; senderId: string; }) => Promise<{ response?: DesktopActionCallResponse; message: string; }>) | undefined;
  deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry): Promise<boolean>;
}

export function currentDesktopActionScope(dependencies: DesktopActionControllerDependencies) {
  const userId = dependencies.snapshot.currentUser?.id ?? "";
  const deviceId = dependencies.getDeviceInfo().deviceId;
  return userId && deviceId
    ? enterpriseChatActionScope(dependencies.serverUrl, userId, deviceId)
    : "";
}

export function getDesktopActionLedger(dependencies: DesktopActionControllerDependencies) {
  let ledgerPath = "";
  try {
    ledgerPath = path.join(dependencies.app.getPath("userData"), "enterprise-chat-action-ledger.json");
  }
  catch {
    return null;
  }
  if (ledgerPath === dependencies.desktopActionLedgerPath) {
    return dependencies.desktopActionLedger;
  }
  dependencies.desktopActionLedgerPath = ledgerPath;
  try {
    dependencies.desktopActionLedger = new EnterpriseChatActionLedger(ledgerPath);
  }
  catch {
    dependencies.desktopActionLedger = null;
  }
  return dependencies.desktopActionLedger;
}

export function desktopActionState(dependencies: DesktopActionControllerDependencies, message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation) {
  const request = message.desktopAction;
  if (!request) {
    return undefined;
  }
  const ledger = dependencies.getDesktopActionLedger();
  const scope = dependencies.currentDesktopActionScope();
  const entry = scope ? ledger?.find(scope, request.requestId) : undefined;
  if (entry?.phase === "executing") {
    return "executing" as const;
  }
  if (entry?.phase === "terminal") {
    return "handled" as const;
  }
  if (!scope ||
    !ledger ||
    !conversation ||
    conversation.type !== "direct" ||
    message.senderId === dependencies.snapshot.currentUser?.id ||
    message.revokedAt ||
    !getEnterpriseChatRemoteAction(request.action) ||
    request.targetDeviceId !== dependencies.getDeviceInfo().deviceId ||
    request.expiresAt <= Date.now()) {
    return "not_executable" as const;
  }
  return "pending" as const;
}

export async function executeMessageDesktopAction(dependencies: DesktopActionControllerDependencies, input: EnterpriseChatExecuteActionInput): Promise<EnterpriseChatExecuteActionResult> {
  const messageId = readText(input?.messageId);
  if (input?.decision !== "confirm" && input?.decision !== "decline") {
    throw new Error("A local Desktop action decision is required.");
  }
  const message = dependencies.snapshot.activeMessages.find((item) => item.id === messageId);
  const conversation = message
    ? dependencies.snapshot.conversations.find((item) => item.id === message.conversationId)
    : undefined;
  const request = message?.desktopAction;
  const scope = dependencies.currentDesktopActionScope();
  const ledger = dependencies.getDesktopActionLedger();
  const existing = request && scope
    ? ledger?.find(scope, request.requestId)
    : undefined;
  if (existing) {
    return dependencies.handledDesktopActionResult(existing);
  }
  if (!message ||
    !request ||
    !conversation ||
    dependencies.desktopActionState(message, conversation) !== "pending" ||
    !scope ||
    !ledger) {
    return dependencies.notExecutableDesktopActionResult();
  }
  let claimed: EnterpriseChatActionLedgerEntry;
  try {
    const claim = ledger.claim({
      scope,
      messageId: message.id,
      requestId: request.requestId,
      conversationId: message.conversationId,
      targetDeviceId: request.targetDeviceId,
      action: request.action
    });
    if (!claim.created) {
      return dependencies.handledDesktopActionResult(claim.entry);
    }
    claimed = claim.entry;
  }
  catch (error) {
    return dependencies.notExecutableDesktopActionResult(errorMessage(error));
  }
  dependencies.updateSnapshot({});
  let status: EnterpriseChatDesktopActionStatus;
  let resultMessage: string;
  let fileIds: string[] = [];
  let response: DesktopActionCallResponse | undefined;
  if (input.decision === "decline") {
    status = "declined";
    resultMessage = "User declined the Desktop action request.";
  }
  else {
    try {
      if (request.action.startsWith("desktop.support.")) {
        fileIds = await dependencies.createRemoteSupportAttachment(request);
        status = "succeeded";
        resultMessage = fileIds.length > 0
          ? "Requested support information was sent."
          : "Support request completed.";
      }
      else if (!dependencies.executeDesktopAction) {
        status = "unsupported";
        resultMessage = "Desktop action execution is unavailable.";
      }
      else {
        const result = await dependencies.executeDesktopAction({
          ...request,
          args: { ...request.args },
          messageId: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId
        });
        response = result.response;
        status = result.response?.ok === true ? "succeeded" : "failed";
        resultMessage = result.message;
      }
    }
    catch (error) {
      status = "failed";
      resultMessage = errorMessage(error);
    }
  }
  const terminal = ledger.complete(scope, claimed.requestId, {
    status,
    resultMessage,
    fileIds
  });
  dependencies.updateSnapshot({});
  const delivered = await dependencies.deliverDesktopActionReceipt(terminal);
  return {
    confirmed: input.decision === "confirm",
    status,
    disposition: "completed",
    deliveryState: delivered ? "delivered" : "pending",
    ...(response ? { response } : {}),
    message: resultMessage
  };
}

export function handledDesktopActionResult(dependencies: DesktopActionControllerDependencies, entry?: EnterpriseChatActionLedgerEntry): EnterpriseChatExecuteActionResult {
  return {
    confirmed: entry?.status !== "declined",
    status: entry?.status ?? "failed",
    disposition: "already_handled",
    deliveryState: entry?.phase === "terminal"
      ? entry.deliveryState
      : "not_applicable",
    message: entry?.resultMessage || "This Desktop action request was already handled."
  };
}

export function notExecutableDesktopActionResult(dependencies: DesktopActionControllerDependencies, message = "This Desktop action request is not executable."): EnterpriseChatExecuteActionResult {
  return {
    confirmed: false,
    status: "unsupported",
    disposition: "not_executable",
    deliveryState: "not_applicable",
    message
  };
}

export function reconcileDesktopActionMessages(dependencies: DesktopActionControllerDependencies, messages: EnterpriseChatMessage[], conversation?: EnterpriseChatConversation) {
  const scope = dependencies.currentDesktopActionScope();
  const ledger = dependencies.getDesktopActionLedger();
  const currentUserId = dependencies.snapshot.currentUser?.id ?? "";
  const currentDeviceId = dependencies.getDeviceInfo().deviceId;
  if (!scope || !ledger || !currentUserId || !currentDeviceId) {
    return;
  }
  const requestsById = new Map(messages
    .filter((message) => Boolean(message.desktopAction))
    .map((message) => [message.id, message] as const));
  for (const resultMessage of messages) {
    const result = resultMessage.desktopActionResult;
    const requestMessage = requestsById.get(resultMessage.replyToId);
    const request = requestMessage?.desktopAction;
    if (!result ||
      !requestMessage ||
      !request ||
      resultMessage.senderId !== currentUserId ||
      result.targetDeviceId !== currentDeviceId ||
      request.requestId !== result.requestId ||
      request.targetDeviceId !== result.targetDeviceId ||
      request.action !== result.action ||
      requestMessage.conversationId !== resultMessage.conversationId) {
      continue;
    }
    ledger.recordDelivered({
      scope,
      messageId: requestMessage.id,
      requestId: request.requestId,
      conversationId: requestMessage.conversationId,
      targetDeviceId: request.targetDeviceId,
      action: request.action,
      status: result.status,
      resultMessage: result.message,
      fileIds: resultMessage.attachments.map((attachment) => attachment.id),
      completedAt: result.completedAt
    });
  }
  if (!conversation || conversation.type !== "direct") {
    return;
  }
  for (const requestMessage of requestsById.values()) {
    const request = requestMessage.desktopAction;
    if (!request ||
      request.expiresAt > Date.now() ||
      requestMessage.senderId === currentUserId ||
      requestMessage.revokedAt ||
      request.targetDeviceId !== currentDeviceId ||
      !getEnterpriseChatRemoteAction(request.action) ||
      ledger.find(scope, request.requestId)) {
      continue;
    }
    try {
      ledger.claim({
        scope,
        messageId: requestMessage.id,
        requestId: request.requestId,
        conversationId: requestMessage.conversationId,
        targetDeviceId: request.targetDeviceId,
        action: request.action
      });
      ledger.complete(scope, request.requestId, {
        status: "expired",
        resultMessage: "Desktop action request expired."
      });
    }
    catch {
      // Expired requests remain non-executable even if their acknowledgement cannot be persisted.
    }
  }
}
