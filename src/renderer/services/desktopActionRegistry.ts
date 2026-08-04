import type {
  DesktopActionRendererRequest,
  DesktopActionRendererResponse
} from "../../shared/contracts";
import { createTranslator, DEFAULT_LOCALE, type TranslateFunction } from "../../shared/i18n";

export type DesktopActionProvider = (
  request: DesktopActionRendererRequest
) => Promise<Omit<DesktopActionRendererResponse, "requestId" | "action"> | null>;

export type DesktopActionProviderScope = "global" | "page" | "web";

const providers: Record<DesktopActionProviderScope, DesktopActionProvider[]> = {
  global: [],
  page: [],
  web: []
};
let bridgeStarted = false;
let translate: TranslateFunction = createTranslator(DEFAULT_LOCALE);

export function setDesktopActionTranslator(nextTranslator: TranslateFunction) {
  translate = nextTranslator;
}

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
  if (request.action.startsWith("desktop.web.")) {
    return actionError("web_action_unavailable", translate("desktopAction.webUnavailable"));
  }
  if (
    request.action.startsWith("desktop.theme.") ||
    request.action.startsWith("desktop.locale.") ||
    request.action.startsWith("desktop.copilot.") ||
    request.action.startsWith("desktop.general.")
  ) {
    return actionError("settings_action_unavailable", translate("desktopAction.settingsUnavailable"));
  }
  return actionError("page_action_unavailable", translate("desktopAction.pageActionUnavailable"));
}

function getProviderScopesForAction(action: string): DesktopActionProviderScope[] {
  if (
    action.startsWith("desktop.theme.") ||
    action.startsWith("desktop.locale.") ||
    action.startsWith("desktop.copilot.") ||
    action.startsWith("desktop.general.")
  ) {
    return ["global"];
  }
  if (action.startsWith("desktop.web.")) {
    return ["web", "global"];
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
