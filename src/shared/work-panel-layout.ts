export const WORK_PANEL_MIN_WIDTH = 420;
export const WORK_PANEL_MAIN_MIN_WIDTH = 420;
export const WORK_PANEL_COLLAPSED_MAIN_GAP = 6;
export const WORK_PANEL_COLLAPSE_DRAG_BUFFER = 96;
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

export function resolveWorkPanelWidthFromDrag(input: {
  initialWidth: number;
  startClientX: number;
  currentClientX: number;
  availableWidth?: number;
}) {
  const delta = input.startClientX - input.currentClientX;
  const availableWidth = readFiniteNumber(input.availableWidth);
  // A rightward drag from the collapsed position restores the chat immediately.
  const initialWidth = availableWidth !== null && availableWidth > 0 && delta < 0 &&
    input.initialWidth >= resolveWorkPanelMaxWidth(availableWidth)
    ? Math.max(WORK_PANEL_MIN_WIDTH, availableWidth - WORK_PANEL_MAIN_MIN_WIDTH)
    : input.initialWidth;
  return clampWorkPanelWidth(initialWidth + delta, input.availableWidth);
}
