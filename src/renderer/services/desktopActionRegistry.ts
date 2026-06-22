import type {
  AssistantPageContext,
  DesktopPageContextSnapshot,
  DesktopPageKind,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse
} from "../../shared/contracts";
import { createTranslator, DEFAULT_LOCALE, type TranslateFunction } from "../../shared/i18n";
import { getAssistantPageContext } from "../copilot/page-context/assistantPageContext";
import { getCurrentPageContextSnapshot } from "./currentPageContext";

export type DesktopActionProvider = (
  request: DesktopActionRendererRequest
) => Promise<Omit<DesktopActionRendererResponse, "requestId" | "action"> | null>;

export type DesktopActionProviderScope = "global" | "page" | "web";
type DesktopActionResult = Omit<DesktopActionRendererResponse, "requestId" | "action">;

export type CurrentPageDescriptor = {
  route: string;
  pageKey: string;
  pageKind: DesktopPageKind;
  surfaceId?: string;
  surfaceLabel?: string;
  surfaceRoute?: string;
  webContentsId?: number;
};

export type CurrentPageExecutor = {
  getDescriptor: () => CurrentPageDescriptor | null;
  readCurrent?: (request: DesktopActionRendererRequest) => Promise<DesktopActionResult>;
  extractStructured?: (request: DesktopActionRendererRequest) => Promise<DesktopActionResult>;
  interact?: (request: DesktopActionRendererRequest) => Promise<DesktopActionResult>;
  fillForm?: (request: DesktopActionRendererRequest) => Promise<DesktopActionResult>;
  submitForm?: (request: DesktopActionRendererRequest) => Promise<DesktopActionResult>;
};

const providers: Record<DesktopActionProviderScope, DesktopActionProvider[]> = {
  global: [],
  page: [],
  web: []
};
let bridgeStarted = false;
let currentPageExecutor: CurrentPageExecutor | null = null;
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
  if (request.action === "desktop.page.getContext") {
    const snapshot = await getCachedPageSnapshot();
    return {
      ok: true,
      result: buildPageContextResult(snapshot)
    };
  }
  if (request.action === "desktop.page.readCurrent") {
    if (currentPageExecutor?.readCurrent) {
      return currentPageExecutor.readCurrent(request);
    }
    return {
      ok: true,
      result: buildRealtimePageResult(
        await getAssistantPageContext(),
        currentPageExecutor?.getDescriptor() ?? getFallbackDescriptor()
      )
    };
  }
  if (request.action === "desktop.page.extractStructured") {
    if (currentPageExecutor?.extractStructured) {
      return currentPageExecutor.extractStructured(request);
    }
    return actionError("page_extract_unavailable", translate("desktopAction.pageExtractUnavailable"));
  }
  if (request.action === "desktop.page.interact") {
    if (currentPageExecutor?.interact) {
      return currentPageExecutor.interact(request);
    }
    return actionError("page_interact_unavailable", translate("desktopAction.pageInteractUnavailable"));
  }
  if (request.action === "desktop.page.fillForm") {
    if (currentPageExecutor?.fillForm) {
      return currentPageExecutor.fillForm(request);
    }
    return actionError("page_fill_unavailable", translate("desktopAction.pageFillUnavailable"));
  }
  if (request.action === "desktop.page.submitForm") {
    if (currentPageExecutor?.submitForm) {
      return currentPageExecutor.submitForm(request);
    }
    return actionError("page_submit_unavailable", translate("desktopAction.pageSubmitUnavailable"));
  }
  if (request.action.startsWith("desktop.web.")) {
    return actionError("web_action_unavailable", translate("desktopAction.webUnavailable"));
  }
  if (request.action.startsWith("desktop.setting.")) {
    return actionError("settings_action_unavailable", translate("desktopAction.settingsUnavailable"));
  }
  return actionError("page_action_unavailable", translate("desktopAction.pageActionUnavailable"));
}

function getFallbackRoute() {
  if (typeof window === "undefined") {
    return "/";
  }
  const hash = String(window.location.hash || "").trim();
  if (hash.startsWith("#")) {
    const route = hash.slice(1).trim();
    if (route.startsWith("/")) {
      return route;
    }
  }
  return `${window.location.pathname || "/"}${window.location.search || ""}`;
}

function getFallbackDescriptor(): CurrentPageDescriptor {
  const route = getFallbackRoute();
  return {
    route,
    pageKey: `native:${route}`,
    pageKind: "native"
  };
}

async function getCachedPageSnapshot(): Promise<DesktopPageContextSnapshot> {
  const snapshot = getCurrentPageContextSnapshot();
  if (snapshot) {
    return snapshot;
  }
  return {
    ...getFallbackDescriptor(),
    pageContext: await getAssistantPageContext()
  };
}

function buildPageContextResult(snapshot: DesktopPageContextSnapshot) {
  return {
    route: snapshot.route,
    pageKey: snapshot.pageKey,
    pageKind: snapshot.pageKind,
    ...(snapshot.surfaceId ? { surfaceId: snapshot.surfaceId } : {}),
    ...(snapshot.surfaceLabel ? { surfaceLabel: snapshot.surfaceLabel } : {}),
    ...(snapshot.surfaceRoute ? { surfaceRoute: snapshot.surfaceRoute } : {}),
    ...(snapshot.embedPath ? { embedPath: snapshot.embedPath } : {}),
    pageContext: snapshot.pageContext
  };
}

function buildRealtimePageResult(
  pageContext: AssistantPageContext | null,
  descriptor: CurrentPageDescriptor
) {
  return {
    route: descriptor.route,
    pageKey: descriptor.pageKey,
    pageKind: descriptor.pageKind,
    ...(descriptor.surfaceId ? { surfaceId: descriptor.surfaceId } : {}),
    ...(descriptor.surfaceLabel ? { surfaceLabel: descriptor.surfaceLabel } : {}),
    ...(descriptor.surfaceRoute ? { surfaceRoute: descriptor.surfaceRoute } : {}),
    realtime: true,
    readAt: new Date().toISOString(),
    pageContext
  };
}

function getProviderScopesForAction(action: string): DesktopActionProviderScope[] {
  if (action.startsWith("desktop.setting.")) {
    return ["global"];
  }
  if (action.startsWith("desktop.web.")) {
    return ["web", "global"];
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

export function registerCurrentPageExecutor(executor: CurrentPageExecutor) {
  currentPageExecutor = executor;
  return () => {
    if (currentPageExecutor === executor) {
      currentPageExecutor = null;
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
