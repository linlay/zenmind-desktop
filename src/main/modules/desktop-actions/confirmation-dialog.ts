import { type DesktopActionBridgeOptions } from "./action-contracts";
import { type DesktopActionConfirmationRequest, type DesktopActionConfirmationDecision, type DesktopActionConfirmationEndReason } from "../../../shared/contracts";
import { type BrowserWindow } from "electron";
import { normalizeConfirmationDecision } from "./confirmation-presentation";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { actionError } from "./action-values";
import { t } from "../../support/i18n/main-i18n";

export class ConfirmationEndedError extends Error {
  constructor(readonly reason: DesktopActionConfirmationEndReason | "deadline") { super(reason); }
  toActionError() {
    const code = { timeout: "confirmation_timeout", aborted: "request_aborted", unavailable: "confirmation_unavailable", deadline: "request_timeout" }[this.reason];
    const messages = {
      timeout: "desktopAction.confirmationTimeout",
      aborted: "desktopAction.requestAborted",
      unavailable: "desktopAction.confirmationUnavailable",
      deadline: "desktopAction.requestTimeout"
    } as const;
    const key = messages[this.reason];
    return actionError(code, t(key), {
      stage: "confirmation", executionState: "not_started",
      recovery: { strategy: "user_action", message: t("desktopAction.confirmationRetry") }
    });
  }
}

export function assertActionCanStart(options: DesktopActionBridgeOptions) {
  if (options.actionSignal?.aborted) throw new ConfirmationEndedError("aborted");
  if (options.actionDeadlineAt !== undefined && Date.now() >= options.actionDeadlineAt) throw new ConfirmationEndedError("deadline");
}

export async function requestDesktopActionConfirmation(
  options: DesktopActionBridgeOptions,
  payload: DesktopActionConfirmationRequest,
  _owner: BrowserWindow | null
): Promise<DesktopActionConfirmationDecision> {
  assertActionCanStart(options);
  const timeoutMs = readDesktopProfileFromRoot(getDesktopConfigRoot(options.app)).general.desktopActionConfirmationTimeoutSeconds * 1000;
  if (options.confirmRendererAction) {
    const response = await options.confirmRendererAction(payload, { signal: options.actionSignal, timeoutMs, deadlineAt: options.actionDeadlineAt })
      .catch(() => { throw new ConfirmationEndedError(options.actionSignal?.aborted ? "aborted" : "unavailable"); });
    if (response.reason) throw new ConfirmationEndedError(response.reason);
    if (response.requestId !== payload.requestId || !payload.buttons.some(button => button.decision === response.decision)) throw new ConfirmationEndedError("unavailable");
    assertActionCanStart(options);
    return normalizeConfirmationDecision(response.decision, payload.cancelDecision);
  }

  // Both Windows and macOS use the trusted renderer queue. Native message boxes
  // cannot provide the same countdown/queue lifecycle (parentless macOS boxes
  // are synchronous), so an unavailable renderer must fail closed.
  throw new ConfirmationEndedError("unavailable");
}
