import { createAgentRealtimeRuntimeDiagnostics } from "./realtime-diagnostics";
import { handleAgentWebclientWorkPanelActionRequest } from "../modules/desktop-actions";
import { registerAgentWebclientBridgeIpcHandlers } from "../modules/agent-platform";
import { registerCanonicalChatSyncIpc } from "../modules/agent-platform";
import { normalizeChatWorkPanelOpenLocalResourceRequest, resolveWorkPanelDocumentFromWorkspace } from "../modules/work-panel";
import { workPanelDocumentHtmlRegistry } from "../modules/work-panel";
import { workPanelResourceImageRegistry } from "../modules/work-panel";
import { requireEpochMillis } from "../../shared/time-contract";
import { MainIpcRegistrationOptions } from "./ipc-registration-contracts";

export function registerPlatformFrameIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
  } = options;
  const services = options.servicesFacade;
  const { assistantBridge, desktopActionOptions } = assistantBridgeRuntime;
  const canonicalChatSync = registerCanonicalChatSyncIpc(ipcMain, {
    resolveRenderer: (ownerWebContentsId) => {
      const mainWindow = options.getMainWindow();
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents.isDestroyed() ||
        mainWindow.webContents.id !== ownerWebContentsId
      ) {
        return null;
      }
      return mainWindow.webContents;
    },
  });

  const agentWebclientBridgeRuntime = registerAgentWebclientBridgeIpcHandlers(ipcMain, {
    app,
    getMainWebContents: () => {
      const mainWindow = options.getMainWindow();
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    },
    browserSurfaces: options.browserSurfaces,
    isTrustedAgentWebclientSession: options.isTrustedAgentWebclientSession,
    normalizeWorkPanelOpenLocalResourceRequest: normalizeChatWorkPanelOpenLocalResourceRequest,
    realtimeBroker: assistantBridgeRuntime.realtimeBroker,
    getServiceState: (targetApp, serviceId) => services.getServiceState(targetApp, serviceId, { mode: "bridge" }),
    issueAccessToken: options.issueAgentAccessToken,
    syncCanonicalChat: (ownerWebContentsId, input) =>
      canonicalChatSync.request(ownerWebContentsId, input),
    dispatchWorkPanel: async ({ action, ownerChatId, args }) => {
      const response = await handleAgentWebclientWorkPanelActionRequest(desktopActionOptions, {
        requestId: `workpanel-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        action,
        ownerChatId,
        args,
      });
      if (response.ok) {
        return response.result as any;
      }
      return {
        ok: false,
        error: {
          code: (response.error?.code || "target_unavailable") as any,
          message: response.error?.message || "WorkPanel renderer is unavailable"
        }
      };
    },
    openResource: async ({ ownerChatId, resource }) => {
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { ok: false, error: { code: "target_unavailable", message: "WorkPanel renderer is unavailable" } };
      }
      const prepared = await workPanelResourceImageRegistry.prepareClaim({
        ownerChatId,
        rendererWebContentsId: mainWindow.webContents.id,
        ...resource,
      });
      if (!prepared.ok) {
        return { ok: false, error: { code: prepared.code, message: prepared.message } };
      }
      try {
        const response = await desktopActionOptions.callRendererAction({
          requestId: `workpanel-native-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action: "desktop.workpanel.openResourceImage",
          args: {
            claimId: prepared.claimId,
            ...(resource.title ? { title: resource.title } : {}),
          },
          source: { chatId: ownerChatId, agentKey: resource.agentKey },
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: (response.error?.code || "target_unavailable") as any,
              message: response.error?.message || "WorkPanel renderer is unavailable",
            },
          };
        }
        const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
        const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
        const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
        return workspaceId && itemId
          ? { ok: true, workspaceId, itemId, renderer: "native-image" as const }
          : { ok: false, error: { code: "protocol_error", message: "Native image host returned an invalid result" } };
      } finally {
        workPanelResourceImageRegistry.discardPreparedClaim(prepared.claimId);
      }
    },
    openDocument: async ({ ownerChatId, document }) => {
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { ok: false, error: { code: "target_unavailable", message: "WorkPanel renderer is unavailable" } };
      }
      const source = document.source;
      let workspaceFilePath: string | undefined;
      let workspaceRelativePath: string | undefined;
      if (source.kind === "workspace-file") {
        try {
          const navigation = await assistantBridge.listNavigationAgents();
          const agent = navigation.ok
            ? navigation.items.find((candidate) => candidate.agentKey === source.agentKey)
            : null;
          const workspaceDir = agent?.workspaceDir?.trim() || "";
          const resolved = workspaceDir && workspaceDir !== "@chat" && agent?.workspaceDirExists !== false
            ? resolveWorkPanelDocumentFromWorkspace(workspaceDir, source.path, options.platform)
            : null;
          if (!resolved?.ok) {
            return { ok: false, error: { code: "target_unavailable", message: resolved?.message || "Agent workspace is unavailable" } };
          }
          workspaceFilePath = resolved.filePath;
          workspaceRelativePath = resolved.relativePath;
        } catch {
          return { ok: false, error: { code: "target_unavailable", message: "Agent workspace is unavailable" } };
        }
      }
      const imagePrepared = await workPanelResourceImageRegistry.prepareClaim({
          ownerChatId,
          rendererWebContentsId: mainWindow.webContents.id,
          profile: source.kind,
          agentKey: source.agentKey,
          chatId: source.kind === "workspace-file" ? ownerChatId : source.chatId,
          resourceId: source.kind === "workspace-file" ? workspaceRelativePath! : source.resourceId,
          relativePath: source.kind === "workspace-file" ? workspaceRelativePath! : source.relativePath,
          title: document.title,
          ...(workspaceFilePath ? { workspaceFilePath } : {}),
        });
      if (imagePrepared.ok) {
        try {
          const response = await desktopActionOptions.callRendererAction({
            requestId: `workpanel-document-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            action: "desktop.workpanel.openResourceImage",
            args: {
              claimId: imagePrepared.claimId,
              surfaceKey: "document-image",
              ...(document.title ? { title: document.title } : {}),
            },
            source: { chatId: ownerChatId, agentKey: source.agentKey },
          });
          if (!response.ok) return { ok: false, error: { code: (response.error?.code || "target_unavailable") as any, message: response.error?.message || "WorkPanel renderer is unavailable" } };
          const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
          const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
          const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
          return workspaceId && itemId
            ? { ok: true, workspaceId, itemId, renderer: "native-image" as const }
            : { ok: false, error: { code: "protocol_error", message: "Native image host returned an invalid result" } };
        } finally {
          workPanelResourceImageRegistry.discardPreparedClaim(imagePrepared.claimId);
        }
      }
      if (imagePrepared.code !== "unsupported_native_type") {
        return { ok: false, error: { code: imagePrepared.code, message: imagePrepared.message } };
      }
      const prepared = await workPanelDocumentHtmlRegistry.prepareClaim({
        ownerChatId,
        rendererWebContentsId: mainWindow.webContents.id,
        source: source.kind === "workspace-file"
          ? { ...source, path: workspaceRelativePath! }
          : source,
        title: document.title,
        ...(workspaceFilePath ? { workspaceFilePath } : {}),
      });
      if (!prepared.ok) return { ok: false, error: { code: prepared.code, message: prepared.message } };
      try {
        const response = await desktopActionOptions.callRendererAction({
          requestId: `workpanel-document-html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action: "desktop.workpanel.openDocumentHtml",
          args: { claimId: prepared.claimId, ...(document.title ? { title: document.title } : {}) },
          source: { chatId: ownerChatId, agentKey: source.agentKey },
        });
        if (!response.ok) return { ok: false, error: { code: (response.error?.code || "target_unavailable") as any, message: response.error?.message || "WorkPanel renderer is unavailable" } };
        const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
        const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
        const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
        return workspaceId && itemId
          ? { ok: true, workspaceId, itemId, renderer: "native-html" as const }
          : { ok: false, error: { code: "protocol_error", message: "Native HTML host returned an invalid result" } };
      } finally {
        workPanelDocumentHtmlRegistry.discardPreparedClaim(prepared.claimId);
      }
    },
  });

  const readAgentRealtimeDebugSnapshot = (afterSequence?: unknown) => {
    const brokerDiagnostics = assistantBridgeRuntime.realtimeBroker.getDiagnostics();
    const bridgeDiagnostics = agentWebclientBridgeRuntime.getDiagnostics();
    const trace = assistantBridgeRuntime.realtimeBroker.getDebugTraceEntries();
    const normalizedAfterSequence = typeof afterSequence === "number" &&
      Number.isSafeInteger(afterSequence) && afterSequence >= 0
      ? afterSequence
      : null;
    const replayEventCount = brokerDiagnostics.replay.reduce((total: number, item: { eventCount: number }) =>
      total + item.eventCount,
    0);
    const replayBytes = brokerDiagnostics.replay.reduce((total: number, item: { bytes: number }) =>
      total + item.bytes,
    0);
    const mapConnection = (
      source: "desktop-main" | "desktop-btw" | "desktop-explain",
      connection: typeof brokerDiagnostics.connections.primary,
      lane: "primary" | "btw" | "selection-explain",
    ) => ({
      source,
      phase: connection.phase,
      generation: connection.generation,
      physicalConnectionCount: connection.physicalConnectionCount,
      reconnectCount: connection.reconnectCount,
      endpoint: connection.key?.endpoint || "",
      ...(connection.physicalSessionId ? { physicalSessionId: connection.physicalSessionId } : {}),
      ...(connection.lastInboundAt
        ? { lastInboundAt: requireEpochMillis(connection.lastInboundAt, `agentRealtimeDebugSnapshot.connections.${lane}.lastInboundAt`) }
        : {}),
      ...(connection.lastHeartbeatAt
        ? { lastHeartbeatAt: requireEpochMillis(connection.lastHeartbeatAt, `agentRealtimeDebugSnapshot.connections.${lane}.lastHeartbeatAt`) }
        : {}),
      ...(connection.closeReason ? { closeReason: connection.closeReason } : {}),
      ...(connection.lastError ? { lastError: connection.lastError } : {}),
    });
    return {
      capturedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugSnapshot.capturedAt"),
      runtime: createAgentRealtimeRuntimeDiagnostics(app, options.browserSurfaces),
      connections: {
        primary: mapConnection("desktop-main", brokerDiagnostics.connections.primary, "primary"),
        btw: mapConnection("desktop-btw", brokerDiagnostics.connections.btw, "btw"),
        "selection-explain": mapConnection("desktop-explain", brokerDiagnostics.connections["selection-explain"], "selection-explain"),
      },
      broker: {
        pendingRequestCount: brokerDiagnostics.pendingRequestCount,
        pendingQueryCount: brokerDiagnostics.pendingQueryCount,
        activeStreamCount: brokerDiagnostics.activeStreamCount,
        runCount: brokerDiagnostics.runCount,
        localRunSubscriberCount: brokerDiagnostics.localRunSubscriberCount,
        pushSubscriberCount: brokerDiagnostics.pushSubscriberCount,
        connectionSubscriberCount: brokerDiagnostics.connectionSubscriberCount,
        overviewLease: brokerDiagnostics.overviewLease,
        pendingCloneCount: brokerDiagnostics.pendingClones.length,
        pendingClones: brokerDiagnostics.pendingClones.map((pending: {
          parentGeneration: string; runId: string; chatId: string; waitReason: string;
        }) => ({
          parentGeneration: pending.parentGeneration,
          runId: pending.runId,
          chatId: pending.chatId,
          waitReason: pending.waitReason,
        })),
        ...(brokerDiagnostics.lastCloneCancellationReason
          ? { lastCloneCancellationReason: brokerDiagnostics.lastCloneCancellationReason }
          : {}),
        replayEventCount,
        replayBytes,
        unknownFrameCount: brokerDiagnostics.unknownFrameCount,
        unknownRequestIdCount: brokerDiagnostics.unknownRequestIdCount,
        seqGapCount: brokerDiagnostics.seqGapCount,
        staleFrameCount: brokerDiagnostics.staleFrameCount,
        seqRegressionCount: brokerDiagnostics.seqRegressionCount,
        duplicateTerminalCount: brokerDiagnostics.duplicateTerminalCount,
        replayEvictionCount: brokerDiagnostics.replayEvictionCount,
        observerReleaseCount: brokerDiagnostics.observerReleaseCount,
        seqExpiredCount: brokerDiagnostics.seqExpiredCount,
        upstreamAttachCount: brokerDiagnostics.upstreamAttachCount,
        upstreamDetachCount: brokerDiagnostics.upstreamDetachCount,
        cloneCreatedCount: brokerDiagnostics.cloneCreatedCount,
        cloneRevokedCount: brokerDiagnostics.cloneRevokedCount,
        laneRotationCount: brokerDiagnostics.laneRotationCount,
      },
      bridge: {
        registeredSenderCount: bridgeDiagnostics.registeredSenderCount,
        logicalSessionCount: bridgeDiagnostics.logicalSessionCount,
        pendingRequestCount: bridgeDiagnostics.pendingRequestCount,
        activeStreamCount: bridgeDiagnostics.activeStreamCount,
        rootObserver: bridgeDiagnostics.activeRootObserver
          ? {
              ...bridgeDiagnostics.activeRootObserver,
              runIds: [...bridgeDiagnostics.activeRootObserver.runIds],
            }
          : null,
      },
      surfaces: bridgeDiagnostics.surfaces,
      logicalSessions: bridgeDiagnostics.logicalSessions.map((session) => ({
        ...session,
        openedAt: requireEpochMillis(session.openedAt, "agentRealtimeDebugSnapshot.logicalSession.openedAt"),
        ...("closedAt" in session && typeof session.closedAt === "number"
          ? { closedAt: requireEpochMillis(session.closedAt, "agentRealtimeDebugSnapshot.logicalSession.closedAt") }
          : {}),
      })),
      runRecovery: brokerDiagnostics.replay.map((run: {
        lane: "primary" | "btw" | "selection-explain"; runId: string; chatId: string; lastSeq: number;
        lastEventType?: string; lastEventSeq?: number; lastPlanTaskEventType?: string;
        lastPlanTaskEventSeq?: number; state: string; terminalReason?: string;
        terminalSource?: string; rootObserverCount: number; cloneCount: number;
        upstreamState: string; restoreCount: number; lastRestoreResult: string;
      }) => ({
        lane: run.lane,
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: run.lastSeq,
        ...(run.lastEventType ? { lastEventType: run.lastEventType } : {}),
        ...(run.lastEventSeq === undefined ? {} : { lastEventSeq: run.lastEventSeq }),
        ...(run.lastPlanTaskEventType
          ? { lastPlanTaskEventType: run.lastPlanTaskEventType }
          : {}),
        ...(run.lastPlanTaskEventSeq === undefined
          ? {}
          : { lastPlanTaskEventSeq: run.lastPlanTaskEventSeq }),
        state: run.state,
        ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
        ...(run.terminalSource ? { terminalSource: run.terminalSource } : {}),
        rootObserverCount: run.rootObserverCount,
        cloneCount: run.cloneCount,
        upstreamState: run.upstreamState,
        restoreCount: run.restoreCount,
        lastRestoreResult: run.lastRestoreResult,
      })),
      trace: normalizedAfterSequence === null
        ? trace
        : trace.filter((entry: { sequence: number }) => entry.sequence > normalizedAfterSequence),
    };
  };

  ipcMain.handle("diagnostics.getAgentRealtimeDebugSnapshot", async (_event: any, input?: unknown) =>
    readAgentRealtimeDebugSnapshot(
      input && typeof input === "object" ? (input as { afterSequence?: unknown }).afterSequence : undefined,
    ),
  );

  ipcMain.handle("diagnostics.openAgentRealtimeInspector", async () =>
    options.openAgentRealtimeInspectorWindow(),
  );

  ipcMain.handle("diagnostics.openAgentRealtimeTargetDevTools", async (_event: any, input?: unknown) => {
    const webContentsId = input && typeof input === "object"
      ? Number((input as { webContentsId?: unknown }).webContentsId)
      : 0;
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
      return { ok: false, message: "A valid WebContents ID is required" };
    }
    const diagnostic = options.browserSurfaces.listWebContentsDiagnostics()
      .find((contents) => contents.webContentsId === webContentsId && contents.type === "webview");
    const contents = diagnostic ? options.browserSurfaces.findWebContentsById(webContentsId) : null;
    if (!contents || contents.isDestroyed()) {
      return { ok: false, message: "The WebView is no longer available" };
    }
    contents.openDevTools({ mode: "detach" });
    return { ok: true };
  });

  ipcMain.handle("diagnostics.clearAgentRealtimeDebugTrace", async () => {
    assistantBridgeRuntime.realtimeBroker.clearDebugTrace();
    return readAgentRealtimeDebugSnapshot();
  });

}
