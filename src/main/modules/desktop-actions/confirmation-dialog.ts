import { type DesktopActionBridgeOptions } from "./action-contracts";
import { type DesktopActionConfirmationRequest, type DesktopActionConfirmationDecision } from "../../../shared/contracts";
import { type BrowserWindow, dialog } from "electron";
import { normalizeConfirmationDecision, findConfirmationButtonIndex, buildNativeConfirmationDetail } from "./confirmation-presentation";

export async function requestDesktopActionConfirmation(
  options: DesktopActionBridgeOptions,
  payload: DesktopActionConfirmationRequest,
  owner: BrowserWindow | null
): Promise<DesktopActionConfirmationDecision> {
  if (options.confirmRendererAction && owner && !owner.isDestroyed()) {
    const response = await options.confirmRendererAction(payload);
    return normalizeConfirmationDecision(response.decision, payload.cancelDecision);
  }

  const buttons = payload.buttons.map((button) => button.label);
  const dialogOptions = {
    type: "question" as const,
    buttons,
    defaultId: findConfirmationButtonIndex(payload, payload.defaultDecision),
    cancelId: findConfirmationButtonIndex(payload, payload.cancelDecision),
    title: payload.title,
    message: payload.summary,
    detail: buildNativeConfirmationDetail(payload)
  };
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return payload.buttons[result.response]?.decision ?? payload.cancelDecision;
}
