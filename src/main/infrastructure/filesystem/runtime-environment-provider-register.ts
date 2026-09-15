import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type JSZip from "jszip";
import { resolveRuntimeRoot, type AppPathReader } from "./runtime-environment.part-1";

// This is Desktop's registration policy, not a service-owned Provider config.
export async function readProviderRegisterUpgradeInput(zip: JSZip): Promise<string | undefined> {
  const entry = zip.file("env/provider-register.json");
  if (!entry) return undefined;
  const content = await entry.async("string");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // JSON parser errors can include the one-time grant. Never surface them.
    throw new Error("provider-register.json must contain a valid JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider-register.json must contain a valid JSON object.");
  }
  return content;
}

function writePrivateFile(file: string, content: string, platform: NodeJS.Platform) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    // Windows uses the enclosing user directory ACL; POSIX needs explicit mode.
    if (platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function applyProviderRegisterUpgradeInput(
  app: AppPathReader,
  content: string | undefined,
  backupDir: string,
  platform: NodeJS.Platform = process.platform
) {
  const target = path.join(resolveRuntimeRoot(app, platform), "provider-register.json");
  if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) {
    throw new Error("provider-register.json must be a regular file.");
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, "provider-register.backup.json");
  if (!fs.existsSync(backup)) {
    writePrivateFile(backup, JSON.stringify({
      content: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null
    }), platform);
  }
  if (content === undefined) {
    // The new package may intentionally disable automatic registration.
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writePrivateFile(target, content, platform);
}
