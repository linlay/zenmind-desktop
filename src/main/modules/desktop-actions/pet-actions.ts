import { isDesktopPetArchivePath, PetPackageError } from "../pet";
import { type DesktopActionInvocationContext, type DesktopActionBridgeOptions } from "./action-contracts";
import { fail, ok, readString } from "./action-values";
import {
  type DesktopPetStateResult,
  type DesktopPetListResult,
  type DesktopPetVisibilityResult,
  type DesktopPetImportActionResult,
  type DesktopPetSetResult
} from "../../../shared/desktop-actions";
import { t } from "../../support/i18n/main-i18n";

export async function executePetAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, invocation: DesktopActionInvocationContext) {
  const desktopPet = options.desktopPet;
  if (!desktopPet) {
    return fail(action, "pet_action_unavailable", "Desktop pet action is unavailable.");
  }
  if (action === "desktop.pet.import") {
    if (invocation.kind !== "desktop" && invocation.kind !== "agentPlatform") return fail(action, "forbidden", "Pet imports require an authorized Desktop or Agent Platform caller.");
    if (Object.keys(args).some(key => key !== "filePath") || !isDesktopPetArchivePath(args.filePath, options.platform ?? process.platform)) return fail(action, "invalid_args", "filePath must be an absolute local ZIP path on the Desktop host.");
    if (!desktopPet.importPackage) return fail(action, "pet_action_unavailable", "Pet import is unavailable.");
    try {
      const result = await desktopPet.importPackage(args.filePath);
      if (!result.ok) return fail(action, result.error || "storageFailed", "Pet import failed.");
      const appearance = result.state?.appearanceOptions.find(item => item.id === result.importedAppearanceId);
      if (!appearance) return fail(action, "invalid_action_result", "The imported pet is unavailable.");
      return ok(action, { appearanceId: appearance.id, displayName: appearance.displayName } satisfies DesktopPetImportActionResult);
    } catch (error) {
      if (error instanceof PetPackageError) return fail(action, error.code, `Pet package operation failed: ${error.code}.`);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return fail(action, "file_not_found", "The pet ZIP file does not exist on the Desktop host.");
      if (code === "EACCES" || code === "EPERM") return fail(action, "file_access_denied", "Desktop cannot access the pet file or storage.");
      return fail(action, "storageFailed", "Desktop could not read or save the pet package.");
    }
  }
  const state = await desktopPet.refreshState();
  if (action === "desktop.pet.state") {
    return ok(action, {
      supported: state.supported,
      enabled: state.enabled,
      appearanceId: state.appearanceId
    } satisfies DesktopPetStateResult);
  }
  if (action === "desktop.pet.list") {
    return ok(action, {
      appearanceId: state.appearanceId,
      appearances: state.appearanceOptions.map(({ id, displayName, description }) => ({
        id,
        displayName,
        description
      }))
    } satisfies DesktopPetListResult);
  }
  if (action === "desktop.pet.show") {
    if (!state.supported) {
      return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"));
    }
    const nextState = await desktopPet.show();
    if (!nextState.enabled) {
      return fail(action, "pet_enable_failed", "Desktop pet could not be shown.");
    }
    return ok(action, { enabled: nextState.enabled } satisfies DesktopPetVisibilityResult);
  }
  if (action === "desktop.pet.hide") {
    const nextState = await desktopPet.hide();
    return ok(action, { enabled: nextState.enabled } satisfies DesktopPetVisibilityResult);
  }
  if (action !== "desktop.pet.set") {
    return fail(action, "unknown_action", `unknown action: ${action}`);
  }
  const appearanceId = readString(args, "appearanceId") || readString(args, "id");
  if (!appearanceId) {
    return fail(action, "invalid_args", "id or appearanceId is required.");
  }
  if (!state.supported) {
    return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"));
  }
  const appearance = state.appearanceOptions.find((candidate) => candidate.id === appearanceId);
  if (!appearance) {
    return fail(action, "pet_appearance_not_found", t("settings.desktopPet.enableUnavailable"), {
      appearanceId
    });
  }
  const nextState = await desktopPet.saveSettings({ appearanceId });
  return ok(action, { appearanceId: nextState.appearanceId } satisfies DesktopPetSetResult);
}
