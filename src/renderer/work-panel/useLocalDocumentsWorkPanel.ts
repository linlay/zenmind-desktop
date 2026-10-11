import { useEffect, useRef, type MutableRefObject } from "react";
import { localDocumentOwnerKey, type LocalDocumentBindResult, type LocalDocumentItem, type LocalDocumentWorkspaceState } from "../../shared/local-document";
import { createAgentWebclientAgentPath, createAgentWebclientRoute } from "../../shared/agent-webclient-routes";
import { isLocalDocumentDraftOwnerKey, reduceWorkPanelCommand, workPanelWorkspaceId, type WorkPanelCommand, type WorkPanelCommandResult, type WorkPanelState } from "../../shared/work-panel";
import type { MainChatCommitSnapshot } from "../service-webview/ServiceWebviewSurface";
import { mainChatIdentitiesEqual, readMainChatIdentity } from "../../shared/canonical-chat-sync";

type Options = {
  state: LocalDocumentWorkspaceState;
  currentRoute: string;
  committed: MainChatCommitSnapshot | null;
  committedRoute: string;
  workPanelStateRef: MutableRefObject<WorkPanelState>;
  commitState: (state: WorkPanelState) => void;
  dispatchCommand: (command: WorkPanelCommand) => WorkPanelCommandResult;
  onError: () => void;
};

type ActivationIntent = { documentId: string; ownerKey: string; agentKey: string };

export function localDocumentCommand(document: LocalDocumentItem): WorkPanelCommand {
  return {
    type: "openItem", ownerChatId: localDocumentOwnerKey(document),
    descriptor: { kind: "native", surfaceKey: "local-document", context: { ...document }, title: document.fileName },
  };
}

/** Main file changes update content without changing the user's tab or panel visibility. */
export function updateLocalDocumentPassively(state: WorkPanelState, document: LocalDocumentItem): WorkPanelState {
  const ownerKey = localDocumentOwnerKey(document);
  const workspace = state.workspaces.find(item => item.ownerChatId === ownerKey);
  const current = workspace?.items.find(item => item.descriptor.kind === "native" &&
    item.descriptor.surfaceKey === "local-document" && item.descriptor.context.documentId === document.documentId);
  if (current?.descriptor.kind === "native" && Object.entries(document).every(([key, value]) => current.descriptor.kind === "native" && current.descriptor.context[key] === value)) return state;
  const result = reduceWorkPanelCommand(state, localDocumentCommand(document));
  if (!result.ok) return state;
  return {
    ...result.nextState,
    visibleOwnerChatIds: state.visibleOwnerChatIds,
    workspaces: result.nextState.workspaces.map(item => item.ownerChatId === ownerKey
      ? { ...item, activeItemId: workspace?.activeItemId ?? null }
      : item),
  };
}

export function localDocumentRoute(document: LocalDocumentItem): string {
  return document.ownerChatId
    ? createAgentWebclientRoute({ agentKey: document.agentKey, chatId: document.ownerChatId })
    : createAgentWebclientAgentPath(document.agentKey, new URLSearchParams({ newChat: document.newChat || "" }));
}

/** Local presentation only; this key must never be used as a backend Chat ID. */
export function localDocumentWorkPanelOwnerForRoute(state: WorkPanelState, route: string): string | null {
  const identity = readMainChatIdentity(route);
  if (!identity || (identity.kind === "canonical" && identity.chatId.startsWith("file-draft:"))) return null;
  const ownerKey = identity.kind === "canonical" ? identity.chatId
    : localDocumentOwnerKey({ ownerChatId: "", agentKey: identity.agentKey, newChat: identity.newChat });
  if (!ownerKey) return null;
  const workspace = state.workspaces.find(item => identity.kind === "canonical"
    ? item.ownerChatId === ownerKey
    : item.workspaceId === workPanelWorkspaceId(ownerKey));
  return workspace?.items.some(item => item.descriptor.kind === "native" &&
    item.descriptor.surfaceKey === "local-document" && item.descriptor.context.agentKey === identity.agentKey)
    ? workspace.ownerChatId : null;
}

