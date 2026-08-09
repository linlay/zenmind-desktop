import { z } from "zod";

export const WEBAPP_MANIFEST_VERSION = 1 as const;
export const WEBAPP_MANIFEST_MAX_BYTES = 256 * 1024;
export const WEBAPP_APP_CONFIG_MAX_BYTES = 128 * 1024;
export const WEBAPP_ASSISTANT_INSTRUCTION_MAX_CHARS = 8_000;
export const WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS = 12_000;

export const WEBAPP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/u;
export const WEBAPP_AGENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const WEBAPP_SYSTEM_EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENV_KEYS = new Set([
  "HOST",
  "PORT",
  "WEBAPP_ID",
  "WEBAPP_ROOT",
  "WEBAPP_DATA_DIR",
  "WEBAPP_STATE_DIR",
  "WEBAPP_LOG_DIR",
  "WEBAPP_MANIFEST_PATH",
  "DESKTOP_ACTION_BRIDGE_URL",
  "DESKTOP_ACTION_BRIDGE_TOKEN"
]);
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_LIKE_KEY_PATTERN = /(?:^|_)(?:password|passwd|secret|token|access_token|auth_token|bearer_token|refresh_token|api_key|model_key|client_secret|private_key)$/u;

export type WebappJsonValue =
  | null
  | boolean
  | number
  | string
  | WebappJsonValue[]
  | { [key: string]: WebappJsonValue };

function jsonBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function findUnsafeAppConfigKey(value: WebappJsonValue, path: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = findUnsafeAppConfigKey(value[index]!, [...path, String(index)]);
      if (issue) {
        return issue;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/-/gu, "_")
      .toLowerCase();
    if (DANGEROUS_JSON_KEYS.has(key) || SECRET_LIKE_KEY_PATTERN.test(normalizedKey)) {
      return nextPath.join(".");
    }
    const issue = findUnsafeAppConfigKey(child, nextPath);
    if (issue) {
      return issue;
    }
  }
  return null;
}

const webappJsonValueSchema: z.ZodType<WebappJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(webappJsonValueSchema),
  z.record(z.string(), webappJsonValueSchema)
]));

export const webappAppConfigSchema = z.record(z.string(), webappJsonValueSchema)
  .superRefine((value, context) => {
    if (jsonBytes(value) > WEBAPP_APP_CONFIG_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `appConfig must not exceed ${WEBAPP_APP_CONFIG_MAX_BYTES} bytes.`
      });
    }
    const unsafePath = findUnsafeAppConfigKey(value);
    if (unsafePath) {
      context.addIssue({
        code: "custom",
        message: `appConfig contains a reserved or secret-like key: ${unsafePath}.`
      });
    }
  });

const safeRelativePathSchema = z.string().min(1).max(512).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: "custom", message: "must be a safe relative path." });
  }
});

const apiPrefixSchema = z.string().min(1).max(128).superRefine((value, context) => {
  if (
    !value.startsWith("/") ||
    value.length > 1 && value.endsWith("/") ||
    value === "/__desktop" ||
    value.startsWith("/__desktop/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be an absolute URL path without a trailing slash, query, fragment, or /__desktop prefix."
    });
  }
});

