import path from "node:path";
import { type ManifestCommand } from "../../../shared/contracts";

export function normalizeExecutable(entry: string) {
  if (path.isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")) {
    return entry;
  }
  return `./${entry}`;
}

export function resolveCommand(command: ManifestCommand | undefined) {
  if (!command) {
    return null;
  }

  const parts = Array.isArray(command) ? command : [command];
  if (parts.length === 0) {
    return null;
  }

  const [entry, ...args] = parts.map((part) => part.trim()).filter(Boolean);
  if (!entry) {
    return null;
  }

  return [normalizeExecutable(entry), ...args];
}
