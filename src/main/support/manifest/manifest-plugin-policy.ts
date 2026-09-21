import { NormalizeManifestOptions } from "./manifest-types";
import { t } from "../i18n/main-i18n";

export function isPluginManifestInput(raw: Record<string, unknown>, options: NormalizeManifestOptions) {
  return options.defaultKind !== "builtin";
}

export function assertNoPluginManifestLegacyFields(raw: Record<string, unknown>, options: NormalizeManifestOptions) {
  if (!isPluginManifestInput(raw, options)) {
    return;
  }

  const legacyFields: Record<string, string> = {
    kind: t("manifest.legacy.kind"),
    scripts: t("manifest.legacy.scripts"),
    frontend: t("manifest.legacy.frontend"),
    web: t("manifest.legacy.web")
  };

  for (const [field, message] of Object.entries(legacyFields)) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      throw new Error(`plugin manifest field "${field}" is not supported. ${message}`);
    }
  }
}
