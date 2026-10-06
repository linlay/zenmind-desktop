import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type JSZip from "jszip";
import { parseCreationProfile } from "../../../shared/creation-profile";
import { resolveRuntimeRoot } from "./runtime-env-paths";
import type { AppPathReader } from "./runtime-env-contracts";

export async function readCreationProfileUpgradeInput(zip: JSZip): Promise<string | undefined> {
  const entry = zip.file("env/agent-creation.json");
  if (!entry) return undefined;
  const content = await entry.async("string");
  parseCreationProfile(JSON.parse(content));
  return content;
}

export function applyCreationProfileUpgradeInput(app: AppPathReader, content: string | undefined, backupDir: string, platform: NodeJS.Platform = process.platform) {
  if (content !== undefined) parseCreationProfile(JSON.parse(content));
  const target = path.join(resolveRuntimeRoot(app, platform), "agent-creation.json");
  if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error("agent-creation.json must be a regular file");
  fs.mkdirSync(backupDir, {recursive: true});
  const backup = path.join(backupDir, "agent-creation.backup.json");
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify({content: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null}), {flag: "wx"});
  if (content === undefined) { fs.rmSync(target, {force: true}); return; }
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, {flag: "wx"}); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, {force: true}); }
}
