import { type DesktopActionCallRequest, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { WebsiteCredentialError } from "../../../shared/website-credentials";
import { getAgentCredentialAccess } from "../credentials";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { t } from "../../support/i18n/main-i18n";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { readRequestPermissionMode } from "./action-permissions";
import { actionError, fail, ok } from "./action-values";
import { assertActionCanStart, requestDesktopActionConfirmation } from "./confirmation-dialog";
import { getConfirmationRequestId } from "./confirmation-presentation";

const notStarted = { stage: "arguments", executionState: "not_started" } as const;

/**
 * desktop.credentials.*: saved website passwords for a trusted Run, on the exact page it
 * is authorized to control. The agent names a Surface, never a site; Main reads the
 * page's real origin. Results carry masked account names and a status, never a password.
 */
export async function executeCredentialAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const args = request.args ?? {};
  const allowed = action === "desktop.credentials.fill" ? ["surfaceId", "accountId", "submit"] : ["surfaceId"];
  const unknown = Object.keys(args).find(key => !allowed.includes(key));
  if (unknown) return fail(action, "invalid_args", `${unknown} is not accepted.`, notStarted);
  const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
  if (!surfaceId) return fail(action, "invalid_args", "surfaceId is required.", notStarted);
  if (args.accountId !== undefined && (typeof args.accountId !== "string" || !args.accountId.trim())) {
    return fail(action, "invalid_args", "accountId must be a value returned by the account list of this page.", notStarted);
  }
  if (args.submit !== undefined && typeof args.submit !== "boolean") return fail(action, "invalid_args", "submit must be a boolean.", notStarted);

  const access = options.agentCredentials ?? getAgentCredentialAccess();
  if (!access || !options.resolveWebSurface) return fail(action, "credentials_unavailable", "Saved passwords are unavailable.", notStarted);

  try {
    const target = await options.resolveWebSurface({ method: "Surface.getState", surfaceId, ...(request.source ? { source: request.source } : {}) });
    await target.validate();
    const origin = access.pageOrigin(target.contents);
    if (!origin) return fail(action, "page_not_eligible", "Saved passwords are used only on HTTPS pages.", notStarted);
    const accounts = access.list(origin);
    if (action === "desktop.credentials.list") return ok(action, { origin, accounts });

    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";
    // Without a choice the site default is used; an id from another site matches nothing here.
    const account = accountId ? accounts.find(item => item.accountId === accountId) : accounts[0];
    if (!account) {
      return fail(action, accountId ? "account_not_found" : "no_saved_account",
        accountId ? "That account is not available on this page. List the accounts of this page again." : "No saved password is available to agents for this page. The user must log in.",
        { ...notStarted, origin });
    }
    const submit = args.submit !== false;

    const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(options.app)).general;
    if (profile.desktopActionConfirmationEnabled && readRequestPermissionMode(request, args) !== "full_access") {
      const decision = await requestDesktopActionConfirmation(options, {
        requestId: getConfirmationRequestId(request),
        kind: "action",
        title: t("desktopAction.credentialFillTitle"),
        summary: t("desktopAction.credentialFillSummary", { origin }),
        description: t(submit ? "desktopAction.credentialFillSubmitDescription" : "desktopAction.credentialFillDescription"),
        fields: [
          { label: t("desktopAction.credentialFillFieldSite"), value: origin },
          { label: t("desktopAction.credentialFillFieldAccount"), value: account.username }
        ],
        details: t("desktopAction.credentialFillDetail"),
        buttons: [
          { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
          { decision: "confirm", label: t("desktopAction.credentialFillConfirm"), variant: "primary" }
        ],
        defaultDecision: "confirm",
        cancelDecision: "cancel"
      }, options.getMainWindow());
      if (decision !== "confirm") {
        return { ok: false, action, requiresConfirmation: true, error: actionError("user_cancelled", t("desktopAction.userCancelled"), {
          stage: "confirmation", executionState: "not_started", recovery: { strategy: "user_action", message: t("desktopAction.confirmationRetry") } }) };
      }
      assertActionCanStart(options);
      // The user approved one site; the page may have moved while the prompt was open.
      await target.validate();
    }

    const result = await access.fill(target, { origin, accountId: account.accountId, submit });
    switch (result.status) {
      case "filled":
      case "submitted":
      case "username_only":
        return ok(action, { origin, account: account.username, ...result });
      case "no_login_form":
        return fail(action, "no_login_form", result.reason === "several_password_fields"
          ? "The page shows several password fields, which is not a login form."
          : "The page shows no login form.", { ...notStarted, origin });
      case "account_unavailable":
        return fail(action, "account_not_found", "That account is no longer available to agents.", { ...notStarted, origin });
      case "page_changed":
        return fail(action, "page_changed", "The page left the site before the password could be filled. Nothing was submitted.", { stage: "execution", executionState: "not_started", origin });
    }
  } catch (error) {
    if (error instanceof WebsiteCredentialError) {
      return fail(action, "credentials_unavailable", "The saved-password vault cannot be opened on this device.", { ...notStarted, reason: error.code });
    }
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
    if (!code) throw error;
    return fail(action, code, error instanceof Error ? error.message : String(error), notStarted);
  }
}
