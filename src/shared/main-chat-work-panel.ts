import type { MainChatIdentity } from "./canonical-chat-sync";

export type MainChatCommitDescriptor = {
  registrationId: string;
  webContentsId: number;
  revision: number;
  identity: MainChatIdentity;
};

export type PendingMainChatWorkPanelOpenIdentity = {
  chatId: string;
  agentKey: string;
  routeKey: string;
  minimumRevision: number;
  registrationId: string;
  webContentsId: number;
};

export type PendingMainChatWorkPanelResolution = "wait" | "complete" | "cancel";

export function shouldCancelPendingMainChatWorkPanelOpenForRoute(
  pending: Pick<PendingMainChatWorkPanelOpenIdentity, "routeKey">,
  currentRoute: string,
) {
  return pending.routeKey !== currentRoute;
}

export function resolvePendingMainChatWorkPanelOpen(
  pending: PendingMainChatWorkPanelOpenIdentity,
  snapshot: MainChatCommitDescriptor,
  currentRoute: string,
): PendingMainChatWorkPanelResolution {
  if (
    (pending.registrationId && pending.registrationId !== snapshot.registrationId) ||
    (pending.webContentsId && pending.webContentsId !== snapshot.webContentsId)
  ) {
    return "cancel";
  }
  if (pending.routeKey !== currentRoute || snapshot.revision < pending.minimumRevision) {
    return "wait";
  }
  return snapshot.identity.kind === "canonical" &&
    pending.chatId === snapshot.identity.chatId &&
    pending.agentKey === snapshot.identity.agentKey
    ? "complete"
    : "wait";
}
