import type { SiteCdpScope } from "./site-scope";

const pending = new Map<number, Promise<void>>();

/** Serialize background commands sharing one host's foreground focus. */
export async function withSiteCdpFocus<T>(scope: SiteCdpScope | undefined,
  control: ((phase: "capture" | "restore") => Promise<unknown>) | undefined,
  execute: () => Promise<T>): Promise<T> {
  if (!scope || !control) return execute();
  const owner = scope.ownerWebContentsId;
  const previous = pending.get(owner) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    scope.readSurface();
    await control("capture");
    try {
      scope.readSurface();
      return await execute();
    } finally {
      await control("restore");
    }
  });
  const barrier = current.then(() => undefined, () => undefined);
  pending.set(owner, barrier);
  try { return await current; }
  finally { if (pending.get(owner) === barrier) pending.delete(owner); }
}
