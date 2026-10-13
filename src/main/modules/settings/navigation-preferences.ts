import type { App } from "electron";
import type { DesktopNavigationPreferences, DesktopNavigationPreferencesInput, DesktopSitePinInput, DesktopSitePinCommandResult } from "../../../shared/contracts/navigation";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { readWebOrderKeys, writeWebOrderKeys, readWebPinnedKeys, writeWebPinnedKeys } from "../webs";
import { readNavigationOrder, writeNavigationOrder } from "./navigation-order-store";

type NavigationState = { signature: string; revision: number; notify?: (value: DesktopNavigationPreferences) => void };
const states = new Map<string, NavigationState>();

export class NavigationPreferencesError extends Error {
  constructor(readonly code: string, message: string,
    readonly executionState: "not_started" | "rolled_back" | "unknown" = "not_started",
    readonly field?: string) {
    super(message);
  }
}

export function readNavigationPreferences(app: App, platform: NodeJS.Platform = process.platform): DesktopNavigationPreferences {
  const root = getDesktopConfigRoot(app, platform);
  const profile = readDesktopProfileFromRoot(root);
  const value = {
    mainOrder: readNavigationOrder(app, platform),
    webOrder: readWebOrderKeys(app, [], platform),
    pinnedWebEntryKeys: readWebPinnedKeys(app, platform),
    desktopCopilotPages: profile.navigation.desktopCopilotPages,
  };
  const signature = JSON.stringify(value);
  let state = states.get(root);
  if (!state) {
    state = { signature, revision: 1 };
    states.set(root, state);
  } else if (state.signature !== signature) {
    state.signature = signature;
    state.revision++;
  }
  return { ...value, revision: state.revision };
}

export function setNavigationPreferencesChangedListener(app: App,
  notify: ((value: DesktopNavigationPreferences) => void) | undefined,
  platform: NodeJS.Platform = process.platform) {
  const root = getDesktopConfigRoot(app, platform);
  const state = states.get(root) ?? { signature: "", revision: 0 };
  state.notify = notify;
  states.set(root, state);
}

export function saveNavigationPreferences(app: App, input: DesktopNavigationPreferencesInput,
  platform: NodeJS.Platform = process.platform): DesktopNavigationPreferences {
  const before = readNavigationPreferences(app, platform);
  if (input.expectedRevision !== undefined && input.expectedRevision !== before.revision) {
    throw new NavigationPreferencesError("navigation_conflict", "Navigation changed; read the current preferences before saving.");
  }
  // All reads/writes are synchronous: UI and Action calls cannot interleave this commit.
  // Restore already-written files on ordinary write failure; no crash recovery is claimed.
  const committed: Array<() => void> = [];
  try {
    if (Array.isArray(input.mainOrder)) {
      committed.push(() => {
        if (JSON.stringify(readNavigationOrder(app, platform)) !== JSON.stringify(before.mainOrder)) writeNavigationOrder(app, before.mainOrder, platform);
      });
      writeNavigationOrder(app, input.mainOrder, platform);
    }
    if (Array.isArray(input.webOrder)) {
      committed.push(() => {
        if (JSON.stringify(readWebOrderKeys(app, [], platform)) !== JSON.stringify(before.webOrder)) writeWebOrderKeys(app, before.webOrder, platform);
      });
      writeWebOrderKeys(app, input.webOrder, platform);
    }
    if (Array.isArray(input.pinnedWebEntryKeys)) {
      committed.push(() => {
        if (JSON.stringify(readWebPinnedKeys(app, platform)) !== JSON.stringify(before.pinnedWebEntryKeys)) writeWebPinnedKeys(app, before.pinnedWebEntryKeys, platform);
      });
      writeWebPinnedKeys(app, input.pinnedWebEntryKeys, platform);
    }
  } catch (error) {
    let restored = true;
    for (const restore of committed.reverse()) {
      try { restore(); } catch { restored = false; }
    }
    throw new NavigationPreferencesError("navigation_write_failed",
      error instanceof Error ? error.message : "Failed to save navigation preferences.",
      restored ? "rolled_back" : "unknown");
  }
  const after = readNavigationPreferences(app, platform);
  if (after.revision !== before.revision) {
    // A notification failure cannot turn a committed mutation into an unknown result.
    try { states.get(getDesktopConfigRoot(app, platform))?.notify?.(after); }
    catch (error) { console.warn("Failed to notify navigation preference change", error); }
  }
  return after;
}

export function parseSitePinInput(value: unknown): DesktopSitePinInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NavigationPreferencesError("invalid_args", "args must contain entryKey and pinned.", "not_started", "args");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "entryKey" && key !== "pinned")) {
    throw new NavigationPreferencesError("invalid_args", "Only entryKey and pinned are accepted.", "not_started", "args");
  }
  if (typeof input.entryKey !== "string" || !/^(website|webapp):\S+$/u.test(input.entryKey)) {
    throw new NavigationPreferencesError("invalid_args", "entryKey must be an exact Website or WebApp key returned by site.list.", "not_started", "entryKey");
  }
  if (typeof input.pinned !== "boolean") {
    throw new NavigationPreferencesError("invalid_args", "pinned must be a boolean.", "not_started", "pinned");
  }
  return { entryKey: input.entryKey, pinned: input.pinned };
}

export function setWebEntryPinned(app: App, input: DesktopSitePinInput, existingEntryKeys: readonly string[],
  platform: NodeJS.Platform = process.platform): DesktopNavigationPreferences {
  const { entryKey, pinned } = parseSitePinInput(input);
  if (!existingEntryKeys.includes(entryKey)) {
    throw new NavigationPreferencesError("site_not_found", "The website or WebApp entry was not found.");
  }
  const before = readNavigationPreferences(app, platform);
  if (before.pinnedWebEntryKeys.includes(entryKey) === pinned) return before;
  return saveNavigationPreferences(app, {
    expectedRevision: before.revision,
    pinnedWebEntryKeys: pinned
      ? [entryKey, ...before.pinnedWebEntryKeys.filter((key) => key !== entryKey)]
      : before.pinnedWebEntryKeys.filter((key) => key !== entryKey),
    mainOrder: pinned
      ? [entryKey, ...before.mainOrder.filter((key) => key !== entryKey)]
      : before.mainOrder.filter((key) => key !== entryKey),
  }, platform);
}

export function setSitePinned(app: App, value: unknown, existingEntryKeys: readonly string[],
  platform: NodeJS.Platform = process.platform): DesktopSitePinCommandResult {
  try {
    const input = parseSitePinInput(value);
    const preferences = setWebEntryPinned(app, input, existingEntryKeys, platform);
    return { ok: true, result: { entryKey: input.entryKey, pinned: preferences.pinnedWebEntryKeys.includes(input.entryKey) } };
  } catch (error) {
    if (!(error instanceof NavigationPreferencesError)) throw error;
    return { ok: false, error: { code: error.code, message: error.message, executionState: error.executionState,
      ...(error.field ? { field: error.field } : {}) } };
  }
}
