import type {
  DesktopActionRendererRequest,
  DesktopActionRendererResponse
} from "../../shared/contracts";
import { getAssistantPageContext } from "./assistantPageContext";

export type DesktopActionProvider = (
  request: DesktopActionRendererRequest
) => Promise<Omit<DesktopActionRendererResponse, "requestId" | "action"> | null>;

let activeProvider: DesktopActionProvider | null = null;
let bridgeStarted = false;

function actionError(code: string, message: string, details?: unknown) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

async function handleDefaultAction(request: DesktopActionRendererRequest) {
  if (request.action === "desktop.page.getContext") {
    return {
      ok: true,
      result: await getAssistantPageContext()
    };
  }
  return actionError("page_action_unavailable", "当前页面没有注册可执行的 Desktop action。");
}

async function handleDesktopActionCall(request: DesktopActionRendererRequest) {
  let response: Omit<DesktopActionRendererResponse, "requestId" | "action">;
  try {
    const provided = activeProvider ? await activeProvider(request) : null;
    response = provided ?? await handleDefaultAction(request);
  } catch (error) {
    response = actionError(
      "renderer_action_failed",
      error instanceof Error ? error.message : String(error)
    );
  }

  await window.electronAPI.desktopActions.respond({
    requestId: request.requestId,
    action: request.action,
    ...response
  });
}

export function registerDesktopActionProvider(provider: DesktopActionProvider) {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) {
      activeProvider = null;
    }
  };
}

export function startDesktopActionRendererBridge() {
  if (bridgeStarted) {
    return;
  }
  bridgeStarted = true;
  window.electronAPI.desktopActions.onCall((request) => {
    void handleDesktopActionCall(request);
  });
}
