import { z } from "zod";

export const WEBAPP_MANIFEST_VERSION = 2 as const;
export const WEBAPP_MANIFEST_MAX_BYTES = 256 * 1024;
export const WEBAPP_APP_CONFIG_MAX_BYTES = 128 * 1024;
export const WEBAPP_USER_CONFIG_MAX_BYTES = 64 * 1024;
export const WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS = 12_000;

export const WEBAPP_ID_PATTERN = /^webapp-[a-f0-9]{16}$/u;
export const WEBAPP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const WEBAPP_AGENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const MINIMUM_RUNTIME_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/u;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const USER_CONFIG_FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/u;
const RESERVED_ENV_KEYS = new Set([
  "HOST",
  "PORT",
  "WEBAPP_ID",
  "WEBAPP_ROOT",
  "WEBAPP_DATA_DIR",
  "WEBAPP_STATE_DIR",
  "WEBAPP_LOG_DIR",
  "WEBAPP_MANIFEST_PATH",
  "WEBAPP_USER_CONFIG_PATH",
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

export type WebappUserConfigValue = string | number | boolean;
export type WebappUserConfigValues = Record<string, WebappUserConfigValue>;

function jsonBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeJsonKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/-/gu, "_")
    .toLowerCase();
}

function findUnsafeJsonKey(value: WebappJsonValue, path: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = findUnsafeJsonKey(value[index]!, [...path, String(index)]);
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
    if (DANGEROUS_JSON_KEYS.has(key) || SECRET_LIKE_KEY_PATTERN.test(normalizeJsonKey(key))) {
      return nextPath.join(".");
    }
    const issue = findUnsafeJsonKey(child, nextPath);
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
    const unsafePath = findUnsafeJsonKey(value);
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

const backendPrefixSchema = z.string().min(1).max(128).superRefine((value, context) => {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    value === "/__desktop" ||
    value.startsWith("/__desktop/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be an absolute URL prefix without a trailing slash, query, fragment, or /__desktop path."
    });
  }
});

