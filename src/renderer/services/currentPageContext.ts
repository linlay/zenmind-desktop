import type {
  AssistantPageContext,
  DesktopPageContextSnapshot,
  DesktopPageKind
} from "../../shared/contracts";

export type CurrentPageContextSnapshotInput = {
  route: string;
  pageKey: string;
  pageKind: DesktopPageKind;
  pageContext: AssistantPageContext | null;
  surfaceId?: string;
  surfaceLabel?: string;
  surfaceRoute?: string;
  embedPath?: string;
  webContentsId?: number;
};

export type CurrentPageContextListener = (
  snapshot: DesktopPageContextSnapshot | null
) => void;

let currentSnapshot: DesktopPageContextSnapshot | null = null;
const listeners = new Set<CurrentPageContextListener>();

function normalizeOptionalString(value: string | undefined) {
  const next = String(value || "").trim();
  return next || undefined;
}

function normalizeOptionalNumber(value: number | undefined) {
  return Number.isFinite(value) ? value : undefined;
}

function notifyListeners() {
  for (const listener of listeners) {
    listener(currentSnapshot);
  }
}

export function buildCurrentPageContextSnapshot(
  input: CurrentPageContextSnapshotInput
): DesktopPageContextSnapshot {
  return {
    route: input.route,
    pageKey: input.pageKey,
    pageKind: input.pageKind,
    ...(normalizeOptionalString(input.surfaceId) ? { surfaceId: normalizeOptionalString(input.surfaceId) } : {}),
    ...(normalizeOptionalString(input.surfaceLabel) ? { surfaceLabel: normalizeOptionalString(input.surfaceLabel) } : {}),
    ...(normalizeOptionalString(input.surfaceRoute) ? { surfaceRoute: normalizeOptionalString(input.surfaceRoute) } : {}),
    ...(normalizeOptionalString(input.embedPath) ? { embedPath: normalizeOptionalString(input.embedPath) } : {}),
    ...(normalizeOptionalNumber(input.webContentsId) !== undefined
      ? { webContentsId: normalizeOptionalNumber(input.webContentsId) }
      : {}),
    pageContext: input.pageContext
  };
}

export function publishCurrentPageContextSnapshot(
  input: CurrentPageContextSnapshotInput
) {
  if (currentSnapshot?.pageKey === input.pageKey) {
    return currentSnapshot;
  }
  currentSnapshot = buildCurrentPageContextSnapshot(input);
  void window.electronAPI.currentPage.publishSnapshot(currentSnapshot).catch(() => undefined);
  notifyListeners();
  return currentSnapshot;
}

export function clearCurrentPageContextSnapshot(pageKey?: string) {
  if (pageKey && currentSnapshot?.pageKey !== pageKey) {
    return;
  }
  if (!currentSnapshot) {
    return;
  }
  currentSnapshot = null;
  void window.electronAPI.currentPage.publishSnapshot(null).catch(() => undefined);
  notifyListeners();
}

export function getCurrentPageContextSnapshot() {
  return currentSnapshot;
}

export function subscribeCurrentPageContext(listener: CurrentPageContextListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
