import type { DesktopPetWindowMode, DesktopPetEdgeDock } from "../../../shared/contracts";
import {
  DESKTOP_PET_WINDOW_SIZES,
  DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_WINDOW_SIZE,
  DEFAULT_OFFSET,
  DESKTOP_PET_EDGE_SNAP_DISTANCE_PX,
  DESKTOP_PET_EDGE_STICK_DISTANCE_PX,
  DESKTOP_PET_PANEL_WINDOW_INSET_PX
} from "./pet-window-metrics";
import type { DesktopPetDisplayBounds, DisplayArea, DesktopPetClampOptions } from "./pet-model";

export function getDesktopPetWindowSize(mode: DesktopPetWindowMode = "base") {
  return DESKTOP_PET_WINDOW_SIZES[mode] ?? DESKTOP_PET_WINDOW_SIZES.base;
}

export function resolveDesktopPetDisplayArea(display: DesktopPetDisplayBounds): DisplayArea {
  const horizontalBounds = display.bounds ?? display.workArea;
  const workAreaBottom = display.workArea.y + display.workArea.height;
  const windowLeftInset = Math.max(0, display.workArea.x - horizontalBounds.x);
  return {
    x: horizontalBounds.x,
    y: display.workArea.y,
    width: Math.max(1, horizontalBounds.width),
    height: Math.max(1, workAreaBottom - display.workArea.y),
    ...(windowLeftInset > 0 ? { windowLeftInset } : {})
  };
}

export function desktopPetEdgeDockIncludes(edgeDock: DesktopPetEdgeDock, side: "top" | "right" | "bottom" | "left") {
  return edgeDock === side || Boolean(edgeDock?.includes(`${side}-`) || edgeDock?.includes(`-${side}`));
}

export function getDesktopPetVisibleFootprintForMode(mode: DesktopPetWindowMode, edgeDock: DesktopPetEdgeDock = null) {
  const footprint = DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode] ?? DESKTOP_PET_VISIBLE_FOOTPRINT;
  const size = getDesktopPetWindowSize(mode);
  const adjustedFootprint = {
    ...footprint
  };
  if (desktopPetEdgeDockIncludes(edgeDock, "left")) {
    adjustedFootprint.x = 0;
  } else if (desktopPetEdgeDockIncludes(edgeDock, "right")) {
    adjustedFootprint.x = size.width - DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  }
  if (desktopPetEdgeDockIncludes(edgeDock, "top")) {
    adjustedFootprint.y = 0;
  } else if (desktopPetEdgeDockIncludes(edgeDock, "bottom")) {
    adjustedFootprint.y = size.height - DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  }
  return adjustedFootprint;
}

export function clampDesktopPetPosition(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  size: { width: number; height: number } = DESKTOP_PET_WINDOW_SIZE,
  options: DesktopPetClampOptions = {}
) {
  const width = size.width;
  const height = size.height;
  const allowVisibleEdgeDock = options.allowVisibleEdgeDock &&
    width === DESKTOP_PET_WINDOW_SIZE.width &&
    height === DESKTOP_PET_WINDOW_SIZE.height;
  const minX = allowVisibleEdgeDock
    ? displayArea.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x
    : displayArea.x;
  const minY = allowVisibleEdgeDock
    ? displayArea.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y
    : displayArea.y;
  const maxX = allowVisibleEdgeDock
    ? displayArea.x + Math.max(
      0,
      displayArea.width - DESKTOP_PET_VISIBLE_FOOTPRINT.x - DESKTOP_PET_VISIBLE_FOOTPRINT.width
    )
    : displayArea.x + Math.max(0, displayArea.width - width);
  const maxY = allowVisibleEdgeDock
    ? displayArea.y + Math.max(
      0,
      displayArea.height - DESKTOP_PET_VISIBLE_FOOTPRINT.y - DESKTOP_PET_VISIBLE_FOOTPRINT.height
    )
    : displayArea.y + Math.max(0, displayArea.height - height);
  const fallbackX = Math.min(maxX, displayArea.x + DEFAULT_OFFSET.x);
  const fallbackY = Math.min(maxY, displayArea.y + DEFAULT_OFFSET.y);
  const resolved = position ?? { x: fallbackX, y: fallbackY };
  let x = Math.round(resolved.x);
  let y = Math.round(resolved.y);
  if (allowVisibleEdgeDock && options.stickToEdges) {
    const rightEdge = displayArea.x + displayArea.width;
    const bottomEdge = displayArea.y + displayArea.height;
    const visibleLeft = x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
    const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
    const visibleTop = y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
    const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
    if (Math.abs(visibleLeft - displayArea.x) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      x = minX;
    } else if (Math.abs(visibleRight - rightEdge) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      x = maxX;
    }
    if (Math.abs(visibleTop - displayArea.y) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      y = minY;
    } else if (Math.abs(visibleBottom - bottomEdge) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      y = maxY;
    }
  }
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
    width,
    height
  };
}

