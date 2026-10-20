import { z } from "zod";
import {
  webappManifestSchema,
  WebappManifestValidationError,
  type WebappManifest
} from "../../../../shared/webapp-manifest";
import { isInstalledWebappId } from "./identity";

// Existing installations may predate generated IDs. Keep every other manifest
// constraint, including the refinements, identical to package validation.
const installedWebappManifestSchema = webappManifestSchema.safeExtend({
  id: z.string().refine(isInstalledWebappId, "id must be a safe local directory name.")
});

export function parseInstalledWebappManifest(value: unknown): WebappManifest {
  const result = installedWebappManifestSchema.safeParse(value);
  if (!result.success) {
    throw new WebappManifestValidationError(result.error.issues);
  }
  return result.data;
}
