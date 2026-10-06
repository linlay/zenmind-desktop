import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";
import { applyCreationProfile, parseCreationProfile } from "../../../shared/creation-profile";
import { getMainLocale } from "../../support/i18n/main-i18n";
import type { AssistantProjectCreationOptions } from "../../../shared/contracts";

export async function loadProjectCreationOptions(app: any, call: (app: any, path: string) => Promise<any>): Promise<AssistantProjectCreationOptions> {
  const file = path.join(resolveRuntimeRoot(app), "agent-creation.json");
  let raw: unknown = { version: 1, types: {}, groups: [] };
  try { raw = JSON.parse(await fs.promises.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const profile = parseCreationProfile(raw);
  const [runtime, skills, connectors, tools] = await Promise.all([
    call(app, "/api/admin/agents/creation-defaults"), call(app, "/api/admin/skills"),
    call(app, "/api/admin/connectors"), call(app, "/api/admin/tools"),
  ]);
  return applyCreationProfile(runtime, profile, {
    skills: skills.skills.filter((s: any) => s.status === "ready"), connectors: connectors.connectors, tools,
  }, getMainLocale()) as AssistantProjectCreationOptions;
}
