import { type DesktopActionCallResponse, type DesktopActionCallRequest } from "../../../shared/desktop-actions";
import { fail } from "./action-values";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { type WorkPanelLocalFilePathResolution, resolveWorkPanelLocalFileFromWorkspace } from "../work-panel";
import { callRendererAction } from "./renderer-action-results";

export function validateOpenLocalFileArgs(
  args: Record<string, unknown>,
): { ok: true; path: string; title: string } | { ok: false; response: DesktopActionCallResponse } {
  const action = "desktop.workpanel.openLocalFile";
  const rejectedKeys = Object.keys(args).filter((key) => key !== "path" && key !== "title");
  if (rejectedKeys.length > 0) {
    return {
      ok: false,
      response: fail(action, "invalid_args", `openLocalFile does not accept: ${rejectedKeys.join(", ")}.`),
    };
  }
  const requestedPath = typeof args.path === "string" ? args.path : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (args.title !== undefined && (typeof args.title !== "string" || title.length > 160)) {
    return {
      ok: false,
      response: fail(action, "invalid_args", "title must be a string of at most 160 characters."),
    };
  }
  return { ok: true, path: requestedPath, title };
}

export async function executeOpenLocalFileAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
): Promise<DesktopActionCallResponse> {
  const action = "desktop.workpanel.openLocalFile";
  const validated = validateOpenLocalFileArgs(args);
  if (!validated.ok) return validated.response;
  const source = request.source;
  const runId = source?.runId?.trim() || "";
  const ownerChatId = source?.chatId?.trim() || "";
  const agentKey = source?.agentKey?.trim() || "";
  if (!runId || !ownerChatId || !agentKey || source?.teamId) {
    return fail(action, "forbidden", "openLocalFile requires a trusted Agent-owned Platform Run.");
  }

  let workspaceResolution: WorkPanelLocalFilePathResolution;
  try {
    const navigation = await options.assistantBridge.listNavigationAgents();
    const agent = navigation.ok
      ? navigation.items.find((candidate) => candidate.agentKey === agentKey)
      : null;
    const workspaceDir = agent?.workspaceDir?.trim() || "";
    if (!workspaceDir || workspaceDir === "@chat" || agent?.workspaceDirExists === false) {
      return fail(action, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
    }
    workspaceResolution = resolveWorkPanelLocalFileFromWorkspace(
      workspaceDir,
      validated.path,
      options.platform ?? process.platform,
    );
  } catch {
    return fail(action, "workspace_unavailable", "Desktop could not resolve the Agent workspace.");
  }
  if (!workspaceResolution.ok) {
    return fail(action, workspaceResolution.code, workspaceResolution.message);
  }

  const mainWindow = options.getMainWindow();
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed() ||
    !options.prepareWorkPanelLocalFileClaim ||
    !options.discardWorkPanelLocalFileClaim
  ) {
    return fail(action, "target_unavailable", "The Desktop WorkPanel renderer is unavailable.");
  }
  const prepared = options.prepareWorkPanelLocalFileClaim({
    ownerChatId,
    rendererWebContentsId: mainWindow.webContents.id,
    filePath: workspaceResolution.filePath,
    workspaceRelativePath: workspaceResolution.relativePath,
  });
  if (!prepared) {
    return fail(action, "file_unavailable", "The requested local file became unavailable.");
  }
  try {
    return await callRendererAction(options, request, {
      claimId: prepared.claimId,
      ...(validated.title ? { title: validated.title } : {}),
    });
  } finally {
    options.discardWorkPanelLocalFileClaim(prepared.claimId);
  }
}
