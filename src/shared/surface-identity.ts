export const SURFACE_ROLES = [
  "main-chat",
  "copilot-chat",
  "kanban-chat",
  "browser",
  "website",
  "webapp",
  "copilot-dock",
  "overview",
  "debug",
  "btw",
  "source",
  "project",
  "file-diff",
  "artifact",
  "reference",
  "file",
  "planning",
  "agent",
  "copilot",
  "skill",
  "workpanel-web",
  "service",
  "history",
  "help",
  "plugin-settings",
] as const;

export type SurfaceRole = typeof SURFACE_ROLES[number];
export type SurfaceLevel = "root" | "child" | "utility";
export type SurfaceInteraction = "interactive" | "read-only" | "none";

export type SurfaceIdentity = {
  surfaceId: string;
  surfaceRole: SurfaceRole;
  surfaceLevel: SurfaceLevel;
  parentSurfaceId?: string;
  ownerChatId?: string;
  interaction: SurfaceInteraction;
};

export const MAIN_CHAT_SURFACE_ID = "main-chat";
export const COPILOT_CHAT_SURFACE_ID = "copilot-chat";
export const KANBAN_CHAT_SURFACE_ID = "kanban-chat";
export const COPILOT_DOCK_SURFACE_ID = "copilot-dock";
export const BROWSER_SURFACE_ID = "browser";
export const HISTORY_SURFACE_ID = "history";
export const HELP_SURFACE_ID = "help";

export const LEGACY_FIXED_SURFACE_ID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "agent-webclient-chat": MAIN_CHAT_SURFACE_ID,
  "agent-webclient-copilot": COPILOT_CHAT_SURFACE_ID,
  "agent-webclient-kanban-chat": KANBAN_CHAT_SURFACE_ID,
  "agent-webclient-copilot-dock": COPILOT_DOCK_SURFACE_ID,
  chrome: BROWSER_SURFACE_ID,
  "desktop-help": HELP_SURFACE_ID,
});

const FIXED_ROLE_IDS: Partial<Record<SurfaceRole, string>> = {
  "main-chat": MAIN_CHAT_SURFACE_ID,
  "copilot-chat": COPILOT_CHAT_SURFACE_ID,
  "kanban-chat": KANBAN_CHAT_SURFACE_ID,
  "copilot-dock": COPILOT_DOCK_SURFACE_ID,
  browser: BROWSER_SURFACE_ID,
  history: HISTORY_SURFACE_ID,
  help: HELP_SURFACE_ID,
};

const DYNAMIC_ROLE_PREFIXES: Partial<Record<SurfaceRole, string>> = {
  website: "site",
  webapp: "app",
  overview: "ov",
  debug: "dbg",
  btw: "btw",
  source: "src",
  project: "proj",
  "file-diff": "diff",
  artifact: "art",
  reference: "ref",
  file: "file",
  planning: "plan",
  agent: "agt",
  copilot: "cpl",
  skill: "skl",
  "workpanel-web": "web",
  service: "svc",
  "plugin-settings": "ps",
};

const CHILD_ROLES = new Set<SurfaceRole>([
  "copilot-dock",
  "overview",
  "debug",
  "btw",
  "source",
  "project",
  "file-diff",
  "artifact",
  "reference",
  "file",
  "planning",
  "agent",
  "copilot",
  "skill",
  "workpanel-web",
]);

const UTILITY_ROLES = new Set<SurfaceRole>(["service", "history", "help", "plugin-settings"]);
const READ_ONLY_ROLES = new Set<SurfaceRole>([
  "overview", "debug", "source", "artifact", "reference", "file", "planning",
]);