/** Files preview in a local draft, then adopt the first normal Query's real Chat. */
export function useLocalDocumentsWorkPanel(options: Options) {
  const live = useRef(options);
  live.current = options;
  const generation = useRef(globalThis.crypto.randomUUID());
  const seenOpenRevision = useRef(0);
  const pendingActivations = useRef(new Map<string, ActivationIntent>());
  const knownDocumentIds = useRef(new Set<string>());
  const awaitingMainRouteFrom = useRef<string | null>(null);
  const boundDocuments = useRef(new Map<string, string>());
  const displayedDocumentIds = useRef(new Set<string>());
  // A removed UI item stays closed until Main removes it or a fresh OS open
  // explicitly selects it. Read the live reducer state even before effect cleanup.
  const wasClosed = (documentId: string) => displayedDocumentIds.current.has(documentId) &&
    !live.current.workPanelStateRef.current.workspaces.some(workspace => workspace.items.some(item =>
      item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document" &&
      item.descriptor.context.documentId === documentId));

  useEffect(() => {
    const current = live.current;
    const documents = new Map(current.state.documents.map(document => [document.documentId, document]));
    let nextState = current.workPanelStateRef.current;
    for (const workspace of nextState.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document") {
          displayedDocumentIds.current.add(String(item.descriptor.context.documentId));
        }
      }
    }
    // Promotion is atomic and precedes owner-mismatch cleanup. Preserve the
    // original workspace/item parents so their already-mounted guests survive.
    for (const workspace of nextState.workspaces) {
      if (!isLocalDocumentDraftOwnerKey(workspace.ownerChatId)) continue;
      const promoted = workspace.items.flatMap(item => item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document"
        ? [documents.get(String(item.descriptor.context.documentId))] : []);
      const ownerChatId = promoted[0]?.ownerChatId;
      if (!ownerChatId || promoted.some(document => !document || document.ownerChatId !== ownerChatId || document.newChat !== undefined)) continue;
      const adopted = reduceWorkPanelCommand(nextState, { type: "adoptLocalDocumentWorkspace", ownerChatId,
        draftOwnerKey: workspace.ownerChatId, documents: current.state.documents.filter(document => document.ownerChatId === ownerChatId) });
      if (!adopted.ok) continue;
      nextState = adopted.nextState;
      const intent = pendingActivations.current.get(workspace.ownerChatId);
      pendingActivations.current.delete(workspace.ownerChatId);
      if (intent) pendingActivations.current.set(ownerChatId, { ...intent, ownerKey: ownerChatId });
    }
    // The first Query can promote before an initial draft bind has mounted any
    // file. Keep that pending activation without creating a second workspace.
    for (const [ownerKey, intent] of pendingActivations.current) {
      if (!isLocalDocumentDraftOwnerKey(ownerKey) || nextState.workspaces.some(workspace => workspace.ownerChatId === ownerKey)) continue;
      const document = documents.get(intent.documentId);
      if (!document?.ownerChatId || document.newChat !== undefined || document.agentKey !== intent.agentKey) continue;
      pendingActivations.current.delete(ownerKey);
      pendingActivations.current.set(document.ownerChatId, { ...intent, ownerKey: document.ownerChatId });
    }
    for (const workspace of nextState.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind !== "native" || item.descriptor.surfaceKey !== "local-document") continue;
        const document = documents.get(String(item.descriptor.context.documentId));
        if (!document) {
          nextState = reduceWorkPanelCommand(nextState, { type: "closeItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId, force: true }).nextState;
        } else if (localDocumentOwnerKey(document) === workspace.ownerChatId &&
            item.descriptor.context.url === document.url && item.descriptor.context.partition === document.partition) {
          nextState = updateLocalDocumentPassively(nextState, document);
        }
      }
    }
    current.commitState(nextState);
    for (const id of boundDocuments.current.keys()) if (!documents.has(id)) boundDocuments.current.delete(id);
    for (const id of displayedDocumentIds.current) if (!documents.has(id)) displayedDocumentIds.current.delete(id);
    for (const [ownerKey, intent] of pendingActivations.current) {
      if (!documents.has(intent.documentId)) pendingActivations.current.delete(ownerKey);
    }
    const newlyOpened = current.state.documents.filter(document => !knownDocumentIds.current.has(document.documentId));
    knownDocumentIds.current = new Set(documents.keys());
    if (current.state.openRevision <= seenOpenRevision.current) return;
    const hasPreviousOpen = seenOpenRevision.current > 0;
    seenOpenRevision.current = current.state.openRevision;
    const rememberActivation = (document: LocalDocumentItem) => {
      const ownerKey = localDocumentOwnerKey(document);
      if (!ownerKey) return;
      pendingActivations.current.set(ownerKey, { documentId: document.documentId, ownerKey, agentKey: document.agentKey });
    };
    newlyOpened.forEach(rememberActivation);
    const selected = documents.get(current.state.activeDocumentId || "");
    if (!selected || !localDocumentOwnerKey(selected)) return;
    if (wasClosed(selected.documentId)) {
      displayedDocumentIds.current.delete(selected.documentId);
      boundDocuments.current.delete(selected.documentId);
    }
    rememberActivation(selected);
    // Main's explicit showDocumentChat owns navigation, including cold launch.
    // A restored global snapshot must never take the user out of their current Chat.
    const route = localDocumentRoute(selected);
    awaitingMainRouteFrom.current = hasPreviousOpen && current.currentRoute !== route ? current.currentRoute : null;
  }, [options.state.revision, options.state.openRevision]);

  useEffect(() => {
    const start = live.current;
    if (awaitingMainRouteFrom.current) {
      if (start.currentRoute === awaitingMainRouteFrom.current) return;
      awaitingMainRouteFrom.current = null;
    }
    const snapshot = start.committed;
    if (!snapshot || start.committedRoute !== start.currentRoute) return;
    const identity = snapshot.identity;
    if (!mainChatIdentitiesEqual(readMainChatIdentity(start.currentRoute), identity)) return;
    const ownerKey = identity.kind === "canonical" ? identity.chatId
      : localDocumentOwnerKey({ ownerChatId: "", agentKey: identity.agentKey, newChat: identity.newChat });
    if (!ownerKey) return;
    const route = start.currentRoute;
    let disposed = false;
    const isCurrent = () => {
      const current = live.current;
      return !disposed && current.currentRoute === route && current.committedRoute === route &&
        current.committed?.registrationId === snapshot.registrationId && current.committed.webContentsId === snapshot.webContentsId &&
        current.committed.revision === snapshot.revision && mainChatIdentitiesEqual(current.committed.identity, identity);
    };
    const intent = pendingActivations.current.get(ownerKey);
    const candidates = start.state.documents.filter(document => localDocumentOwnerKey(document) === ownerKey && document.agentKey === identity.agentKey)
      .sort((left, right) => Number(left.documentId === intent?.documentId) - Number(right.documentId === intent?.documentId));
    void (async () => {
      for (const source of candidates) {
        if (!isCurrent()) return;
        let document = live.current.state.documents.find(item => item.documentId === source.documentId);
        if (!document || wasClosed(document.documentId) || localDocumentOwnerKey(document) !== ownerKey || document.agentKey !== identity.agentKey) continue;
        const bindingKey = `${ownerKey}\u0000${document.agentKey}\u0000${document.url}\u0000${document.partition}`;
        if (boundDocuments.current.get(document.documentId) !== bindingKey) {
          let result: LocalDocumentBindResult;
          try {
            result = await window.electronAPI.localDocuments.bind({ documentId: document.documentId, ownerChatId: document.ownerChatId,
              ...(document.newChat ? { newChat: document.newChat } : {}), rendererGeneration: generation.current });
          } catch {
            if (!isCurrent()) return;
            if (wasClosed(source.documentId)) continue;
            if (intent?.documentId === source.documentId) live.current.onError();
            continue;
          }
          if (!isCurrent()) return;
          if (wasClosed(source.documentId)) continue;
          if (!result.ok || !result.document || result.document.documentId !== source.documentId ||
              localDocumentOwnerKey(result.document) !== ownerKey || result.document.agentKey !== identity.agentKey) {
            if (intent?.documentId === source.documentId) live.current.onError();
            continue;
          }
          document = result.document;
          const latest = live.current.state.documents.find(item => item.documentId === source.documentId);
          if (!latest || localDocumentOwnerKey(latest) !== ownerKey || latest.agentKey !== identity.agentKey ||
              latest.url !== document.url || latest.partition !== document.partition) continue;
          if (latest.version > document.version) document = latest;
          boundDocuments.current.set(document.documentId, `${ownerKey}\u0000${document.agentKey}\u0000${document.url}\u0000${document.partition}`);
        }
        const explicit = Boolean(intent && pendingActivations.current.get(ownerKey) === intent && intent.ownerKey === ownerKey &&
          intent.agentKey === identity.agentKey && intent.documentId === document.documentId);
        if (!explicit) {
          const current = live.current;
          current.commitState(updateLocalDocumentPassively(current.workPanelStateRef.current, document));
          displayedDocumentIds.current.add(document.documentId);
          continue;
        }
        const opened = live.current.dispatchCommand(localDocumentCommand(document));
        if (!opened.ok) { live.current.onError(); pendingActivations.current.delete(ownerKey); continue; }
        displayedDocumentIds.current.add(document.documentId);
        if (!disposed && pendingActivations.current.get(ownerKey) === intent) pendingActivations.current.delete(ownerKey);
      }
    })().catch(() => { if (isCurrent()) live.current.onError(); });
    return () => { disposed = true; };
  }, [options.state.revision, options.state.openRevision, options.currentRoute, options.committedRoute,
    options.committed?.registrationId, options.committed?.webContentsId, options.committed?.revision]);
}
