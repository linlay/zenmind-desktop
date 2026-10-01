/** A deliberately small Schema subset used by the bundled page-side adapter. */
export type AddonField = {
  type: "string" | "integer" | "boolean" | "array";
  description?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: AddonField;
};
export type AddonAction = {
  action: string;
  title: string;
  description: string;
  path: string;
  method: "GET" | "POST";
  bodyDefaults?: Record<string, unknown>;
  inputSchema: { type: "object"; properties: Record<string, AddonField>; required: string[]; additionalProperties: false };
};
export type AwcpAddonRule = {
  id: string;
  version: string;
  origin: string;
  pathPrefix: string;
  apiBasePath: string;
  site: { name: string; description: string };
  actions: AddonAction[];
};
