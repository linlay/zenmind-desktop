// User-facing file addresses, the same spelling Agent WebClient Markdown
// accepts: "@chat/<path>" names a file in the owner Chat and
// "@workspace/<path>" a file in the Agent Workspace. The path is literal and
// never percent-encoded, so an address copied from the WorkPanel opens the
// same file when pasted into Markdown within the same Chat.
export const WORK_PANEL_CHAT_FILE_ALIAS = "@chat/";
export const WORK_PANEL_WORKSPACE_FILE_ALIAS = "@workspace/";

export type WorkPanelFileAddressSource = "workspace-file" | "artifact" | "reference";

export function workPanelFileAddressPrefix(source: WorkPanelFileAddressSource) {
  return source === "workspace-file" ? WORK_PANEL_WORKSPACE_FILE_ALIAS : WORK_PANEL_CHAT_FILE_ALIAS;
}

// Artifacts and References are both Chat files; the address does not encode
// publication identity, which stays in the descriptor.
export function formatWorkPanelFileAddress(source: WorkPanelFileAddressSource, relativePath: string) {
  const path = relativePath.trim();
  return path ? `${workPanelFileAddressPrefix(source)}${path}` : "";
}
