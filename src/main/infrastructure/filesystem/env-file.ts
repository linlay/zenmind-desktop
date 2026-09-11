import fs from "node:fs";

export function parseEnvFileContent(content: string) {
  const env = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    env.set(key, value.replace(/^['"]|['"]$/gu, ""));
  }
  return env;
}

export function readEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return new Map<string, string>();
  }
  return parseEnvFileContent(fs.readFileSync(filePath, "utf8"));
}
