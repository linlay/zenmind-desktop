import { type DesktopActionBridgeOptions } from "./action-contracts";
import { fail, ok, readString } from "./action-values";
import {
  type DesktopPetStateResult,
  type DesktopPetListResult,
  type DesktopPetVisibilityResult,
  type DesktopPetSetResult
} from "../../../shared/desktop-actions";
import { t } from "../../support/i18n/main-i18n";

export async function executePetAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const desktopPet = options.desktopPet;
  if (!desktopPet) {
    return fail(action, "pet_action_unavailable", "Desktop pet action is unavailable.");
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
