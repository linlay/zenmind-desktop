import { type ManifestDesktopDisabledResponse } from "../../../shared/contracts";

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function asOptionalString(value: unknown) {
  const next = asString(value).trim();
  return next ? next : undefined;
}

export function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringRecord(value: unknown) {
  const record = asObject(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

export function normalizeRoutePath(value: unknown) {
  const pathValue = asOptionalString(value);
  if (!pathValue) {
    return "";
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

export function cloneDisabledResponse(
  response: ManifestDesktopDisabledResponse | undefined
): ManifestDesktopDisabledResponse | undefined {
  if (!response) {
    return undefined;
  }
  return {
    ...(response.status === undefined ? {} : { status: response.status }),
    ...(response.json === undefined ? {} : { json: response.json }),
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(response.contentType === undefined ? {} : { contentType: response.contentType })
  };
}
