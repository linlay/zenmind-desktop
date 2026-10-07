import type { SidebarMode } from "./capabilityNavigation";

export type DesktopNavigationType = "PUSH" | "REPLACE" | "POP";

export type DesktopNavigationEntry = {
  // Router location key: stable for one history entry, restored on back/forward.
  key: string;
  route: string;
  sidebarMode: SidebarMode;
  // Index of this entry in the router history, so records stay aligned even when a navigation was never observed.
  position: number;
};

export type DesktopNavigationLocation = Omit<DesktopNavigationEntry, "position"> & {
  // null when the router history does not expose its index; the position is then derived from the navigation type.
  position: number | null;
};

export type DesktopNavigationTimeline = {
  entries: DesktopNavigationEntry[];
  index: number;
};

export type DesktopNavigationStep = {
  delta: number;
  entry: DesktopNavigationEntry;
};

export function createDesktopNavigationTimeline(location: DesktopNavigationLocation): DesktopNavigationTimeline {
  return { entries: [{ ...location, position: location.position ?? 0 }], index: 0 };
}

export function recordDesktopNavigation(
  timeline: DesktopNavigationTimeline,
  type: DesktopNavigationType,
  location: DesktopNavigationLocation,
): DesktopNavigationTimeline {
  const current = timeline.entries[timeline.index];
  if (!current) {
    return createDesktopNavigationTimeline(location);
  }
  if (current.key === location.key) {
    return timeline;
  }

  if (type === "POP") {
    const targetIndex = timeline.entries.findIndex((item) => item.key === location.key);
    // Router history that was never observed here (for example after a renderer reload) starts a new timeline.
    return targetIndex === -1
      ? createDesktopNavigationTimeline(location)
      : { entries: timeline.entries, index: targetIndex };
  }

  const derivedPosition = type === "REPLACE" ? current.position : current.position + 1;
  const entry: DesktopNavigationEntry = { ...location, position: location.position ?? derivedPosition };

  if (type === "REPLACE" && entry.position <= current.position) {
    // Canonical redirects and one-time parameter cleanup merge into the record at that position.
    const entries = [...timeline.entries.filter((item) => item.position !== entry.position), entry]
      .sort((left, right) => left.position - right.position);
    return { entries, index: entries.indexOf(entry) };
  }

  // A new visit drops the forward branch. A REPLACE that lands ahead of the current record
  // follows a PUSH committed in the same batch, so it is a new visit as well.
  const entries = [
    ...timeline.entries.filter((item) => item.position <= current.position && item.position < entry.position),
    entry,
  ];
  return { entries, index: entries.length - 1 };
}

export function recordDesktopNavigationSidebarMode(
  timeline: DesktopNavigationTimeline,
  key: string,
  sidebarMode: SidebarMode,
): DesktopNavigationTimeline {
  const current = timeline.entries[timeline.index];
  if (!current || current.key !== key || current.sidebarMode === sidebarMode) {
    return timeline;
  }
  const entries = [...timeline.entries];
  entries[timeline.index] = { ...current, sidebarMode };
  return { entries, index: timeline.index };
}

export function findDesktopNavigationEntry(timeline: DesktopNavigationTimeline, key: string) {
  return timeline.entries.find((item) => item.key === key) ?? null;
}

export function resolveDesktopNavigationStep(
  timeline: DesktopNavigationTimeline,
  direction: "back" | "forward",
): DesktopNavigationStep | null {
  const current = timeline.entries[timeline.index];
  if (!current) {
    return null;
  }
  const offset = direction === "back" ? -1 : 1;
  for (let index = timeline.index + offset; index >= 0 && index < timeline.entries.length; index += offset) {
    const entry = timeline.entries[index];
    // Adjacent records of the same route would look like a button that does nothing.
    if (entry && entry.route !== current.route) {
      // Router positions, not record indexes: an unobserved history entry may sit between two records.
      return { delta: entry.position - current.position, entry };
    }
  }
  return null;
}
