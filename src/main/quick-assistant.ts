export const QUICK_ASSISTANT_ROUTE = "/quick-assistant";
export const QUICK_ASSISTANT_SHORTCUT = "Alt+Space";

export const QUICK_ASSISTANT_COMPACT_SIZE = {
  width: 520,
  height: 112
} as const;

export const QUICK_ASSISTANT_EXPANDED_SIZE = {
  width: 500,
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function getQuickAssistantBounds({
  expanded,
  workArea
}: {
  expanded: boolean;
  workArea: WorkArea;
}) {
  const targetSize = expanded ? QUICK_ASSISTANT_EXPANDED_SIZE : QUICK_ASSISTANT_COMPACT_SIZE;
  const margin = expanded ? 20 : 12;
  const width = Math.min(targetSize.width, Math.max(360, workArea.width - margin * 2));
  const height = Math.min(targetSize.height, Math.max(96, workArea.height - margin * 2));
  const centeredY = workArea.y + (workArea.height - height) / 2;
  const downwardOffset = expanded ? Math.min(120, workArea.height * 0.14) : workArea.height * 0.3;
  const y = clamp(
    Math.floor(centeredY + downwardOffset),
    workArea.y + margin,
    workArea.y + workArea.height - height - margin
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y,
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
