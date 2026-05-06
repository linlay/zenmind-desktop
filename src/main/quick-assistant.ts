export const QUICK_ASSISTANT_ROUTE = "/quick-assistant";
export const QUICK_ASSISTANT_SHORTCUT = "Alt+Space";
export const QUICK_ASSISTANT_COMPACT_REQUEST_CHANNEL = "quickAssistant.compactModeRequested";

export const QUICK_ASSISTANT_COMPACT_SIZE = {
  width: 430,
  height: 76
} as const;

export const QUICK_ASSISTANT_ATTACHMENT_SIZE = {
  width: 430,
  height: 128
} as const;

export const QUICK_ASSISTANT_EXPANDED_SIZE = {
  width: 500,
  height: 600
} as const;

export type QuickAssistantDisplayMode = "compact" | "attachment" | "expanded";

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

type QuickAssistantInteractionState = {
  busy: boolean;
  mouseInside: boolean;
};

export function isQuickAssistantSupportedPlatform(platform: Platform) {
  return platform === "darwin";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function normalizeDisplayMode(mode: QuickAssistantDisplayMode | undefined, expanded?: boolean) {
  if (mode === "compact" || mode === "attachment" || mode === "expanded") {
    return mode;
  }
  return expanded ? "expanded" : "compact";
}

export function getQuickAssistantBounds({
  expanded,
  mode,
  workArea
}: {
  expanded?: boolean;
  mode?: QuickAssistantDisplayMode;
  workArea: WorkArea;
}) {
  const displayMode = normalizeDisplayMode(mode, expanded);
  const targetSize = displayMode === "expanded"
    ? QUICK_ASSISTANT_EXPANDED_SIZE
    : displayMode === "attachment"
      ? QUICK_ASSISTANT_ATTACHMENT_SIZE
      : QUICK_ASSISTANT_COMPACT_SIZE;
  const margin = displayMode === "expanded" ? 20 : 12;
  const width = Math.min(targetSize.width, Math.max(360, workArea.width - margin * 2));
  const height = Math.min(targetSize.height, Math.max(96, workArea.height - margin * 2));
  const centeredY = workArea.y + (workArea.height - height) / 2;
  const downwardOffset = displayMode === "expanded" ? Math.min(120, workArea.height * 0.14) : workArea.height * 0.3;
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

export function createQuickAssistantWindowState() {
  let displayMode: QuickAssistantDisplayMode = "compact";
  let interactionState: QuickAssistantInteractionState = {
    busy: false,
    mouseInside: false
  };

  function isExpanded() {
    return displayMode === "expanded";
  }

  function getInteractionState() {
    return { ...interactionState };
  }

  function resetInteractionState() {
    interactionState = {
      busy: false,
      mouseInside: false
    };
    return getInteractionState();
  }

  return {
    isExpanded,
    getDisplayMode: () => displayMode,
    setExpanded(nextExpanded: boolean) {
      displayMode = nextExpanded ? "expanded" : "compact";
      return isExpanded();
    },
    setDisplayMode(nextDisplayMode: QuickAssistantDisplayMode) {
      displayMode = normalizeDisplayMode(nextDisplayMode);
      return displayMode;
    },
    getInteractionState,
    setInteractionState(state: { busy?: boolean; mouseInside?: boolean }) {
      interactionState = {
        ...interactionState,
        ...(typeof state?.busy === "boolean" ? { busy: state.busy } : {}),
        ...(typeof state?.mouseInside === "boolean" ? { mouseInside: state.mouseInside } : {})
      };
      return getInteractionState();
    },
    resetInteractionState,
    prepareCompactShow() {
      displayMode = "compact";
      const nextInteractionState = resetInteractionState();
      return {
        expanded: isExpanded(),
        displayMode,
        interactionState: nextInteractionState
      };
    }
  };
}
