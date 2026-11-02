export const WORK_PANEL_MIN_WIDTH = 420;
export const WORK_PANEL_MAIN_MIN_WIDTH = 420;
export const WORK_PANEL_COLLAPSED_MAIN_GAP = 6;
export const WORK_PANEL_COLLAPSE_DRAG_BUFFER = 96;
const WORK_PANEL_FADE_STEPS = 4;
export const WORK_PANEL_DEFAULT_MIN_WIDTH = 420;
export const WORK_PANEL_DEFAULT_MAX_WIDTH = 680;
export const WORK_PANEL_DEFAULT_VIEWPORT_RATIO = 0.42;
export const WORK_PANEL_RESIZE_STEP = 16;

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveWorkPanelMaxWidth(availableWidth?: number) {
  const finiteAvailableWidth = readFiniteNumber(availableWidth);
  if (finiteAvailableWidth === null || finiteAvailableWidth <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(
    WORK_PANEL_MIN_WIDTH,
    Math.floor(finiteAvailableWidth - WORK_PANEL_COLLAPSED_MAIN_GAP),
  );
}

export function clampWorkPanelWidth(width: number, availableWidth?: number) {
  const maxWidth = resolveWorkPanelMaxWidth(availableWidth);
  const finiteWidth = readFiniteNumber(width) ?? WORK_PANEL_MIN_WIDTH;
  const clampedWidth = Math.min(maxWidth, Math.max(WORK_PANEL_MIN_WIDTH, Math.round(finiteWidth)));
  const finiteAvailableWidth = readFiniteNumber(availableWidth);
  if (finiteAvailableWidth !== null && finiteAvailableWidth > 0 &&
      clampedWidth > finiteAvailableWidth - WORK_PANEL_MAIN_MIN_WIDTH) {
    const expandedMaxWidth = Math.floor(finiteAvailableWidth - WORK_PANEL_MAIN_MIN_WIDTH);
    // Hold the chat at its minimum until the pointer travels past the buffer.
    if (expandedMaxWidth >= WORK_PANEL_MIN_WIDTH &&
        clampedWidth < expandedMaxWidth + WORK_PANEL_COLLAPSE_DRAG_BUFFER) {
      return expandedMaxWidth;
    }
    return maxWidth;
  }
  return clampedWidth;
}

export function resolveDefaultWorkPanelWidth(viewportWidth: number) {
  const finiteViewportWidth = readFiniteNumber(viewportWidth) ?? 0;
  const responsiveWidth = finiteViewportWidth * WORK_PANEL_DEFAULT_VIEWPORT_RATIO;
  return Math.min(
    WORK_PANEL_DEFAULT_MAX_WIDTH,
    Math.max(WORK_PANEL_DEFAULT_MIN_WIDTH, Math.round(responsiveWidth)),
  );
}

export function normalizeStoredWorkPanelWidth(value: unknown, fallbackWidth: number) {
  const finiteValue = readFiniteNumber(value);
  return clampWorkPanelWidth(finiteValue ?? fallbackWidth);
}

export function resolveWorkPanelDragState(input: {
  initialWidth: number;
  startClientX: number;
  currentClientX: number;
  availableWidth?: number;
}) {
  const delta = input.startClientX - input.currentClientX;
  const availableWidth = readFiniteNumber(input.availableWidth);
  const expandedMaxWidth = availableWidth === null ? 0 : availableWidth - WORK_PANEL_MAIN_MIN_WIDTH;
  const fadeStep = (distance: number) => Math.min(WORK_PANEL_FADE_STEPS,
    Math.max(0, Math.floor(distance / (WORK_PANEL_COLLAPSE_DRAG_BUFFER / WORK_PANEL_FADE_STEPS)))) / WORK_PANEL_FADE_STEPS;
  if (availableWidth !== null && expandedMaxWidth >= WORK_PANEL_MIN_WIDTH &&
      input.initialWidth >= resolveWorkPanelMaxWidth(availableWidth)) {
    const restoreDistance = Math.max(0, -delta);
    const collapsedWidth = resolveWorkPanelMaxWidth(availableWidth);
    const width = Math.min(collapsedWidth, Math.max(WORK_PANEL_MIN_WIDTH, Math.round(input.initialWidth + delta)));
    const restoredWidth = clampWorkPanelWidth(
      Math.min(width, expandedMaxWidth), availableWidth,
    );
    return {
      // The panel edge follows the pointer one pixel for one pixel.
      width,
      settledWidth: restoreDistance >= WORK_PANEL_COLLAPSE_DRAG_BUFFER ? restoredWidth : collapsedWidth,
      mainChatOpacity: fadeStep(restoreDistance),
    };
  }
  const requestedWidth = input.initialWidth + delta;
  const collapseDistance = requestedWidth - expandedMaxWidth;
  const canPreviewCollapse = availableWidth !== null && expandedMaxWidth >= WORK_PANEL_MIN_WIDTH;
  const collapseProgress = canPreviewCollapse
    ? fadeStep(collapseDistance)
    : 0;
  const settledWidth = clampWorkPanelWidth(requestedWidth, input.availableWidth);
  const width = Math.min(resolveWorkPanelMaxWidth(input.availableWidth), Math.max(WORK_PANEL_MIN_WIDTH, Math.round(requestedWidth)));
  return {
    width,
    settledWidth,
    mainChatOpacity: 1 - collapseProgress,
  };
}

export function resolveWorkPanelWidthFromDrag(input: Parameters<typeof resolveWorkPanelDragState>[0]) {
  const state = resolveWorkPanelDragState(input);
  const availableWidth = readFiniteNumber(input.availableWidth);
  // Keyboard resizing commits a stable layout without a pointer preview.
  if (availableWidth !== null && input.currentClientX > input.startClientX &&
      input.initialWidth >= resolveWorkPanelMaxWidth(availableWidth)) {
    return clampWorkPanelWidth(Math.min(state.width, availableWidth - WORK_PANEL_MAIN_MIN_WIDTH), availableWidth);
  }
  return state.settledWidth;
}
