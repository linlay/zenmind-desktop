import { normalizeMarketApiBaseUrl } from "../marketplace";

export function validateMarketSettings(input: Record<string, unknown>) {
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    return {
      valid: false,
      issues: [{
        field: "enabled",
        message: "market.enabled must be boolean"
      }]
    };
  }
  try {
    const settings = saveMarketSettingsPreview(input, {
      enabled: false,
      apiBaseUrl: ""
    });
    return {
      valid: true,
      issues: [],
      normalized: settings
    };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        field: "apiBaseUrl",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

export function saveMarketSettingsPreview(
  input: Record<string, unknown>,
  current: { enabled: boolean; apiBaseUrl: string }
) {
  const hasApiBaseUrlPatch = "apiBaseUrl" in input;
  const rawMarketUrl = typeof input.apiBaseUrl === "string" ? input.apiBaseUrl.trim() : "";
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    throw new Error("market.enabled must be boolean");
  }
  if ("apiBaseUrl" in input && typeof input.apiBaseUrl !== "string") {
    throw new Error("market.apiBaseUrl must be string");
  }
  const requestedEnabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const apiBaseUrl = normalizeMarketApiBaseUrl(hasApiBaseUrlPatch ? rawMarketUrl : current.apiBaseUrl);
  return {
    enabled: requestedEnabled && Boolean(apiBaseUrl),
    apiBaseUrl
  };
}
