import type { BrowserWindow } from "electron";
import type {
  DesktopActionConfirmationRequest,
  DesktopActionConfirmationResponse,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse
} from "../shared/contracts/copilot";
import { t } from "./i18n/main-i18n";

const DESKTOP_ACTION_RENDERER_TIMEOUT_MS = 8_000;
const DESKTOP_ACTION_CONFIRMATION_TIMEOUT_MS = 60_000;

type PendingDesktopActionRendererRequest = {
  resolve: (response: DesktopActionRendererResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingDesktopActionConfirmationRequest = {
  resolve: (response: DesktopActionConfirmationResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function callDesktopActionRenderer(
  request: DesktopActionRendererRequest,
  options: {
    getMainWindow: () => BrowserWindow | null;
    pendingRequests: Map<string, PendingDesktopActionRendererRequest>;
    timeoutMs?: number;
  }
): Promise<DesktopActionRendererResponse> {
  const targetWindow = options.getMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return Promise.resolve({
      requestId: request.requestId,
      action: request.action,
      ok: false,
      error: {
        code: "renderer_unavailable",
        message: t("desktopAction.mainWindowUnavailable")
      }
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      options.pendingRequests.delete(request.requestId);
      resolve({
        requestId: request.requestId,
        action: request.action,
        ok: false,
        error: {
          code: "renderer_timeout",
          message: t("desktopAction.rendererTimeout")
        }
      });
    }, options.timeoutMs ?? DESKTOP_ACTION_RENDERER_TIMEOUT_MS);

    options.pendingRequests.set(request.requestId, { resolve, timeout });
    targetWindow.webContents.send("desktopActions.call", request);
  });
}

export function callDesktopActionConfirmation(
  request: DesktopActionConfirmationRequest,
  options: {
    getMainWindow: () => BrowserWindow | null;
    pendingRequests: Map<string, PendingDesktopActionConfirmationRequest>;
    timeoutMs?: number;
  }
): Promise<DesktopActionConfirmationResponse> {
  const targetWindow = options.getMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return Promise.resolve({
      requestId: request.requestId,
      decision: "cancel"
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      options.pendingRequests.delete(request.requestId);
      resolve({
        requestId: request.requestId,
        decision: "cancel"
      });
    }, options.timeoutMs ?? DESKTOP_ACTION_CONFIRMATION_TIMEOUT_MS);

    options.pendingRequests.set(request.requestId, { resolve, timeout });
    targetWindow.webContents.send("desktopActions.confirm", request);
  });
}