export function resolveDesktopPetEdgeDock(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea
): DesktopPetEdgeDock {
  if (!position) {
    return null;
  }
  const rightEdge = displayArea.x + displayArea.width;
  const bottomEdge = displayArea.y + displayArea.height;
  const visibleLeft = position.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
  const visibleTop = position.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
  const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  const vertical = visibleTop <= displayArea.y + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
    ? "top"
    : visibleBottom >= bottomEdge - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? "bottom"
      : "";
  const horizontal = visibleLeft <= displayArea.x + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
    ? "left"
    : visibleRight >= rightEdge - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? "right"
      : "";
  if (vertical && horizontal) {
    return `${vertical}-${horizontal}` as DesktopPetEdgeDock;
  }
  return (vertical || horizontal || null) as DesktopPetEdgeDock;
}

export type DesktopPetPanelLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopPetPanelLayoutSide = "above" | "below" | "left" | "right";

export function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampDesktopPetPanelAxis(center: number, size: number, min: number, max: number) {
  return Math.round(clampNumber(center - size / 2, min, max - size));
}

export function clampDesktopPetPanelRect(
  rect: DesktopPetPanelLayoutRect,
  displayArea: DisplayArea,
  displayRight: number,
  displayBottom: number
) {
  return {
    ...rect,
    x: Math.round(clampNumber(rect.x, displayArea.x, displayRight - rect.width)),
    y: Math.round(clampNumber(rect.y, displayArea.y, displayBottom - rect.height))
  };
}