const environmentSchema = z.record(
  z.string().regex(ENV_KEY_PATTERN),
  z.string().max(8_192)
).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (RESERVED_ENV_KEYS.has(key) || key.startsWith("DESKTOP_") || key.startsWith("WEBAPP_")) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is reserved by Desktop.`
      });
    }
  }
});

const userConfigFieldBase = {
  name: z.string().regex(USER_CONFIG_FIELD_NAME_PATTERN),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240).optional(),
  required: z.boolean().default(false)
};

const textUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("text"),
  default: z.string().max(4_096).optional(),
  placeholder: z.string().max(160).optional(),
  maxLength: z.number().int().min(1).max(4_096).default(1_024)
}).superRefine((value, context) => {
  if (value.default !== undefined && value.default.length > value.maxLength) {
    context.addIssue({
      code: "custom",
      path: ["default"],
      message: "default must not exceed maxLength."
    });
  }
});

const textareaUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("textarea"),
  default: z.string().max(12_000).optional(),
  placeholder: z.string().max(160).optional(),
  maxLength: z.number().int().min(1).max(12_000).default(8_000),
  rows: z.number().int().min(2).max(12).default(4)
}).superRefine((value, context) => {
  if (value.default !== undefined && value.default.length > value.maxLength) {
    context.addIssue({
      code: "custom",
      path: ["default"],
      message: "default must not exceed maxLength."
    });
  }
});

const numberUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("number"),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().default(1)
}).superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: "custom", path: ["min"], message: "min must not exceed max." });
  }
  if (value.default !== undefined && value.min !== undefined && value.default < value.min) {
    context.addIssue({ code: "custom", path: ["default"], message: "default must be at least min." });
  }
  if (value.default !== undefined && value.max !== undefined && value.default > value.max) {
    context.addIssue({ code: "custom", path: ["default"], message: "default must not exceed max." });
  }
});

const booleanUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("boolean"),
  default: z.boolean().default(false)
});

const selectOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  value: z.string().min(1).max(256)
});

const staticSelectUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("select"),
  options: z.array(selectOptionSchema).min(1).max(100),
  default: z.string().min(1).max(256).optional()
}).superRefine((value, context) => {
  const optionValues = new Set<string>();
  value.options.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: "custom",
        path: ["options", index, "value"],
        message: "select option values must be unique."
      });
    }
    optionValues.add(option.value);
  });
  if (value.default !== undefined && !optionValues.has(value.default)) {
    context.addIssue({
      code: "custom",
      path: ["default"],
      message: "default must match one select option value."
    });
  }
});

const dynamicSelectUserConfigFieldSchema = z.strictObject({
  ...userConfigFieldBase,
  type: z.literal("select"),
  source: z.literal("desktop.agents"),
  default: z.string().regex(WEBAPP_AGENT_KEY_PATTERN).optional()
});

export const webappUserConfigFieldSchema = z.union([
  textUserConfigFieldSchema,
  textareaUserConfigFieldSchema,
  numberUserConfigFieldSchema,
  booleanUserConfigFieldSchema,
  staticSelectUserConfigFieldSchema,
  dynamicSelectUserConfigFieldSchema
]);

export const webappUserConfigSchema = z.strictObject({
  fields: z.array(webappUserConfigFieldSchema).max(64)
}).superRefine((value, context) => {
  const names = new Set<string>();
  value.fields.forEach((field, index) => {
    if (names.has(field.name)) {
      context.addIssue({
        code: "custom",
        path: ["fields", index, "name"],
        message: "userConfig field names must be unique."
      });
    }
    names.add(field.name);
    if (DANGEROUS_JSON_KEYS.has(field.name) || SECRET_LIKE_KEY_PATTERN.test(normalizeJsonKey(field.name))) {
      context.addIssue({
        code: "custom",
        path: ["fields", index, "name"],
        message: "userConfig field names must not be reserved or secret-like."
      });
    }
  });
  if (jsonBytes(value) > WEBAPP_USER_CONFIG_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `userConfig must not exceed ${WEBAPP_USER_CONFIG_MAX_BYTES} bytes.`
    });
  }
});

const httpHealthSchema = z.strictObject({
  type: z.literal("http"),
  path: z.string().min(1).max(256).regex(/^\/(?!\/)/u),
  startupTimeoutMs: z.number().int().min(1_000).max(120_000).default(10_000)
});

const tcpHealthSchema = z.strictObject({
  type: z.literal("tcp"),
  startupTimeoutMs: z.number().int().min(1_000).max(120_000).default(10_000)
});

const backendCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("electron-node"),
    entry: safeRelativePathSchema
  }),
  z.strictObject({
    type: z.literal("executable"),
    entry: safeRelativePathSchema
  }),
  z.strictObject({
    type: z.literal("runtime"),
    runtime: z.enum(["python", "java"]),
    minimumVersion: z.string().regex(MINIMUM_RUNTIME_VERSION_PATTERN).optional(),
    entry: safeRelativePathSchema
  })
]);

export const webappBackendSchema = z.strictObject({
  command: backendCommandSchema,
  args: z.array(z.string().max(4_096)).max(128).default([]),
  env: environmentSchema.default({}),
  health: z.discriminatedUnion("type", [httpHealthSchema, tcpHealthSchema]),
  shutdownTimeoutMs: z.number().int().min(1_000).max(30_000).default(3_000)
});

const webappManifestV2Schema = z.strictObject({
  schemaVersion: z.literal(WEBAPP_MANIFEST_VERSION),
  id: z.string().regex(WEBAPP_ID_PATTERN),
  key: z.string().min(3).max(64).regex(WEBAPP_KEY_PATTERN),
  label: z.string().trim().min(1).max(80),
  version: z.string().regex(SEMVER_PATTERN),
  target: z.enum([
    "any",
    "darwin-arm64",
    "darwin-x64",
    "darwin-universal",
    "win32-arm64",
    "win32-x64"
  ]),
  appConfig: webappAppConfigSchema.default({}),
  userConfig: webappUserConfigSchema.optional(),
  frontend: z.strictObject({
    root: safeRelativePathSchema,
    index: safeRelativePathSchema,
    routeConfig: z.strictObject({
      backendPrefixes: z.array(backendPrefixSchema).max(16).default([]),
      navigationFallback: safeRelativePathSchema.optional()
    }).default({ backendPrefixes: [] })
  }),
  backend: webappBackendSchema.optional(),
  desktopBridge: z.strictObject({
    version: z.literal(1)
  }).default({ version: 1 })
}).superRefine((value, context) => {
  if (jsonBytes(value) > WEBAPP_MANIFEST_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `webapp.json must not exceed ${WEBAPP_MANIFEST_MAX_BYTES} bytes.`
    });
  }
  if (value.frontend.routeConfig.backendPrefixes.length > 0 && !value.backend) {
    context.addIssue({
      code: "custom",
      path: ["frontend", "routeConfig", "backendPrefixes"],
      message: "backendPrefixes require a backend."
    });
  }
  const prefixes = new Set<string>();
  value.frontend.routeConfig.backendPrefixes.forEach((prefix, index) => {
    if (prefixes.has(prefix)) {
      context.addIssue({
        code: "custom",
        path: ["frontend", "routeConfig", "backendPrefixes", index],
        message: "backendPrefixes must be unique."
      });
    }
    prefixes.add(prefix);
  });
  if (value.backend?.command.type === "executable" && value.target === "any") {
    context.addIssue({
      code: "custom",
      path: ["target"],
      message: "executable backends require an explicit platform target."
    });
  }
  if (value.backend?.command.type === "runtime") {
    const extension = value.backend.command.entry.split(".").pop()?.toLowerCase() ?? "";
    const expected = value.backend.command.runtime === "python" ? "py" : "jar";
    if (extension !== expected) {
      context.addIssue({
        code: "custom",
        path: ["backend", "command", "entry"],
        message: `${value.backend.command.runtime} runtime entry must use .${expected}.`
      });
    }
  }
});

export const webappManifestSchema = webappManifestV2Schema;

export type WebappManifest = z.infer<typeof webappManifestSchema>;
export type WebappBackendConfig = WebappManifest["backend"];
export type WebappFrontendConfig = WebappManifest["frontend"];
export type WebappDesktopBridgeConfig = WebappManifest["desktopBridge"];
export type WebappUserConfig = NonNullable<WebappManifest["userConfig"]>;
export type WebappUserConfigField = WebappUserConfig["fields"][number];

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

export function parseWebappManifest(value: unknown): WebappManifest {
  const result = webappManifestSchema.safeParse(value);
  if (!result.success) {
    throw new WebappManifestValidationError(result.error.issues);
  }
  return result.data;
}

export function safeParseWebappManifest(value: unknown) {
  return webappManifestSchema.safeParse(value);
}

export function createWebappManifestJsonSchema() {
  return z.toJSONSchema(webappManifestV2Schema, {
    target: "draft-2020-12",
    unrepresentable: "any"
  });
}
