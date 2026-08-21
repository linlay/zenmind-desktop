export const WORK_PANEL_MIN_WIDTH = 420;
export const WORK_PANEL_MAIN_MIN_WIDTH = 420;
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
    Math.floor(finiteAvailableWidth - WORK_PANEL_MAIN_MIN_WIDTH),
  );
}

export function clampWorkPanelWidth(width: number, availableWidth?: number) {
  const maxWidth = resolveWorkPanelMaxWidth(availableWidth);
  const finiteWidth = readFiniteNumber(width) ?? WORK_PANEL_MIN_WIDTH;
  return Math.min(maxWidth, Math.max(WORK_PANEL_MIN_WIDTH, Math.round(finiteWidth)));
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
  return clampWorkPanelWidth(
    input.initialWidth + input.startClientX - input.currentClientX,
    input.availableWidth,
  );
}
