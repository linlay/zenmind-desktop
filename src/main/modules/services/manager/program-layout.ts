import fs from "node:fs";
import path from "node:path";

export function fixShellScriptPermissions(rootDir: string) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.name.endsWith(".sh")) {
        fs.chmodSync(entryPath, 0o755);
      }
    }
  }
}
