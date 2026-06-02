import type { Agent } from "./types";

export function toText(value: unknown): string {
  return String(value ?? "").trim();
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function textListFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => toText(item)).filter(Boolean)
    : [];
}

export function stringifyJson(value: unknown, fallback = ""): string {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return JSON.stringify(value, null, 2);
}

export function compactPayload<T extends Record<string, unknown>>(payload: T): T {
  const next = { ...payload };
  for (const key of Object.keys(next)) {
    if (next[key] === "" || next[key] === undefined) {
      delete next[key];
    }
  }
  return next;
}

export function buildAgentOrderSearchText(agent: Agent): string {
  return [agent.key, agent.name, agent.role, agent.description, ...(Array.isArray(agent.wonders) ? agent.wonders : [])]
    .map((item) => toText(item).toLowerCase())
    .join(" ");
}

export function filterAgentsPreservingOrder(agents: Agent[], query: string): Agent[] {
  const normalizedQuery = toText(query).toLowerCase();
  const normalizedAgents = Array.isArray(agents) ? agents : [];
  if (!normalizedQuery) {
    return normalizedAgents;
  }
  return normalizedAgents.filter((agent) => buildAgentOrderSearchText(agent).includes(normalizedQuery));
}

export function moveAgentForDrop(agents: Agent[], sourceKey: string, targetKey: string): Agent[] {
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    return agents;
  }
  const sourceIndex = agents.findIndex((agent) => toText(agent.key) === sourceKey);
  const targetIndex = agents.findIndex((agent) => toText(agent.key) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) {
    return agents;
  }
  const next = agents.slice();
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export function agentOrderPayload(agents: Agent[]): string[] {
  return (Array.isArray(agents) ? agents : []).map((agent) => toText(agent.key)).filter(Boolean);
}
