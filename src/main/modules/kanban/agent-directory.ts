import type { App } from "electron";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import type {
  DesktopPetAgentOption
} from "../../../shared/contracts";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";
import { isRecord, readText } from "./protocol-values";

export const ASSISTANT_AGENT_LIST_TIMEOUT_MS = 2_000;

export function readInstalledAgentOptions(app: App): DesktopPetAgentOption[] {
  const agentsRoot = path.join(resolveRuntimeRoot(app), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: DesktopPetAgentOption[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const agentFile = ["agent.yml", "agent.yaml"]
      .map((fileName) => path.join(agentsRoot, entry.name, fileName))
      .find((filePath) => fs.existsSync(filePath));
    if (!agentFile) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(agentFile, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const agentKey = readText(parsed.key) || entry.name.trim();
    if (!agentKey) {
      continue;
    }
    agents.push({
      agentKey,
      displayName: readText(parsed.name) || agentKey,
      role: readText(parsed.role),
      unreadCount: 0
    });
  }
  return normalizeDesktopPetAgentOptions(agents);
}

export function normalizeDesktopPetAgentOptions(agents: DesktopPetAgentOption[]) {
  const seen = new Set<string>();
  const result: DesktopPetAgentOption[] = [];
  for (const agent of agents) {
    const agentKey = typeof agent?.agentKey === "string" ? agent.agentKey.trim() : "";
    if (!agentKey || seen.has(agentKey)) {
      continue;
    }
    seen.add(agentKey);
    const displayName = typeof agent.displayName === "string" && agent.displayName.trim() ? agent.displayName.trim() : agentKey;
    const role = typeof agent.role === "string" ? agent.role.trim() : "";
    const unreadCount = Number.isFinite(agent.unreadCount) ? Math.max(0, Math.round(agent.unreadCount)) : 0;
    result.push({
      agentKey,
      displayName,
      role,
      ...(agent.icon ? { icon: agent.icon } : {}),
      unreadCount
    });
  }
  return result;
}
