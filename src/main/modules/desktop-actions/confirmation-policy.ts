import { type DesktopActionCallRequest, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { type DesktopActionConfirmationRequest, type DesktopPageContextSnapshot } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { readRequestPermissionMode } from "./action-permissions";
import {
  getConfirmationRequestId,
  compactConfirmationValue,
  sanitizeConfirmationUrlText,
  summarizeConfirmationArgs,
  buildDesktopActionConfirmationDetail,
  describeDesktopActionSnapshotTarget
} from "./confirmation-presentation";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { requestDesktopActionConfirmation } from "./confirmation-dialog";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { actionError } from "./action-values";

export function buildActionConfirmationRequest(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null
): DesktopActionConfirmationRequest {
  const action = request.action;
  const summary = t("desktopAction.confirmSummary", { action });
  const permissionMode = readRequestPermissionMode(request);
  const target = describeDesktopActionSnapshotTarget(snapshot);
  const argsSummary = summarizeConfirmationArgs(args);
  return {
    requestId: getConfirmationRequestId(request),
    title: t("desktopAction.confirmActionTitle"),
    summary,
    description: t("desktopAction.confirmActionDetail"),
    fields: [
      { label: t("desktopAction.confirmFieldAction"), value: action || "unknown" },
      { label: t("desktopAction.confirmFieldTarget"), value: compactConfirmationValue(sanitizeConfirmationUrlText(target)) },
      { label: t("desktopAction.confirmFieldPermission"), value: permissionMode },
      { label: t("desktopAction.confirmFieldArgs"), value: compactConfirmationValue(argsSummary) }
    ],
    details: buildDesktopActionConfirmationDetail(request, args, {
      permissionMode,
      target
    }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.confirmExecute"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

// Asks the user once when the confirmation switch is on and the request did not grant full_access.
// The caller decides whether the action and entry need confirmation at all.
export async function confirmDesktopActionIfNeeded(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  buildConfirmation: () => DesktopActionConfirmationRequest
): Promise<DesktopActionCallResponse | null> {
  const { general } = readDesktopProfileFromRoot(getDesktopConfigRoot(options.app));
  if (!general.desktopActionConfirmationEnabled || general.desktopActionConfirmationExemptActions.includes(request.action)) {
    return null;
  }
  if (readRequestPermissionMode(request) === "full_access") {
    return null;
  }
  const decision = await requestDesktopActionConfirmation(options, buildConfirmation(), options.getMainWindow());
  if (decision === "confirm") {
    return null;
  }
  return {
    ok: false,
    action: request.action,
    requiresConfirmation: true,
    error: actionError("user_cancelled", t("desktopAction.userCancelled"), { stage: "confirmation", executionState: "not_started", recovery: { strategy: "user_action", message: t("desktopAction.confirmationRetry") } })
  };
}
