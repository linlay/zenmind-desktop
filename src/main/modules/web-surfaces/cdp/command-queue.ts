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

export const PAGE_AUTOMATION_HELD_CODE = "credential_fill_in_progress";

export class PageAutomationHeldError extends Error {
  readonly code = PAGE_AUTOMATION_HELD_CODE;
  constructor() {
    super("Desktop is filling a saved password into this page. Page automation is paused until the login is submitted or the user takes over; wait and retry.");
  }
}

const held = new Map<number, symbol>();

/**
 * Pauses CDP and AWCP on one page while Desktop has a saved password in its form, so
 * no tool can read the field. Commands already queued finish first; new ones are refused
 * until the returned release function runs. A page holds one pause at a time: a second
 * fill is refused rather than allowed to end the first one's pause early.
 */
export function holdPageAutomation(guestId: number) {
  assertPageAutomationNotHeld(guestId);
  const token = Symbol("page-automation-hold");
  held.set(guestId, token);
  return () => { if (held.get(guestId) === token) held.delete(guestId); };
}

export function assertPageAutomationNotHeld(guestId: number) {
  if (held.has(guestId)) throw new PageAutomationHeldError();
}

export function isPageAutomationHeld(guestId: number) {
  return held.has(guestId);
}
