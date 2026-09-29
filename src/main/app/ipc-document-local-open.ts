import { createDocumentLocalOpenService, createWorkPanelDocumentReader } from "../modules/work-panel";
import type { MainIpcRegistrationOptions } from "./ipc-registration-contracts";

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export function createDesktopDocumentLocalOpen(options: MainIpcRegistrationOptions) {
  if (options.platform !== "darwin" && options.platform !== "win32") return undefined;
  const { app } = options;
  const { assistantBridge } = options.assistantBridgeRuntime;
  const readDocument = createWorkPanelDocumentReader({
    app,
    platform: options.platform,
    getWorkspace: async (agentKey) => {
      const navigation = await assistantBridge.listNavigationAgents();
      const agent = navigation.ok ? navigation.items.find((item) => item.agentKey === agentKey) : null;
      return agent?.workspaceDirExists === false ? null : agent?.workspaceDir?.trim() || null;
    },
    verifyChatOwner: async (chatId, agentKey) => {
      const info = await assistantBridge.getChatInfo(chatId);
      return info?.chatId === chatId && info.agentKey === agentKey;
    },
    fetchResource: async (chatId, relativePath) => {
      const state = await options.servicesFacade.getServiceState(app, "agent-platform");
      const endpoint = state.status === "running"
        ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "") : "";
      if (!endpoint) throw new Error("Platform is unavailable");
      const identity = await options.issueAgentAccessToken(app, "missing");
      if (!identity.ok || !identity.token.trim()) throw new Error("Platform identity is unavailable");
      const url = new URL("/api/resource", endpoint);
      url.searchParams.set("file", `${chatId}/${relativePath}`);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${identity.token.trim()}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body) throw new Error("Document is unavailable");
      if (Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) {
        await response.body.cancel();
        throw new Error("Document exceeds the local-open size limit");
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_DOCUMENT_BYTES) {
            await reader.cancel();
            throw new Error("Document exceeds the local-open size limit");
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, total);
    },
  });
  return createDocumentLocalOpenService({
    readDocument,
    platform: options.platform,
    getDownloadsPath: () => app.getPath("downloads"),
    showSaveDialog: (dialog) => options.showSaveDialog(dialog, options.getMainWindow()),
  });
}
