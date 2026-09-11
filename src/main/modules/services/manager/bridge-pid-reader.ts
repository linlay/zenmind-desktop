import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isProcessRunning } from "./process-cleanup";
import { matchProcessInstallDirAsync, type ProcessInstallDirMatch } from "./process-identity";

type Identity = { pid: number; key: string };
async function readIdentity(filename: string, installDir: string): Promise<Identity | null> {
  try {
    const before = await fs.stat(filename);
    const text = (await fs.readFile(filename, "utf8")).trim();
    const after = await fs.stat(filename);
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) return null;
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, key: `${installDir}\0${pid}\0${after.ino}:${after.mtimeMs}:${after.ctimeMs}:${after.size}` };
  } catch { return null; }
}

// Read-only bridge observations must never repair PID files or authorize process termination.
export function createBridgePidReader(deps: {
  readIdentity: typeof readIdentity;
  isRunning: (pid: number) => boolean;
  match: (pid: number, installDir: string) => Promise<ProcessInstallDirMatch>;
  now: () => number;
} = { readIdentity, isRunning: isProcessRunning, match: matchProcessInstallDirAsync, now: () => performance.now() }) {
  type Entry = { key: string; matched: boolean; checkedAt: number; pending?: Promise<boolean> };
  const entries = new Map<string, Entry>();
  return async (paths: string[], installDir: string): Promise<number | null> => {
    for (const filename of paths) {
      const identity = await deps.readIdentity(filename, installDir);
      if (!identity || !deps.isRunning(identity.pid)) { entries.delete(filename); continue; }
      let entry = entries.get(filename);
      if (!entry || entry.key !== identity.key) {
        if (entries.size >= 64) entries.delete(entries.keys().next().value!);
        entry = { key: identity.key, matched: false, checkedAt: -Infinity };
        entries.set(filename, entry);
      }
      const current = entry;
      const age = deps.now() - current.checkedAt;
      if (!current.pending && age >= 1000) {
        current.pending = (async () => {
          const match = await deps.match(identity.pid, installDir);
          const latest = await deps.readIdentity(filename, installDir);
          const valid = entries.get(filename) === current && latest?.key === identity.key && deps.isRunning(identity.pid);
          current.matched = valid && match === "matched";
          current.checkedAt = deps.now();
          return current.matched;
        })().catch(() => { current.matched = false; current.checkedAt = deps.now(); return false; })
          .finally(() => { current.pending = undefined; });
      }
      // Revalidate in the background while a recent positive observation is usable.
      // Cold/expired/failed identities wait asynchronously and fail closed.
      if (!(current.matched && age < 10000)) await current.pending;
      const latest = await deps.readIdentity(filename, installDir);
      if (entries.get(filename) === current && current.matched &&
          latest?.key === identity.key && deps.isRunning(identity.pid)) return identity.pid;
    }
    return null;
  };
}

export const readBridgeManagedPid = createBridgePidReader();
