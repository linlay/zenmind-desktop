import type { DesktopPetWindowMode } from "../../../shared/contracts";

export const DESKTOP_PET_WINDOW_SIZE = {
  width: 176,
  height: 198
} as const;

export const DESKTOP_PET_VISIBLE_FOOTPRINT = {
  x: 40,
  y: 52,
  width: 96,
  height: 108
} as const;

export const DESKTOP_PET_PANEL_WINDOW_INSET_PX = 10;

export const DESKTOP_PET_WINDOW_SIZES: Record<DesktopPetWindowMode, { width: number; height: number }> = {
  base: DESKTOP_PET_WINDOW_SIZE,
  bubble: {
    width: 376,
    height: 442
  },
  "preview-collapsed": {
    width: 380,
    height: 276
  },
  "preview-expanded": {
    width: 424,
    height: 412
  },
  "task-list-compact": {
    width: 376,
    height: 352
  },
  "task-list": {
    width: 424,
    height: 432
  }
} as const;

export type DesktopPetVisibleFootprint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS: Record<DesktopPetWindowMode, DesktopPetVisibleFootprint> = {
  base: DESKTOP_PET_VISIBLE_FOOTPRINT,
  bubble: {
    x: 132,
    y: 316,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "preview-collapsed": {
    x: 142,
    y: 142,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "preview-expanded": {
    x: 162,
    y: 294,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "task-list-compact": {
    x: 132,
    y: 228,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "task-list": {
    x: 162,
    y: 308,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  }
} as const;

export const DEFAULT_OFFSET = {
  x: 20,
  y: 78
} as const;

export const DESKTOP_PET_EDGE_STICK_DISTANCE_PX = 1;

export const DESKTOP_PET_EDGE_SNAP_DISTANCE_PX = 1;
