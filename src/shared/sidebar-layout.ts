export const SIDEBAR_EXPANDED_MIN_WIDTH = 280;
export const SIDEBAR_EXPANDED_MAX_WIDTH = 360;
export const SIDEBAR_COLLAPSED_WIDTH = 66;
export const SIDEBAR_AUTO_COLLAPSE_THRESHOLD = SIDEBAR_EXPANDED_MIN_WIDTH / 2;

export type SidebarLayoutMode = "expanded" | "collapsed";

export type SidebarLayoutState = {
  mode: SidebarLayoutMode;
  expandedWidth: number;
};

type SidebarLayoutDragInput = {
  initialState: SidebarLayoutState;
  deltaX: number;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clampSidebarExpandedWidth(width: number) {
  return Math.min(
    SIDEBAR_EXPANDED_MAX_WIDTH,
    Math.max(SIDEBAR_EXPANDED_MIN_WIDTH, Math.round(width))
  );
}

export function normalizeSidebarLayoutState(value: unknown): SidebarLayoutState {
  const record = asRecord(value);
  const legacyCollapsed = typeof record.collapsed === "boolean" ? record.collapsed : null;
  const mode =
    record.mode === "collapsed" || record.mode === "expanded"
      ? record.mode
      : legacyCollapsed
        ? "collapsed"
        : "expanded";
  const width =
    readFiniteNumber(record.expandedWidth) ??
    readFiniteNumber(record.width) ??
    SIDEBAR_EXPANDED_MIN_WIDTH;

  return {
    mode,
    expandedWidth: clampSidebarExpandedWidth(width)
  };
}

export function resolveRenderedSidebarWidth(state: SidebarLayoutState) {
  return state.mode === "collapsed"
    ? SIDEBAR_COLLAPSED_WIDTH
    : clampSidebarExpandedWidth(state.expandedWidth);
}

export function toggleSidebarLayoutState(state: SidebarLayoutState): SidebarLayoutState {
  return {
    ...state,
    mode: state.mode === "collapsed" ? "expanded" : "collapsed"
  };
}

export function resolveSidebarLayoutStateFromDrag({
  initialState,
  deltaX
}: SidebarLayoutDragInput): SidebarLayoutState {
  const normalizedState = normalizeSidebarLayoutState(initialState);
  if (normalizedState.mode === "collapsed") {
    if (deltaX <= 0) {
      return normalizedState;
    }

    return {
      mode: "expanded",
      expandedWidth: clampSidebarExpandedWidth(
        SIDEBAR_EXPANDED_MIN_WIDTH + deltaX
      )
    };
  }

  const rawWidth = normalizedState.expandedWidth + deltaX;
  if (rawWidth <= SIDEBAR_AUTO_COLLAPSE_THRESHOLD) {
    return {
      mode: "collapsed",
      expandedWidth: normalizedState.expandedWidth
    };
  }

  return {
    mode: "expanded",
    expandedWidth: clampSidebarExpandedWidth(rawWidth)
  };
}
