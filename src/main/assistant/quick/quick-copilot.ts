import { DEFAULT_QUICK_ASSISTANT_SHORTCUT } from "../../../shared/assistant-settings";

export const QUICK_ASSISTANT_ROUTE = "/quick-assistant";
export const QUICK_ASSISTANT_SHORTCUT = DEFAULT_QUICK_ASSISTANT_SHORTCUT;

export const QUICK_ASSISTANT_WEB_COPILOT_SIZE = {
  width: 360,
  height: 600
} as const;

type Platform = NodeJS.Platform | string;

type WorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type QuickAssistantMediaPermissionRequest = {
  permission: string;
  contentsId: number;
  mainContentsId?: number | null;
  quickContentsId?: number | null;
  mediaTypes?: string[];
};

export function isQuickAssistantSupportedPlatform(platform: Platform) {
  return platform === "darwin";
}

export function getQuickAssistantWebCopilotBounds({
  workArea
}: {
  workArea: WorkArea;
}) {
  const margin = 12;
  const width = Math.min(QUICK_ASSISTANT_WEB_COPILOT_SIZE.width, Math.max(280, workArea.width - margin * 2));
  const height = Math.min(QUICK_ASSISTANT_WEB_COPILOT_SIZE.height, Math.max(320, workArea.height - margin * 2));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

export function isQuickAssistantMediaPermissionAllowed({
  permission,
  contentsId,
  mainContentsId,
  quickContentsId,
  mediaTypes
}: QuickAssistantMediaPermissionRequest) {
  if (permission !== "media") {
    return false;
  }
  if (contentsId !== mainContentsId && contentsId !== quickContentsId) {
    return false;
  }
  return !mediaTypes || mediaTypes.includes("audio");
}
