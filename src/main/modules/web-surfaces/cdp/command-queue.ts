const pending = new Map<number, Promise<void>>();

/** Shared by raw and composed commands so other input cannot split a click. */
export async function withCdpCommandQueue<T>(guestId: number, execute: () => Promise<T>): Promise<T> {
  const previous = pending.get(guestId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(execute);
  const barrier = current.then(() => undefined, () => undefined);
  pending.set(guestId, barrier);
  try { return await current; }
  finally { if (pending.get(guestId) === barrier) pending.delete(guestId); }
}
