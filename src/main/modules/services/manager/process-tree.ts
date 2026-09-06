export type ProcessTreeRow = {
  pid: number;
  ppid: number;
};

export function parseProcessTreeRowsFromPs(stdout: string): ProcessTreeRow[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidText, ppidText] = line.split(/\s+/u);
      const pid = Number.parseInt(pidText ?? "", 10);
      const ppid = Number.parseInt(ppidText ?? "", 10);
      return { pid, ppid };
    })
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0 && Number.isFinite(row.ppid) && row.ppid >= 0);
}

export function parseProcessTreeRowsFromWindowsPowerShell(stdout: string): ProcessTreeRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const pid = typeof item.ProcessId === "number" ? item.ProcessId : Number.parseInt(String(item.ProcessId ?? ""), 10);
        const ppid =
          typeof item.ParentProcessId === "number"
            ? item.ParentProcessId
            : Number.parseInt(String(item.ParentProcessId ?? ""), 10);
        return { pid, ppid };
      })
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0 && Number.isFinite(row.ppid) && row.ppid >= 0);
  } catch {
    return [];
  }
}

export function buildProcessTreePids(rootPid: number, rows: ProcessTreeRow[]) {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const visited = new Set<number>();
  const ordered: number[] = [];
  const visit = (pid: number) => {
    if (visited.has(pid)) {
      return;
    }
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
    ordered.push(pid);
  };

  visit(rootPid);
  return ordered;
}
