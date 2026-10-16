import { type DesktopActionCallRequest, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { type DesktopActionConfirmationRequest } from "../../../shared/contracts";
import { WebsiteCredentialError } from "../../../shared/website-credentials";
import { getAgentCredentialAccess, type AgentCredentialAccess, type AgentCredentialAccount } from "../credentials";
import { t } from "../../support/i18n/main-i18n";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { fail, ok } from "./action-values";
import { assertActionCanStart } from "./confirmation-dialog";
import { getConfirmationRequestId } from "./confirmation-presentation";

const notStarted = { stage: "arguments", executionState: "not_started" } as const;

type CredentialTarget = Awaited<ReturnType<NonNullable<DesktopActionBridgeOptions["resolveWebSurface"]>>>;

type CredentialPage = {
  access: AgentCredentialAccess;
  target: CredentialTarget;
  origin: string;
  accounts: AgentCredentialAccount[];
};

export type PreparedCredentialFill = {
  access: AgentCredentialAccess;
  target: CredentialTarget;
  origin: string;
  account: AgentCredentialAccount;
  submit: boolean;
};

type Prepared<T> = { ok: true; prepared: T } | { ok: false; response: DesktopActionCallResponse };

// Maps vault and Surface errors to a response; null leaves an unexpected error to the caller.
function credentialFailure(action: string, error: unknown): DesktopActionCallResponse | null {
  if (error instanceof WebsiteCredentialError) {
    return fail(action, "credentials_unavailable", "The saved-password vault cannot be opened on this device.", { ...notStarted, reason: error.code });
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  if (!code) return null;
  return fail(action, code, error instanceof Error ? error.message : String(error), notStarted);
}

/**
 * desktop.credentials.*: saved website passwords for a trusted Run, on the exact page it
 * is authorized to control. The agent names a Surface, never a site; Main reads the
 * page's real origin. Results carry masked account names and a status, never a password.
 */
async function resolveCredentialPage(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<Prepared<CredentialPage>> {
  const action = request.action;
  const reject = (response: DesktopActionCallResponse) => ({ ok: false as const, response });
  const args = request.args ?? {};
  const allowed = action === "desktop.credentials.fill" ? ["surfaceId", "accountId", "submit"] : ["surfaceId"];
  const unknown = Object.keys(args).find(key => !allowed.includes(key));
  if (unknown) return reject(fail(action, "invalid_args", `${unknown} is not accepted.`, notStarted));
  const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
  if (!surfaceId) return reject(fail(action, "invalid_args", "surfaceId is required.", notStarted));
  if (args.accountId !== undefined && (typeof args.accountId !== "string" || !args.accountId.trim())) {
    return reject(fail(action, "invalid_args", "accountId must be a value returned by the account list of this page.", notStarted));
  }
  if (args.submit !== undefined && typeof args.submit !== "boolean") return reject(fail(action, "invalid_args", "submit must be a boolean.", notStarted));

  const access = options.agentCredentials ?? getAgentCredentialAccess();
  if (!access || !options.resolveWebSurface) return reject(fail(action, "credentials_unavailable", "Saved passwords are unavailable.", notStarted));

  try {
    const target = await options.resolveWebSurface({ method: "Surface.getState", surfaceId, ...(request.source ? { source: request.source } : {}) });
    await target.validate();
    const origin = access.pageOrigin(target.contents);
    if (!origin) return reject(fail(action, "page_not_eligible", "Saved passwords are used only on HTTPS pages.", notStarted));
    return { ok: true, prepared: { access, target, origin, accounts: access.list(origin) } };
  } catch (error) {
    // Nothing has been filled yet, so an unexpected error still reports not_started.
    return reject(credentialFailure(action, error) ??
      fail(action, "action_failed", error instanceof Error ? error.message : String(error), notStarted));
  }
}

export async function listCredentialAccounts(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<DesktopActionCallResponse> {
  const page = await resolveCredentialPage(options, request);
  if (!page.ok) return page.response;
  return ok(request.action, { origin: page.prepared.origin, accounts: page.prepared.accounts });
}

// Resolves the real site and account before the confirmation, so the user approves what will be filled.
export async function prepareCredentialFill(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<Prepared<PreparedCredentialFill>> {
  const action = request.action;
  const page = await resolveCredentialPage(options, request);
  if (!page.ok) return page;
  const { access, target, origin, accounts } = page.prepared;
  const args = request.args ?? {};
  const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";
  // Without a choice the site default is used; an id from another site matches nothing here.
  const account = accountId ? accounts.find(item => item.accountId === accountId) : accounts[0];
  if (!account) {
    return {
      ok: false,
      response: fail(action, accountId ? "account_not_found" : "no_saved_account",
        accountId ? "That account is not available on this page. List the accounts of this page again." : "No saved password is available to agents for this page. The user must log in.",
        { ...notStarted, origin })
    };
  }
  return { ok: true, prepared: { access, target, origin, account, submit: args.submit !== false } };
}

export function buildCredentialFillConfirmationRequest(
  request: DesktopActionCallRequest,
  prepared: PreparedCredentialFill
): DesktopActionConfirmationRequest {
  return {
    requestId: getConfirmationRequestId(request),
    title: t("desktopAction.credentialFillTitle"),
    summary: t("desktopAction.credentialFillSummary", { origin: prepared.origin }),
    description: t(prepared.submit ? "desktopAction.credentialFillSubmitDescription" : "desktopAction.credentialFillDescription"),
    fields: [
      { label: t("desktopAction.credentialFillFieldSite"), value: prepared.origin },
      { label: t("desktopAction.credentialFillFieldAccount"), value: prepared.account.username }
    ],
    details: t("desktopAction.credentialFillDetail"),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.credentialFillConfirm"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

export async function fillPreparedCredential(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  prepared: PreparedCredentialFill
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const { access, target, origin, account, submit } = prepared;
  try {
    // The page may have moved while the confirmation was open.
    await target.validate();
    const result = await access.fill(target, {
      origin, accountId: account.accountId, submit,
      // The fill may wait behind other commands on this page: re-check the Run and the page right before writing.
      authorize: async () => { assertActionCanStart(options); await target.validate(); }
    });
    switch (result.status) {
      case "filled":
      case "submitted":
      case "username_only":
        return ok(action, { origin, account: account.username, ...result });
      case "no_login_form":
        return fail(action, "no_login_form", {
          several_password_fields: "The page shows several password fields, which is not a login form.",
          signup_or_reset: "The page creates an account or sets a new password. Saved passwords are only filled into login forms.",
          no_password_field: "The page shows no login form."
        }[result.reason], { ...notStarted, origin, reason: result.reason });
      case "account_unavailable":
        return fail(action, "account_not_found", "That account is no longer available to agents.", { ...notStarted, origin });
      case "page_changed":
        return fail(action, "page_changed", "The page left the site before the password could be filled. Nothing was submitted.", { stage: "execution", executionState: "not_started", origin });
    }
  } catch (error) {
    const response = credentialFailure(action, error);
    if (!response) throw error;
    return response;
  }
}
