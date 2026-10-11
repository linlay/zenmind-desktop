import type { DesktopActionCallRequest } from "../../../shared/desktop-actions";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import { asRecord, fail, readString } from "./action-values";
import { callRendererAction, readWorkPanelWorkspace } from "./renderer-action-results";

type ActiveDocument = { workspaceId: string; itemId: string; documentId: string };

function activeDocument(value: unknown, chatId: string, agentKey: string): ActiveDocument | null {
  const result = asRecord(value);
  if (result.ok !== true) throw new Error("Invalid WorkPanel state.");
  if (result.state === undefined && result.workspaceId === "") return null;
  const workspace = readWorkPanelWorkspace(result.state);
  if (!workspace || workspace.workspaceId !== result.workspaceId || workspace.ownerChatId !== chatId) {
    throw new Error("WorkPanel owner changed.");
  }
  if (workspace.activeItemId === null) return null;
  const items = workspace.items.filter(item => asRecord(item).itemId === workspace.activeItemId);
  if (items.length !== 1) throw new Error("Active WorkPanel item is unavailable.");
  const descriptor = asRecord(asRecord(items[0]).descriptor);
  if (descriptor.kind !== "native" || descriptor.surfaceKey !== "local-document") return null;
  const context = asRecord(descriptor.context);
  const documentId = readString(context, "documentId");
  if (!documentId || context.ownerChatId !== chatId || context.agentKey !== agentKey) {
    throw new Error("Active document owner changed.");
  }
  return { workspaceId: workspace.workspaceId, itemId: workspace.activeItemId, documentId };
}

/** Original paths are resolved only for the internally authorized Run, never from public source JSON. */
export async function executeWorkPanelStateAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext,
) {
  const contents = options.getMainWindow()?.webContents;
  const frame = contents?.mainFrame;
  const isCurrent = () => !options.actionSignal?.aborted && Boolean(contents && frame &&
    !contents.isDestroyed() && options.getMainWindow()?.webContents === contents && contents.mainFrame === frame);
  const trustedSource = asRecord(request.source);
  if (invocation.kind === "agentPlatform" && readString(trustedSource, "chatId") &&
    readString(trustedSource, "agentKey") && readString(trustedSource, "runId")) {
    try {
      await options.waitForWorkPanelFilePresentation?.({
        chatId: readString(trustedSource, "chatId"), agentKey: readString(trustedSource, "agentKey"),
      });
      if (!isCurrent()) throw new Error("WorkPanel lifecycle changed.");
    } catch {
      return fail(request.action, "target_unavailable", "File preview presentation is unavailable. Activate the intended file and retry workpanel_state.");
    }
  }
  const response = await callRendererAction(options, request, asRecord(request.args));
  if (!response.ok) return response;
  // Renderer state is preview metadata. It cannot supply or override the private path field.
  const { activeFile: _untrustedFile, ...state } = asRecord(response.result);
  const previewResponse = { ...response, result: state };
  if (invocation.kind !== "agentPlatform") return previewResponse;

  const source = asRecord(request.source);
  const chatId = readString(source, "chatId");
  const agentKey = readString(source, "agentKey");
  if (!chatId || !agentKey || !readString(source, "runId")) {
    return fail(request.action, "source_owner_required", "A trusted Run, Chat and Agent are required to resolve the active file.");
  }
  try {
    if (!isCurrent()) throw new Error("WorkPanel lifecycle changed.");
    const selected = activeDocument(state, chatId, agentKey);
    if (!selected) return { ...previewResponse, result: { ...state, activeFile: null } };
    if (!options.resolveWorkPanelActiveFile) throw new Error("Original-file resolver is unavailable.");
    const file = await options.resolveWorkPanelActiveFile({ chatId, agentKey, documentId: selected.documentId }, async () => {
      if (!isCurrent()) return false;
      const refreshed = await callRendererAction(options, request, asRecord(request.args));
      if (!refreshed.ok || !isCurrent()) return false;
      const current = activeDocument(refreshed.result, chatId, agentKey);
      return current?.workspaceId === selected.workspaceId && current.itemId === selected.itemId &&
        current.documentId === selected.documentId;
    });
    if (!isCurrent() || !file) throw new Error("Active original file is unavailable.");
    return { ...previewResponse, result: { ...state, activeFile: file } };
  } catch {
    return fail(request.action, "target_unavailable", "The active original file is unavailable or changed. Open or activate the intended file and retry workpanel_state.");
  }
}
