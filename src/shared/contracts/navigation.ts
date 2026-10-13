import type { DesktopCopilotPagePreferences } from "../assistant-settings";

export interface DesktopNavigationPreferences {
  mainOrder: string[];
  webOrder: string[];
  pinnedWebEntryKeys: string[];
  desktopCopilotPages: DesktopCopilotPagePreferences;
  /** Process-local revision for rejecting stale UI saves. */
  revision: number;
}

export interface DesktopNavigationPreferencesInput {
  mainOrder?: string[];
  webOrder?: string[];
  pinnedWebEntryKeys?: string[];
  expectedRevision?: number;
}

export interface DesktopSitePinInput {
  entryKey: string;
  pinned: boolean;
}

export type DesktopSitePinCommandResult =
  | { ok: true; result: DesktopSitePinInput }
  | { ok: false; error: { code: string; message: string; executionState: "not_started" | "rolled_back" | "unknown"; field?: string } };
