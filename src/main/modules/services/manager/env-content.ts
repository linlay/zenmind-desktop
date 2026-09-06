import fs from "node:fs";
import path from "node:path";

function formatEnvValue(value: string) {
  if (value === "") {
    return "";
  }
  // Only quote multiline values; PowerShell launchers read ordinary paths and
  // values more reliably when they stay unescaped.
  if (/[\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, '\\"')}"`;
  }
  return value;
}

export function upsertEnvFileContent(
  content: string,
  updates: Map<string, string>,
  options: { uncommentExisting?: boolean } = {}
) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const pending = new Map(updates);
  const applied = new Set<string>();
  const nextLines = lines.flatMap((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      return [line];
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (options.uncommentExisting && trimmed.startsWith("#")) {
        const uncommented = trimmed.slice(1).trimStart();
        const uncommentedSeparatorIndex = uncommented.indexOf("=");
        if (uncommentedSeparatorIndex > 0) {
          const key = uncommented.slice(0, uncommentedSeparatorIndex).trim();
          if (!applied.has(key) && pending.has(key)) {
            const value = pending.get(key) ?? "";
            pending.delete(key);
            applied.add(key);
            return [`${key}=${formatEnvValue(value)}`];
          }
        }
      }
      return [line];
    }

    const key = line.slice(0, separatorIndex).trim();
    if (applied.has(key)) {
      return [];
    }
    if (!pending.has(key)) {
      return [line];
    }

    const value = pending.get(key) ?? "";
    pending.delete(key);
    applied.add(key);
    return [`${key}=${formatEnvValue(value)}`];
  });

  if (pending.size > 0 && nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== "") {
    nextLines.push("");
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${nextLines.join("\n")}\n`;
}

export function writeEnvFileUpdates(
  filePath: string,
  updates: Map<string, string>,
  options: { uncommentExisting?: boolean } = {}
) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, upsertEnvFileContent(current, updates, options), "utf8");
}