export function stableSurfaceHash(value: string) {
  const normalized = value.trim();
  const alternate = `surface:${normalized}`;
  let first = 0x811c9dc5;
  let second = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    first = Math.imul(first ^ normalized.charCodeAt(index), 0x01000193);
  }
  for (let index = 0; index < alternate.length; index += 1) {
    second = Math.imul(second ^ alternate.charCodeAt(index), 0x01000193);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function legacyStableSurfaceHash(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

export function createSurfaceId(surfaceRole: SurfaceRole, identityKey = "") {
  const fixedId = FIXED_ROLE_IDS[surfaceRole];
  if (fixedId) return fixedId;
  const prefix = DYNAMIC_ROLE_PREFIXES[surfaceRole];
  const normalizedKey = identityKey.trim();
  if (!prefix || !normalizedKey) return "";
  if (surfaceRole === "service") {
    return `${prefix}:${normalizedKey}`;
  }
  return `${prefix}:${stableSurfaceHash(normalizedKey)}`;
}

export function createSurfaceIdentity(
  surfaceRole: SurfaceRole,
  identityKey = "",
  options: { parentSurfaceId?: string; ownerChatId?: string } = {},
): SurfaceIdentity {
  const surfaceId = createSurfaceId(surfaceRole, identityKey);
  const surfaceLevel: SurfaceLevel = UTILITY_ROLES.has(surfaceRole)
    ? "utility"
    : CHILD_ROLES.has(surfaceRole)
      ? "child"
      : "root";
  const interaction: SurfaceInteraction = surfaceRole === "help"
    ? "none"
    : READ_ONLY_ROLES.has(surfaceRole)
      ? "read-only"
      : "interactive";
  const parentSurfaceId = options.parentSurfaceId?.trim() || "";
  const ownerChatId = options.ownerChatId?.trim() || "";
  return {
    surfaceId,
    surfaceRole,
    surfaceLevel,
    ...(parentSurfaceId ? { parentSurfaceId } : {}),
    ...(ownerChatId ? { ownerChatId } : {}),
    interaction,
  };
}

export function createWebEntrySurfaceIdentity(kind: "website" | "webapp", entryKey: string) {
  return createSurfaceIdentity(kind, entryKey);
}

export function createServiceSurfaceIdentity(serviceId: string) {
  return createSurfaceIdentity("service", serviceId);
}

export function createPluginSettingsSurfaceIdentity(pluginId: string) {
  return createSurfaceIdentity("plugin-settings", pluginId);
}

export function createChatChildSurfaceIdentity(
  role: Extract<SurfaceRole,
    "overview" | "debug" | "btw" | "source" | "project" | "file-diff" | "artifact" | "reference" | "file" | "planning" | "agent" | "copilot" | "skill" | "workpanel-web">,
  identityKey: string,
  ownerChatId: string,
  parentSurfaceId: string | undefined = MAIN_CHAT_SURFACE_ID,
) {
  return createSurfaceIdentity(role, identityKey, { ownerChatId, parentSurfaceId });
}

export function resolveLegacyFixedSurfaceId(value: string) {
  const normalized = value.trim();
  return LEGACY_FIXED_SURFACE_ID_ALIASES[normalized] ?? normalized;
}

export function createLegacySurfaceIdAliases(
  surfaceRole: SurfaceRole,
  identityKey = "",
) {
  const normalizedKey = identityKey.trim();
  const aliases = Object.entries(LEGACY_FIXED_SURFACE_ID_ALIASES)
    .filter(([, canonical]) => canonical === createSurfaceId(surfaceRole, normalizedKey))
    .map(([legacy]) => legacy);
  if (!normalizedKey) return aliases;
  if (surfaceRole === "website" || surfaceRole === "webapp" || surfaceRole === "service") {
    aliases.push(normalizedKey);
  }
  if (surfaceRole === "plugin-settings") {
    aliases.push(`plugin-settings:${normalizedKey}`);
  }
  if (surfaceRole === "project") {
    aliases.push(`agent-webclient-project:${encodeURIComponent(normalizedKey)}`);
  }
  if (CHILD_ROLES.has(surfaceRole) && surfaceRole !== "copilot-dock") {
    const legacyItemId = `item:${legacyStableSurfaceHash(normalizedKey)}`;
    aliases.push(
      surfaceRole === "workpanel-web"
        ? `workpanel-web:${legacyStableSurfaceHash(legacyItemId)}`
        : `workpanel-${legacyItemId}`,
    );
  }
  return [...new Set(aliases.filter(Boolean))];
}

export function isSurfaceRole(value: unknown): value is SurfaceRole {
  return typeof value === "string" && (SURFACE_ROLES as readonly string[]).includes(value);
}

export function surfaceIdentityMatchesPolicy(identity: SurfaceIdentity, identityKey = "") {
  if (!isSurfaceRole(identity.surfaceRole)) return false;
  if (FIXED_ROLE_IDS[identity.surfaceRole] && identityKey.trim()) return false;
  const expected = createSurfaceIdentity(identity.surfaceRole, identityKey, {
    parentSurfaceId: identity.parentSurfaceId,
    ownerChatId: identity.ownerChatId,
  });
  return Boolean(
    expected.surfaceId &&
    identity.surfaceId.trim() === expected.surfaceId &&
    identity.surfaceLevel === expected.surfaceLevel &&
    identity.interaction === expected.interaction &&
    (identity.parentSurfaceId?.trim() || "") === (expected.parentSurfaceId || "") &&
    (identity.ownerChatId?.trim() || "") === (expected.ownerChatId || "")
  );
}
