import type { AssistantProjectCreationOptions, AssistantProjectCreationOptionsResult } from "../../../shared/contracts";
import type { SupportedLocale } from "../../../shared/i18n";

const OPTIONS_TTL_MS = 30_000;

export function createProjectCreationOptionsCache(
  load: () => Promise<AssistantProjectCreationOptionsResult>,
  now = Date.now,
) {
  let revision = 0;
  const listeners = new Set<() => void>();
  let options: AssistantProjectCreationOptions | null = null;
  let loadedAt = 0;
  let pending: Promise<AssistantProjectCreationOptionsResult> | null = null;
  return {
    peek: () => options,
    invalidate() {
      revision++;
      options = null;
      pending = null;
      listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load(force = false): Promise<AssistantProjectCreationOptionsResult> {
      if (pending) return pending;
      if (!force && options && now() - loadedAt < OPTIONS_TTL_MS) {
        return Promise.resolve({ ok: true, message: "", options });
      }
      const version = revision;
      pending = Promise.resolve().then(load).then((result) => {
        if (version !== revision) return { ok: false, message: "Engine directory changed" };
        if (result.ok && result.options) {
          options = result.options;
          loadedAt = now();
        }
        return result;
      }).finally(() => { if (version === revision) pending = null; });
      return pending;
    },
  };
}

type OptionsApi = Pick<Window["electronAPI"]["assistant"], "getProjectCreationOptions" | "onNavigationPushEvent">;
type OptionsCache = ReturnType<typeof createProjectCreationOptionsCache>;
const caches = new WeakMap<OptionsApi, Map<SupportedLocale, OptionsCache>>();

// Share successful options across dialog mounts, never across API contexts or locales.
export function projectCreationOptionsCache(locale: SupportedLocale, api = window.electronAPI.assistant) {
  let localized = caches.get(api);
  if (!localized) {
    localized = new Map();
    caches.set(api, localized);
  }
  let cache = localized.get(locale);
  if (!cache) {
    cache = createProjectCreationOptionsCache(() => api.getProjectCreationOptions());
    localized.set(locale, cache);
    api.onNavigationPushEvent?.(event => { if (event.type === "agent_engines.changed") cache!.invalidate(); });
  }
  return cache;
}
