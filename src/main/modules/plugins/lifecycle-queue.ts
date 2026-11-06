import type { App } from "electron";

// Local import and market operations share one transaction order per Desktop.
const operations = new WeakMap<App, Promise<unknown>>();
export function serializePluginOperation<T>(app: App, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(app) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  operations.set(app, next);
  void next.finally(() => { if (operations.get(app) === next) operations.delete(app); }).catch(() => undefined);
  return next;
}