const environmentSchema = z.record(
  z.string().regex(ENV_KEY_PATTERN),
  z.string().max(8_192)
).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (RESERVED_ENV_KEYS.has(key) || key.startsWith("DESKTOP_")) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is reserved by Desktop.`
      });
    }
  }
});

const httpHealthSchema = z.strictObject({
  type: z.literal("http"),
  path: z.string().min(1).max(256).regex(/^\/(?!\/)/u),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(10_000)
});

const tcpHealthSchema = z.strictObject({
  type: z.literal("tcp"),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(10_000)
});

const backendCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("electron-node"),
    script: safeRelativePathSchema
  }),
  z.strictObject({
    type: z.literal("bundled"),
    executable: safeRelativePathSchema
  }),
  z.strictObject({
    type: z.literal("system"),
    executable: z.string().regex(WEBAPP_SYSTEM_EXECUTABLE_PATTERN)
  })
]);

export const webappBackendSchema = z.strictObject({
  command: backendCommandSchema.default({
    type: "electron-node",
    script: "backend/server.mjs"
  }),
  args: z.array(z.string().max(4_096)).max(128).default([]),
  env: environmentSchema.default({}),
  health: z.discriminatedUnion("type", [httpHealthSchema, tcpHealthSchema]),
  shutdownTimeoutMs: z.number().int().min(1_000).max(30_000).default(3_000)
});

export const webappAssistantChatCapabilitySchema = z.strictObject({
  agentKey: z.string().regex(WEBAPP_AGENT_KEY_PATTERN).optional(),
  instruction: z.string().trim().min(1).max(WEBAPP_ASSISTANT_INSTRUCTION_MAX_CHARS).optional()
});

const emptyCapabilitySchema = z.strictObject({});

export const webappBridgeCapabilitiesSchema = z.strictObject({
  "assistant.chat": webappAssistantChatCapabilitySchema.optional(),
  "native.browser.external": emptyCapabilitySchema.optional(),
  "native.dialog.files": emptyCapabilitySchema.optional(),
  "native.dialog.directories": emptyCapabilitySchema.optional(),
  "native.dialog.savePath": emptyCapabilitySchema.optional(),
  "native.microphone": emptyCapabilitySchema.optional(),
  "native.clipboard.write": emptyCapabilitySchema.optional(),
  "native.notification": emptyCapabilitySchema.optional()
});

export const webappManifestSchema = z.strictObject({
  schemaVersion: z.literal(WEBAPP_MANIFEST_VERSION),
  id: z.string().regex(WEBAPP_ID_PATTERN),
  label: z.string().trim().min(1).max(80),
  version: z.string().regex(SEMVER_PATTERN),
  target: z.enum(["universal", "darwin-arm64", "darwin-x64", "windows-arm64", "windows-x64"]),
  openMode: z.enum(["workspace", "dialog"]).default("workspace"),
  appConfig: webappAppConfigSchema.default({}),
  frontend: z.strictObject({
    root: safeRelativePathSchema,
    index: safeRelativePathSchema,
    spa: z.boolean().default(true),
    apiPrefix: apiPrefixSchema.default("/api")
  }),
  backend: webappBackendSchema.optional(),
  desktopBridge: z.strictObject({
    version: z.literal(1),
    capabilities: webappBridgeCapabilitiesSchema
  }).optional()
}).superRefine((value, context) => {
  if (jsonBytes(value) > WEBAPP_MANIFEST_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `webapp.json must not exceed ${WEBAPP_MANIFEST_MAX_BYTES} bytes.`
    });
  }
  if (value.backend?.command.type === "bundled" && value.target === "universal") {
    context.addIssue({
      code: "custom",
      path: ["target"],
      message: "bundled backends require an explicit platform target."
    });
  }
});

export type WebappManifestV1 = z.infer<typeof webappManifestSchema>;
export type WebappBackendConfig = WebappManifestV1["backend"];
export type WebappFrontendConfig = WebappManifestV1["frontend"];
export type WebappDesktopBridgeConfig = NonNullable<WebappManifestV1["desktopBridge"]>;
export type WebappManifestCapability = keyof WebappDesktopBridgeConfig["capabilities"];
export type WebappAssistantChatConfig = z.infer<typeof webappAssistantChatCapabilitySchema>;

export class WebappManifestValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super(issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "webapp.json";
      return `${location}: ${issue.message}`;
    }).join("; "));
    this.name = "WebappManifestValidationError";
    this.issues = issues;
  }
}

export function parseWebappManifest(value: unknown): WebappManifestV1 {
  const result = webappManifestSchema.safeParse(value);
  if (!result.success) {
    throw new WebappManifestValidationError(result.error.issues);
  }
  return result.data;
}

export function safeParseWebappManifest(value: unknown) {
  return webappManifestSchema.safeParse(value);
}

export function getWebappAssistantChatConfig(
  manifest: Pick<WebappManifestV1, "desktopBridge">
): WebappAssistantChatConfig | null {
  return manifest.desktopBridge?.capabilities["assistant.chat"] ?? null;
}

export function webappDeclaresCapability(
  manifest: Pick<WebappManifestV1, "desktopBridge">,
  capability: WebappManifestCapability
) {
  return Object.hasOwn(manifest.desktopBridge?.capabilities ?? {}, capability);
}

export function createWebappManifestJsonSchema() {
  return z.toJSONSchema(webappManifestSchema, {
    target: "draft-2020-12",
    unrepresentable: "any"
  });
}
