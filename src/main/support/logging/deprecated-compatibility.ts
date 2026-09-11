export type DeprecatedCompatibilityId =
  | "assistant.createCoderProject"
  | "agent-webclient.bridge-v4"
  | "agent-webclient.bridge-v5"
  | "surface.legacy-alias";

export type DeprecatedCompatibilityDetails = Readonly<{
  method?: string;
  version?: number;
  category?: "fixed" | "derived";
  canonicalRole?: string;
}>;

const reportedCompatibilityUses = new Set<string>();
let currentDesktopVersion = "";

export function setDeprecatedCompatibilityDesktopVersion(version: string) {
  currentDesktopVersion = version.trim();
}

function diagnosticKey(id: DeprecatedCompatibilityId, details: DeprecatedCompatibilityDetails) {
  return [
    id,
    details.version ?? "",
    details.method ?? "",
    details.category ?? "",
    details.canonicalRole ?? ""
  ].join(":");
}

export function reportDeprecatedCompatibilityUse(
  id: DeprecatedCompatibilityId,
  details: DeprecatedCompatibilityDetails = {}
) {
  const key = diagnosticKey(id, details);
  if (reportedCompatibilityUses.has(key)) {
    return false;
  }
  reportedCompatibilityUses.add(key);
  console.warn("[deprecated-compatibility]", {
    id,
    ...(currentDesktopVersion ? { desktopVersion: currentDesktopVersion } : {}),
    ...details
  });
  return true;
}

export const __testInternals = {
  clearReportedCompatibilityUses: () => reportedCompatibilityUses.clear(),
  diagnosticKey,
  resetDesktopVersion: () => { currentDesktopVersion = ""; }
};
