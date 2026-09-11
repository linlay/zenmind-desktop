import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  getDesktopPetsDataRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebsitesDataRoot,
  getDesktopWebsConfigRoot,
  getPluginsRoot
} from "../infrastructure/filesystem/user-paths";

export type ResourceDirectoryDomain = "webs" | "pets" | "plugins";

type Watcher = {
  close: () => void;
};

type DirentLike = {
  name: string;
  isDirectory: () => boolean;
};

type ResourceWatcherFs = {
  existsSync: (targetPath: string) => boolean;
  mkdirSync: (targetPath: string, options: { recursive: true }) => unknown;
  readdirSync: (targetPath: string, options: { withFileTypes: true }) => DirentLike[];
  statSync: (targetPath: string) => { isDirectory: () => boolean };
  watch: (
    targetPath: string,
    options: { persistent: boolean },
    listener: (eventType: string, filename: string | Buffer | null) => void
  ) => Watcher;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type WatchDefinition = {
  domain: ResourceDirectoryDomain;
  root: string;
  maxDepth: number;
  ignoreDirectory?: (name: string) => boolean;
};

type DomainState = {
  watchers: Map<string, Watcher>;
  timer: TimerHandle | null;
};

export type ResourceDirectoryWatcherOptions = {
  app: App;
  platform?: NodeJS.Platform;
  debounceMs?: number;
  fsImpl?: ResourceWatcherFs;
  setTimeoutImpl?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
  onChanged?: (domain: ResourceDirectoryDomain) => unknown;
  onWebsChanged?: () => unknown;
  onPetsChanged?: () => unknown;
  onPluginsChanged?: () => unknown;
  onError?: (message: string, error: unknown) => void;
};

export type ResourceDirectoryWatcher = {
  start: () => void;
  stop: () => void;
  refresh: (domain?: ResourceDirectoryDomain) => void;
};

function createWatchDefinitions(app: App): WatchDefinition[] {
  return [
    { domain: "webs", root: getDesktopWebsitesDataRoot(app), maxDepth: 1 },
    { domain: "webs", root: getDesktopWebappsDataRoot(app), maxDepth: 1 },
    { domain: "webs", root: getDesktopWebsConfigRoot(app), maxDepth: 0 },
    { domain: "pets", root: getDesktopPetsDataRoot(app), maxDepth: 1 },
    {
      domain: "plugins",
      root: getPluginsRoot(app),
      maxDepth: 2,
      ignoreDirectory: (name) => name.startsWith(".")
    }
  ];
}

function isDirectory(fsImpl: ResourceWatcherFs, targetPath: string) {
  try {
    return fsImpl.existsSync(targetPath) && fsImpl.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function listWatchDirectories(fsImpl: ResourceWatcherFs, definition: WatchDefinition) {
  const output: string[] = [];

  function visit(targetPath: string, remainingDepth: number) {
    if (!isDirectory(fsImpl, targetPath)) {
      return;
    }
    output.push(targetPath);
    if (remainingDepth <= 0) {
      return;
    }

    let entries: DirentLike[] = [];
    try {
      entries = fsImpl.readdirSync(targetPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || definition.ignoreDirectory?.(entry.name)) {
        continue;
      }
      visit(path.join(targetPath, entry.name), remainingDepth - 1);
    }
  }

  try {
    fsImpl.mkdirSync(definition.root, { recursive: true });
  } catch {
    return output;
  }
  visit(definition.root, definition.maxDepth);
  return output;
}

function watchDirectory(
  fsImpl: ResourceWatcherFs,
  platform: NodeJS.Platform,
  targetPath: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) {
  if (platform === "win32") {
    return fsImpl.watch(targetPath, { persistent: false }, listener);
  }
  if (platform === "darwin") {
    return fsImpl.watch(targetPath, { persistent: false }, listener);
  }
  return fsImpl.watch(targetPath, { persistent: false }, listener);
}

export function createResourceDirectoryWatcher(options: ResourceDirectoryWatcherOptions): ResourceDirectoryWatcher {
  const platform = options.platform ?? process.platform;
  const debounceMs = options.debounceMs ?? 250;
  const fsImpl = options.fsImpl ?? (fs as unknown as ResourceWatcherFs);
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const definitions = createWatchDefinitions(options.app);
  const states = new Map<ResourceDirectoryDomain, DomainState>([
    ["webs", { watchers: new Map(), timer: null }],
    ["pets", { watchers: new Map(), timer: null }],
    ["plugins", { watchers: new Map(), timer: null }]
  ]);
  let stopped = true;

  function reportError(message: string, error: unknown) {
    if (options.onError) {
      options.onError(message, error);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[main] ${message}: ${detail}`);
  }

  function domainDefinitions(domain: ResourceDirectoryDomain) {
    return definitions.filter((definition) => definition.domain === domain);
  }

  function refreshDomainWatchers(domain: ResourceDirectoryDomain) {
    const state = states.get(domain);
    if (!state || stopped) {
      return;
    }

    const desired = new Set<string>();
    for (const definition of domainDefinitions(domain)) {
      for (const directoryPath of listWatchDirectories(fsImpl, definition)) {
        desired.add(directoryPath);
      }
    }

    for (const [directoryPath, watcher] of state.watchers) {
      if (desired.has(directoryPath)) {
        continue;
      }
      watcher.close();
      state.watchers.delete(directoryPath);
    }

    for (const directoryPath of desired) {
      if (state.watchers.has(directoryPath)) {
        continue;
      }
      try {
        const watcher = watchDirectory(fsImpl, platform, directoryPath, () => {
          scheduleDomain(domain);
        });
        state.watchers.set(directoryPath, watcher);
      } catch (error) {
        reportError(`failed to watch resource directory ${directoryPath}`, error);
      }
    }
  }

  function dispatchDomain(domain: ResourceDirectoryDomain) {
    try {
      options.onChanged?.(domain);
      if (domain === "webs") {
        options.onWebsChanged?.();
      } else if (domain === "pets") {
        options.onPetsChanged?.();
      } else if (domain === "plugins") {
        options.onPluginsChanged?.();
      }
    } catch (error) {
      reportError(`failed to handle ${domain} resource change`, error);
    }
  }

  function scheduleDomain(domain: ResourceDirectoryDomain) {
    const state = states.get(domain);
    if (!state || stopped) {
      return;
    }
    if (state.timer) {
      clearTimeoutImpl(state.timer);
    }
    state.timer = setTimeoutImpl(() => {
      state.timer = null;
      refreshDomainWatchers(domain);
      dispatchDomain(domain);
    }, debounceMs);
  }

  function refresh(domain?: ResourceDirectoryDomain) {
    if (domain) {
      refreshDomainWatchers(domain);
      return;
    }
    refreshDomainWatchers("webs");
    refreshDomainWatchers("pets");
    refreshDomainWatchers("plugins");
  }

  function start() {
    if (!stopped) {
      return;
    }
    stopped = false;
    refresh();
  }

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const state of states.values()) {
      if (state.timer) {
        clearTimeoutImpl(state.timer);
        state.timer = null;
      }
      for (const watcher of state.watchers.values()) {
        watcher.close();
      }
      state.watchers.clear();
    }
  }

  return { start, stop, refresh };
}

export const __testInternals = {
  createWatchDefinitions,
  listWatchDirectories
};
