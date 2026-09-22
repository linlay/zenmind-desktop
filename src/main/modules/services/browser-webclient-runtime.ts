import type { AgentWebclientHostRecord } from "./webclient-host-types";
import type { BrowserWebclientState } from "../../../shared/contracts";
import { createBrowserWebclientHost } from "./browser-webclient-host";

type BrowserHost = Awaited<ReturnType<typeof createBrowserWebclientHost>>;
let active: { owner: AgentWebclientHostRecord; host: BrowserHost } | null = null;
let pending: Promise<BrowserHost> | null = null;
let generation = 0;

export function getBrowserWebclientState(): BrowserWebclientState {
  return { running: Boolean(active), url: active?.host.url || "" };
}

export async function ensureBrowserWebclient(record: AgentWebclientHostRecord) {
  if (active?.owner === record) return active.host;
  if (pending) return pending;
  const epoch = generation;
  const task = (async () => {
    const previous = active;
    active = null;
    if (previous) await previous.host.stop();
    const host = await createBrowserWebclientHost(record);
    if (epoch !== generation) { await host.stop(); throw new Error("Browser launch cancelled"); }
    active = { owner: record, host };
    return host;
  })();
  pending = task;
  try { return await task; } finally { if (pending === task) pending = null; }
}

export async function stopBrowserWebclient() {
  generation++;
  const current = active;
  active = null;
  // Invalidate synchronously before awaiting sockets or an in-flight listener startup.
  const closing = current?.host.stop();
  const starting = pending;
  await closing;
  if (starting) await starting.catch(() => undefined);
  return getBrowserWebclientState();
}