export function resolveDesktopPetPanelLayout(input: {
  displayArea: DisplayArea;
  petRect: DesktopPetPanelLayoutRect;
  panelSize: { width: number; height: number };
  gap?: number;
}): { side: DesktopPetPanelLayoutSide; rect: DesktopPetPanelLayoutRect } {
  const gap = Math.max(0, Math.round(input.gap ?? 10));
  const displayRight = input.displayArea.x + input.displayArea.width;
  const displayBottom = input.displayArea.y + input.displayArea.height;
  const panelWidth = Math.min(input.panelSize.width, input.displayArea.width);
  const panelHeight = Math.min(input.panelSize.height, input.displayArea.height);
  const petCenterX = input.petRect.x + input.petRect.width / 2;
  const petCenterY = input.petRect.y + input.petRect.height / 2;
  const displayCenterY = input.displayArea.y + input.displayArea.height / 2;
  const horizontalX = clampDesktopPetPanelAxis(petCenterX, panelWidth, input.displayArea.x, displayRight);
  const verticalY = clampDesktopPetPanelAxis(petCenterY, panelHeight, input.displayArea.y, displayBottom);
  const candidates = [
    {
      side: "below" as const,
      rect: {
        x: horizontalX,
        y: Math.round(input.petRect.y + input.petRect.height + gap),
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "above" as const,
      rect: {
        x: horizontalX,
        y: Math.round(input.petRect.y - gap - panelHeight),
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "right" as const,
      rect: {
        x: Math.round(input.petRect.x + input.petRect.width + gap),
        y: verticalY,
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "left" as const,
      rect: {
        x: Math.round(input.petRect.x - gap - panelWidth),
        y: verticalY,
        width: panelWidth,
        height: panelHeight
      }
    }
  ];
  const preferredSides: DesktopPetPanelLayoutSide[] =
    input.petRect.y <= input.displayArea.y + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? ["below", "right", "left", "above"]
      : input.petRect.y + input.petRect.height >= displayBottom - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
        ? ["above", "right", "left", "below"]
        : petCenterY <= displayCenterY
          ? ["below", "above", "right", "left"]
          : ["above", "below", "right", "left"];

  for (const side of preferredSides) {
    const candidate = candidates.find((item) => item.side === side);
    if (!candidate) {
      continue;
    }
    const rectRight = candidate.rect.x + candidate.rect.width;
    const rectBottom = candidate.rect.y + candidate.rect.height;
    if (
      candidate.rect.x >= input.displayArea.x &&
      candidate.rect.y >= input.displayArea.y &&
      rectRight <= displayRight &&
      rectBottom <= displayBottom
    ) {
      return candidate;
    }
  }

  const fallbackCandidate =
    candidates.find((item) => item.side === preferredSides[0]) ?? candidates[0];
  return {
    side: fallbackCandidate.side,
    rect: clampDesktopPetPanelRect(
      fallbackCandidate.rect,
      input.displayArea,
      displayRight,
      displayBottom
    )
  };
}

export function resolveDesktopPetPanelWindowBounds(input: {
  displayArea: DisplayArea;
  petRect: DesktopPetPanelLayoutRect;
  windowSize: { width: number; height: number };
  gap?: number;
  inset?: number;
}): {
  side: DesktopPetPanelLayoutSide;
  rect: DesktopPetPanelLayoutRect;
  panelRect: DesktopPetPanelLayoutRect;
} {
  const inset = Math.max(0, Math.round(input.inset ?? DESKTOP_PET_PANEL_WINDOW_INSET_PX));
  const panelSize = {
    width: Math.max(1, input.windowSize.width - inset * 2),
    height: Math.max(1, input.windowSize.height - inset * 2)
  };
  const layout = resolveDesktopPetPanelLayout({
    displayArea: input.displayArea,
    petRect: input.petRect,
    panelSize,
    gap: input.gap
  });
  return {
    side: layout.side,
    panelRect: layout.rect,
    rect: {
      x: layout.rect.x - inset,
      y: layout.rect.y - inset,
      width: panelSize.width + inset * 2,
      height: panelSize.height + inset * 2
    }
  };
}

export function resolveDesktopPetWindowLayout(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  mode: DesktopPetWindowMode = "base"
) {
  const size = getDesktopPetWindowSize(mode);
  const baseBounds = clampDesktopPetPosition(position, displayArea, DESKTOP_PET_WINDOW_SIZE, {
    allowVisibleEdgeDock: true
  });
  const edgeDock = resolveDesktopPetEdgeDock(baseBounds, displayArea);
  const visibleX = baseBounds.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
  const visibleY = baseBounds.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
  const footprint = getDesktopPetVisibleFootprintForMode(mode, edgeDock);
  let bounds = {
    x: visibleX - footprint.x,
    y: visibleY - footprint.y,
    width: size.width,
    height: size.height
  };
  if (mode === "base") {
    // Keep the native host on screen, while the body moves continuously inside it.
    // macOS can constrain a narrow host to the side Dock's work-area inset, so
    // expand before crossing that inset without changing the visible position.
    const useWideLeftHost = baseBounds.x < displayArea.x + (displayArea.windowLeftInset ?? 0);
    bounds = {
      x: useWideLeftHost ? displayArea.x : Math.round(clampNumber(
        baseBounds.x, displayArea.x, displayArea.x + Math.max(0, displayArea.width - size.width)
      )),
      y: Math.round(clampNumber(
        baseBounds.y, displayArea.y, displayArea.y + Math.max(0, displayArea.height - size.height)
      )),
      width: useWideLeftHost ? Math.max(size.width, displayArea.width) : size.width,
      height: size.height
    };
  }
  return {
    bounds,
    bodyOffset: { x: visibleX - bounds.x, y: visibleY - bounds.y },
    position: { x: baseBounds.x, y: baseBounds.y },
    edgeDock
  };
}

export type DesktopPetWindowLayout = ReturnType<typeof resolveDesktopPetWindowLayout>;

export function getAnchoredDesktopPetBounds(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  mode: DesktopPetWindowMode = "base"
) {
  return resolveDesktopPetWindowLayout(position, displayArea, mode).bounds;
}

export function getDesktopPetLogicalPositionFromBounds(
  bounds: { x: number; y: number },
  mode: DesktopPetWindowMode = "base",
  displayArea?: DisplayArea,
  preferredPosition?: { x: number; y: number }
) {
  if (displayArea) {
    // A clamped host can represent several visible positions. Preserve the known
    // logical anchor instead of inferring a different one from its native frame.
    if (mode === "base" && preferredPosition) {
      const preferredLayout = resolveDesktopPetWindowLayout(preferredPosition, displayArea, mode);
      if (preferredLayout.bounds.x === bounds.x && preferredLayout.bounds.y === bounds.y &&
        (!("width" in bounds) || preferredLayout.bounds.width === bounds.width) &&
        (!("height" in bounds) || preferredLayout.bounds.height === bounds.height)) {
        return preferredLayout.position;
      }
    }
    const displayRight = displayArea.x + displayArea.width;
    const shouldPreferWindowBoundaryEdges = mode === "base";
    const boundsTouchLeft = shouldPreferWindowBoundaryEdges && bounds.x <= displayArea.x + 1;
    const boundsWidth = "width" in bounds ? Number((bounds as { width?: number }).width) : Number.NaN;
    const isFullWidthLeftHost = boundsTouchLeft &&
      Number.isFinite(boundsWidth) &&
      boundsWidth >= displayArea.width - 1;
    const boundsTouchRight = shouldPreferWindowBoundaryEdges && !isFullWidthLeftHost && Number.isFinite(boundsWidth)
      ? bounds.x + boundsWidth >= displayRight - 1
      : false;
    const edgeCandidates: DesktopPetEdgeDock[] = [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
      "top",
      "right",
      "bottom",
      "left",
      null
    ];
    const matches: Array<{
      logicalPosition: { x: number; y: number };
      distance: number;
      edgeScore: number;
    }> = [];
    for (const edgeDock of edgeCandidates) {
      const footprint = getDesktopPetVisibleFootprintForMode(mode, edgeDock);
      const logicalPosition = {
        x: Math.round(bounds.x + footprint.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x),
        y: Math.round(bounds.y + footprint.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y)
      };
      const reanchoredBounds = getAnchoredDesktopPetBounds(logicalPosition, displayArea, mode);
      if (
        resolveDesktopPetEdgeDock(logicalPosition, displayArea) === edgeDock &&
        reanchoredBounds.x === bounds.x &&
        reanchoredBounds.y === bounds.y
      ) {
        const distance = preferredPosition
          ? Math.hypot(logicalPosition.x - preferredPosition.x, logicalPosition.y - preferredPosition.y)
          : matches.length;
        const edgeScore =
          (boundsTouchLeft && desktopPetEdgeDockIncludes(edgeDock, "left") ? 1 : 0) +
          (boundsTouchRight && desktopPetEdgeDockIncludes(edgeDock, "right") ? 1 : 0);
        matches.push({
          logicalPosition,
          distance,
          edgeScore
        });
      }
    }
    if (matches.length > 0) {
      matches.sort((left, right) => right.edgeScore - left.edgeScore || left.distance - right.distance);
      return matches[0].logicalPosition;
    }
  }
  const footprint = getDesktopPetVisibleFootprintForMode(mode);
  return {
    x: Math.round(bounds.x + footprint.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x),
    y: Math.round(bounds.y + footprint.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y)
  };
}
