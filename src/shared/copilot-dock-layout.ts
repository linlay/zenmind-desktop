export const COPILOT_DOCK_DEFAULT_WIDTH = 360;
export const COPILOT_DOCK_MIN_WIDTH = 320;
export const COPILOT_DOCK_MAX_WIDTH = 640;
export const COPILOT_DOCK_MAIN_MIN_WIDTH = 800;
export const COPILOT_DOCK_RESIZE_STEP = 16;
export const COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH =
  COPILOT_DOCK_MIN_WIDTH + COPILOT_DOCK_MAIN_MIN_WIDTH;

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function shouldOverlayCopilotDock(availableWidth?: number) {
  const finiteAvailableWidth = readFiniteNumber(availableWidth);
  return finiteAvailableWidth !== null &&
    finiteAvailableWidth > 0 &&
    finiteAvailableWidth < COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH;
}

export function resolveCopilotDockMaxWidth(availableWidth?: number) {
  const finiteAvailableWidth = readFiniteNumber(availableWidth);
  if (finiteAvailableWidth === null || finiteAvailableWidth <= 0) {
    return COPILOT_DOCK_MAX_WIDTH;
  }
  return Math.min(
    COPILOT_DOCK_MAX_WIDTH,
    Math.max(
      COPILOT_DOCK_MIN_WIDTH,
      Math.floor(finiteAvailableWidth - COPILOT_DOCK_MAIN_MIN_WIDTH),
    ),
  );
}

export function clampCopilotDockWidth(width: number, availableWidth?: number) {
  const finiteWidth = readFiniteNumber(width) ?? COPILOT_DOCK_DEFAULT_WIDTH;
  return Math.min(
    resolveCopilotDockMaxWidth(availableWidth),
    Math.max(COPILOT_DOCK_MIN_WIDTH, Math.round(finiteWidth)),
  );
}

export function normalizeStoredCopilotDockWidth(value: unknown) {
  const finiteValue = readFiniteNumber(value);
  return clampCopilotDockWidth(finiteValue ?? COPILOT_DOCK_DEFAULT_WIDTH);
}

export function resolveRenderedCopilotDockWidth(
  preferredWidth: number,
  availableWidth?: number,
) {
  return shouldOverlayCopilotDock(availableWidth)
    ? clampCopilotDockWidth(preferredWidth)
    : clampCopilotDockWidth(preferredWidth, availableWidth);
}

export function resolveCopilotDockWidthFromDrag(input: {
  initialWidth: number;
  startClientX: number;
  currentClientX: number;
  availableWidth?: number;
}) {
  return clampCopilotDockWidth(
    input.initialWidth + input.startClientX - input.currentClientX,
    input.availableWidth,
  );
}
