import { type DesktopActionCallResponse, type DesktopActionCallRequest } from "../../../shared/desktop-actions";
import { asRecord, fail, ok } from "./action-values";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { createHash } from "node:crypto";
import {
  type WorkPanelLocalFilePathResolution,
  normalizeWorkPanelLocalFileRelativePath,
  resolveWorkPanelLocalFileFromWorkspace,
} from "../work-panel";
import { callRendererAction, readWorkPanelWorkspace } from "./renderer-action-results";

export function validateOpenLocalFileArgs(
  args: Record<string, unknown>,
): { ok: true; root: "workspace" | "chat"; path: string; title: string; artifactId: string } | { ok: false; response: DesktopActionCallResponse } {
  const action = "desktop.workpanel.openLocalFile";
  const rejectedKeys = Object.keys(args).filter((key) => !["root", "path", "title", "artifactId"].includes(key));
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
  // The root names the tree the path is relative to. It defaults to the
  // Agent project; a Chat file needs no project at all.
  if (args.root !== undefined && args.root !== "workspace" && args.root !== "chat") {
    return {
      ok: false,
      response: fail(action, "invalid_args", "root must be \"workspace\" or \"chat\"."),
    };
  }
  // Platform names the published artifact a Chat file belongs to. It is the
  // identity later saves are checked against, so it is never invented here.
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  if (args.artifactId !== undefined && (
    args.root !== "chat" || !artifactId || artifactId.length > 256 || /[\u0000-\u001f\u007f]/u.test(artifactId)
  )) {
    return {
      ok: false,
      response: fail(action, "invalid_args", "artifactId must identify a published artifact of a chat-root file."),
    };
  }
  return { ok: true, root: args.root === "chat" ? "chat" : "workspace", path: requestedPath, title, artifactId };
}

// Native previews address Chat files by profile: published artifacts, and
// references, which also covers a file directly in the Chat root (uploads and
// generated images). Any other Chat path has no native profile.
function chatFileProfile(relativePath: string): "artifact" | "reference" | null {
  const parts = relativePath.split("/");
  if (parts.length >= 2 && parts[0] === "artifacts") return "artifact";
  if (parts.length === 1 || (parts.length >= 2 && parts[0] === "references")) return "reference";
  return null;
}

// A Chat file opens the way it does when the user clicks it in the
// conversation: HTML and images in the native isolated preview, everything
// else as the WebClient resource page. Platform serves the bytes.
async function openChatFile(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  input: { ownerChatId: string; agentKey: string; path: string; title: string; artifactId: string },
): Promise<DesktopActionCallResponse> {
  const action = "desktop.workpanel.openLocalFile";
  const relativePath = normalizeWorkPanelLocalFileRelativePath(input.path);
  if (!relativePath) return fail(action, "invalid_path", "path must be a Chat-relative file path.");
  const title = input.title || relativePath.split("/").at(-1)!;
  const profile = chatFileProfile(relativePath);
  if (input.artifactId && profile !== "artifact") {
    return fail(action, "invalid_args", "artifactId applies only to a file under artifacts/.");
  }
  // A published artifact keeps its manifest id. Other Chat files have no
  // identity beyond their path, so the id only has to be stable and short.
  const resourceId = input.artifactId ||
    `chat-file:${createHash("sha256").update(relativePath).digest("hex").slice(0, 32)}`;
  // An editable native preview saves an artifact against its manifest entry;
  // without the real id it would open and then fail to save.
  const nativeAllowed = profile === "reference" || (profile === "artifact" && Boolean(input.artifactId));
  if (profile && nativeAllowed && options.openWorkPanelDocument) {
    const native = await options.openWorkPanelDocument({
      ownerChatId: input.ownerChatId,
      document: {
        source: { kind: profile, agentKey: input.agentKey, chatId: input.ownerChatId, resourceId, relativePath },
        title,
      },
    });
    if (native.ok) {
      // The native host reports only the item; Platform expects the workspace.
      const state = await options.callRendererAction({
        requestId: request.requestId || resourceId,
        action: "desktop.workpanel.getState",
        args: {},
        source: request.source,
      });
      const workspace = state.ok ? readWorkPanelWorkspace(asRecord(state.result).state) : null;
      return workspace
        ? ok(action, { workspace })
        : fail(action, "invalid_action_result", "The WorkPanel state is unavailable after opening the document.");
    }
    // Only a non-HTML, non-image file falls through to the WebClient page.
    if (native.error.code !== "unsupported_native_type") {
      return fail(action, native.error.code, native.error.message);
    }
  }
  const file = relativePath.split("/").map(encodeURIComponent).join("/");
  const route = `/resource-viewer/${encodeURIComponent(input.agentKey)}?${new URLSearchParams({
    chatId: input.ownerChatId,
    file,
    // The WebClient viewer needs the full source to save a published artifact.
    ...(input.artifactId ? { sourceKind: "artifact", resourceId: input.artifactId, relativePath } : {}),
  })}`;
  const response = await callRendererAction(options, { ...request, action: "desktop.workpanel.openTab" }, {
    descriptor: {
      kind: "webclient",
      module: "artifact",
      route,
      title,
      context: { agentKey: input.agentKey, chatId: input.ownerChatId, artifactId: resourceId, relativePath },
    },
  });
  return { ...response, action };
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
  if (validated.root === "chat") {
    return openChatFile(options, request, {
      ownerChatId, agentKey, path: validated.path, title: validated.title, artifactId: validated.artifactId,
    });
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
