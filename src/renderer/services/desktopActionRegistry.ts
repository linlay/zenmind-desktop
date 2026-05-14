import type {
  DesktopActionRendererRequest,
  DesktopActionRendererResponse
} from "../../shared/contracts";
import { getAssistantPageContext } from "./assistantPageContext";

export type DesktopActionProvider = (
  request: DesktopActionRendererRequest
) => Promise<Omit<DesktopActionRendererResponse, "requestId" | "action"> | null>;

export type DesktopActionProviderScope = "global" | "page" | "embeddedWeb";

const providers: Record<DesktopActionProviderScope, DesktopActionProvider[]> = {
  global: [],
  page: [],
  embeddedWeb: []
};
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
  if (request.action.startsWith("desktop.embeddedWeb.")) {
    return actionError("embedded_web_action_unavailable", "当前没有可执行的内嵌网站 Desktop action。");
  }
  if (request.action.startsWith("desktop.settings.")) {
    return actionError("settings_action_unavailable", "当前没有可执行的 Desktop 设置 action。");
  }
  return actionError("page_action_unavailable", "当前页面没有注册可执行的 Desktop action。");
}

function getProviderScopesForAction(action: string): DesktopActionProviderScope[] {
  if (action.startsWith("desktop.settings.")) {
    return ["global"];
  }
  if (action.startsWith("desktop.embeddedWeb.")) {
    return ["embeddedWeb", "global"];
  }
  if (action.startsWith("desktop.page.")) {
    return ["page"];
  }
  return ["page", "global"];
}

async function callScopedProviders(request: DesktopActionRendererRequest) {
  const scopes = getProviderScopesForAction(request.action);
  for (const scope of scopes) {
    const scopedProviders = providers[scope];
    for (let index = scopedProviders.length - 1; index >= 0; index -= 1) {
      const response = await scopedProviders[index](request);
      if (response) {
        return response;
      }
    }
  }
  return null;
}

async function handleDesktopActionCall(request: DesktopActionRendererRequest) {
  let response: Omit<DesktopActionRendererResponse, "requestId" | "action">;
  try {
    const provided = await callScopedProviders(request);
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

export function registerDesktopActionProviderForScope(
  scope: DesktopActionProviderScope,
  provider: DesktopActionProvider
) {
  providers[scope].push(provider);
  return () => {
    const index = providers[scope].indexOf(provider);
    if (index !== -1) {
      providers[scope].splice(index, 1);
    }
  };
}

export function registerDesktopActionProvider(provider: DesktopActionProvider) {
  return registerDesktopActionProviderForScope("page", provider);
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
