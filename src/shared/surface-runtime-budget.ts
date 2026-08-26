export const SURFACE_RUNTIME_MAX_INACTIVE_GUESTS = 6;
export const SURFACE_RUNTIME_INACTIVE_TTL_MS = 5 * 60 * 1000;
export const SURFACE_RUNTIME_SWEEP_INTERVAL_MS = 30 * 1000;
export const SURFACE_RUNTIME_DOWNLOAD_STATE_CHANNEL = "surfaceRuntime.downloadState";

export const AGENT_MANAGEMENT_RUNTIME_KEY = "agent-webclient:management";
export const BUILTIN_BROWSER_RUNTIME_KEY = "builtin-browser";

export function createServiceSurfaceRuntimeKey(serviceId: string) {
  return `service:${serviceId}`;
}

export function createWebSurfaceRuntimeKey(entryKey: string) {
  return `web:${entryKey}`;
}

export type SurfaceRuntimeBudgetCandidate = {
  key: string;
  active: boolean;
  protectedFromSleep?: boolean;
};

export type SurfaceRuntimeDownloadState = {
  downloadId: string;
  webContentsId: number;
  active: boolean;
};

export type SurfaceRuntimeBudgetEntry = {
  key: string;
  active: boolean;
  protectedFromSleep: boolean;
  lastActiveAt: number;
  inactiveSince: number | null;
  lastTouchedSequence: number;
};

export type SurfaceRuntimeBudgetState = {
  entries: Record<string, SurfaceRuntimeBudgetEntry>;
  sequence: number;
};

export type SurfaceRuntimeBudgetOptions = {
  maxInactiveGuests?: number;
  inactiveTtlMs?: number;
};

export function createSurfaceRuntimeBudgetState(): SurfaceRuntimeBudgetState {
  return { entries: {}, sequence: 0 };
}

function normalizeLimit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0
    ? Math.floor(Number(value))
    : fallback;
}

export function reconcileSurfaceRuntimeBudget(
  previous: SurfaceRuntimeBudgetState,
  candidates: readonly SurfaceRuntimeBudgetCandidate[],
  now: number,
  options: SurfaceRuntimeBudgetOptions = {},
) {
  const maxInactiveGuests = normalizeLimit(
    options.maxInactiveGuests,
    SURFACE_RUNTIME_MAX_INACTIVE_GUESTS,
  );
  const inactiveTtlMs = normalizeLimit(
    options.inactiveTtlMs,
    SURFACE_RUNTIME_INACTIVE_TTL_MS,
  );
  const uniqueCandidates = new Map<string, SurfaceRuntimeBudgetCandidate>();
  for (const candidate of candidates) {
    const key = candidate.key.trim();
    if (!key) continue;
    uniqueCandidates.set(key, { ...candidate, key });
  }

  let sequence = previous.sequence;
  const entries: Record<string, SurfaceRuntimeBudgetEntry> = {};
  for (const candidate of uniqueCandidates.values()) {
    const existing = previous.entries[candidate.key];
    const active = candidate.active === true;
    if (active) sequence += 1;
    entries[candidate.key] = {
      key: candidate.key,
      active,
      protectedFromSleep: candidate.protectedFromSleep === true,
      lastActiveAt: active ? now : existing?.lastActiveAt ?? now,
      inactiveSince: active
        ? null
        : existing?.active === false
          ? existing.inactiveSince ?? now
          : now,
      lastTouchedSequence: active
        ? sequence
        : existing?.lastTouchedSequence ?? sequence,
    };
  }

  const eligibleInactive = Object.values(entries)
    .filter((entry) => !entry.active && !entry.protectedFromSleep)
    .sort((left, right) =>
      left.lastActiveAt - right.lastActiveAt ||
      left.lastTouchedSequence - right.lastTouchedSequence ||
      left.key.localeCompare(right.key)
    );
  const sleepKeys = new Set<string>();
  for (const entry of eligibleInactive) {
    if (
      entry.inactiveSince !== null &&
      now - entry.inactiveSince >= inactiveTtlMs
    ) {
      sleepKeys.add(entry.key);
    }
  }

  let retainedInactiveCount = eligibleInactive.length - sleepKeys.size;
  for (const entry of eligibleInactive) {
    if (retainedInactiveCount <= maxInactiveGuests) break;
    if (sleepKeys.has(entry.key)) continue;
    sleepKeys.add(entry.key);
    retainedInactiveCount -= 1;
  }
  for (const key of sleepKeys) {
    delete entries[key];
  }

  return {
    state: { entries, sequence } satisfies SurfaceRuntimeBudgetState,
    sleepKeys: [...sleepKeys],
  };
}
