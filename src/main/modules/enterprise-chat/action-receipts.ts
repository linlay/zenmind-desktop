import type {
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import {
  EnterpriseChatActionLedger,
  type EnterpriseChatActionLedgerEntry
} from "./action-ledger";
import { WebSocketLike } from "./connection-transport";

export interface ActionReceiptsDependencies {
  readonly socket: WebSocketLike | null;
  readonly socketSynced: boolean;
  sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }): Promise<EnterpriseChatSnapshot>;
  getDesktopActionLedger(): EnterpriseChatActionLedger | null;
  actionReceiptFlushPromise: Promise<void> | null;
  currentDesktopActionScope(): string;
  deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry): Promise<boolean>;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
}

export async function deliverDesktopActionReceipt(dependencies: ActionReceiptsDependencies, entry: EnterpriseChatActionLedgerEntry) {
  if (entry.phase !== "terminal" ||
    !entry.status ||
    entry.deliveryState === "delivered" ||
    !dependencies.socket ||
    !dependencies.socketSynced ||
    dependencies.socket.readyState !== 1) {
    return entry.deliveryState === "delivered";
  }
  try {
    await dependencies.sendMessagePayload({
      conversationId: entry.conversationId,
      clientMessageId: `desktop-action-result:${entry.requestId}`,
      body: entry.resultMessage.slice(0, 1000),
      fileIds: entry.fileIds,
      replyToId: entry.messageId,
      kind: "desktop_action_result",
      desktopAction: {
        requestId: entry.requestId,
        targetDeviceId: entry.targetDeviceId,
        action: entry.action,
        status: entry.status,
        message: entry.resultMessage.slice(0, 1000),
        completedAt: entry.completedAt
      }
    });
    dependencies.getDesktopActionLedger()?.markDelivered(entry.scope, entry.requestId);
    return true;
  }
  catch {
    return false;
  }
}

export function flushDesktopActionReceipts(dependencies: ActionReceiptsDependencies) {
  if (dependencies.actionReceiptFlushPromise) {
    return dependencies.actionReceiptFlushPromise;
  }
  const scope = dependencies.currentDesktopActionScope();
  const ledger = dependencies.getDesktopActionLedger();
  if (!scope || !ledger) {
    return Promise.resolve();
  }
  dependencies.actionReceiptFlushPromise = (async () => {
    for (const entry of ledger.pendingReceipts(scope)) {
      if (!await dependencies.deliverDesktopActionReceipt(entry)) {
        break;
      }
    }
  })().finally(() => {
    dependencies.actionReceiptFlushPromise = null;
    dependencies.updateSnapshot({});
  });
  return dependencies.actionReceiptFlushPromise;
}
