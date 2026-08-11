import { useEffect, useRef } from "react";
import type { ChatWorkPanelWorkspace } from "../../shared/chat-work-panel";
import {
  CHAT_WORK_PANEL_BLANK_URL,
  normalizeChatWorkPanelUrl
} from "../../shared/chat-work-panel";
import type {
  ExternalWebviewController,
  ExternalWebviewControllerState
} from "../pages/external-webview/ExternalWebviewPage";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { ChatWorkPanelSurface } from "./ChatWorkPanelSurface";

type ChatWorkPanelHostProps = {
  activeChatId: string | null;
  workspaces: ChatWorkPanelWorkspace[];
  ensureWorkspace: (chatId: string, initialUrl?: string, initialTitle?: string) => ChatWorkPanelWorkspace;
  closeWorkspace: (chatId: string) => void;
};

function actionError(code: string, message: string, details?: unknown) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

function serializeState(state: ExternalWebviewControllerState) {
  return {
    open: true,
    surfaceId: state.surfaceId,
    activeTabId: state.activeTabId ?? undefined,
    tabs: state.tabs
  };
}

export function ChatWorkPanelHost({
  activeChatId,
  workspaces,
  ensureWorkspace,
  closeWorkspace
}: ChatWorkPanelHostProps) {
  const controllersRef = useRef(new Map<string, {
    generation: string;
    controller: ExternalWebviewController;
  }>());
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const waitForController = async (chatId: string, generation: string) => {
    const deadline = Date.now() + 8_000;
    do {
      const entry = controllersRef.current.get(chatId);
      if (entry?.generation === generation) {
        return entry.controller;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error("Work Panel controller is unavailable.");
  };

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    if (!request.action.startsWith("desktop.chatWorkPanel.")) {
      return null;
    }
    const chatId = request.source?.chatId?.trim() ?? "";
    if (!chatId) {
      return actionError("source_chat_required", "A trusted source.chatId is required.");
    }
    const args = request.args ?? {};
    const forbiddenKeys = ["chatId", "surfaceId", "agentKey"].filter((key) => key in args);
    if (forbiddenKeys.length > 0) {
      return actionError("invalid_args", `Work Panel actions do not accept: ${forbiddenKeys.join(", ")}.`);
    }
    const currentWorkspace = () => workspacesRef.current.find((workspace) => workspace.chatId === chatId) ?? null;

    try {
      switch (request.action) {
        case "desktop.chatWorkPanel.getState": {
          const workspace = currentWorkspace();
          if (!workspace) {
            return { ok: true, result: { open: false, tabs: [] } };
          }
          return {
            ok: true,
            result: serializeState(await (await waitForController(chatId, workspace.generation)).getState())
          };
        }
        case "desktop.chatWorkPanel.open": {
          const workspace = ensureWorkspace(chatId, CHAT_WORK_PANEL_BLANK_URL);
          return {
            ok: true,
            result: serializeState(await (await waitForController(chatId, workspace.generation)).getState())
          };
        }
        case "desktop.chatWorkPanel.close": {
          const workspace = currentWorkspace();
          const entry = controllersRef.current.get(chatId);
          if (workspace && entry?.generation === workspace.generation) {
            await entry.controller.unregisterSurface();
          }
          closeWorkspace(chatId);
          return { ok: true, result: { open: false, tabs: [] } };
        }
        case "desktop.chatWorkPanel.openTab": {
          const nextUrl = normalizeChatWorkPanelUrl(args.url);
          if (!nextUrl) {
            return actionError("invalid_url", "url must use http:, https:, or about:blank.", args);
          }
          const preferredTitle = typeof args.title === "string" ? args.title.trim() : "";
          const workspace = currentWorkspace();
          if (!workspace) {
            const nextWorkspace = ensureWorkspace(chatId, nextUrl, preferredTitle);
            const state = await (await waitForController(chatId, nextWorkspace.generation)).getState();
            return { ok: true, result: serializeState(state) };
          }
          const state = await (await waitForController(chatId, workspace.generation)).openTab(nextUrl, preferredTitle);
          return { ok: true, result: serializeState(state) };
        }
        case "desktop.chatWorkPanel.activateTab": {
          const tabId = typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!tabId) {
            return actionError("invalid_args", "tabId is required.");
          }
          const workspace = currentWorkspace();
          if (!workspace) {
            return actionError("panel_not_found", "The chat Work Panel is closed.");
          }
          const state = await (await waitForController(chatId, workspace.generation)).activateTab(tabId);
          return { ok: true, result: serializeState(state) };
        }
        case "desktop.chatWorkPanel.closeTab": {
          const tabId = typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!tabId) {
            return actionError("invalid_args", "tabId is required.");
          }
          const workspace = currentWorkspace();
          if (!workspace) {
            return actionError("panel_not_found", "The chat Work Panel is closed.");
          }
          const state = await (await waitForController(chatId, workspace.generation)).closeTab(tabId);
          if (!state) {
            closeWorkspace(chatId);
            return { ok: true, result: { open: false, tabs: [] } };
          }
          return { ok: true, result: serializeState(state) };
        }
        default:
          return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return actionError(message === "tab_not_found" ? "tab_not_found" : "chat_work_panel_failed", message);
    }
  }), [closeWorkspace, ensureWorkspace]);

  return (
    <>
      {workspaces.map((workspace) => {
        const visible = workspace.chatId === activeChatId;
        return (
          <ChatWorkPanelSurface
            key={workspace.generation}
            workspace={workspace}
            visible={visible}
            onClose={() => closeWorkspace(workspace.chatId)}
            onControllerReady={(controller) => {
              if (controller) {
                controllersRef.current.set(workspace.chatId, {
                  generation: workspace.generation,
                  controller
                });
              } else if (
                controllersRef.current.get(workspace.chatId)?.generation === workspace.generation
              ) {
                controllersRef.current.delete(workspace.chatId);
              }
            }}
          />
        );
      })}
    </>
  );
}
