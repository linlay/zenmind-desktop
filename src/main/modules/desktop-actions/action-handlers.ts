import {
  type DesktopActionBridgeOptions,
  type DesktopActionInvocationContext,
  AGENT_PLATFORM_ONLY_ACTIONS,
  ARGUMENT_FREE_RUNTIME_ACTIONS,
  AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS,
  type AgentWebclientWorkPanelAction,
  AGENT_WEBCLIENT_WORKPANEL_ACTIONS,
  AGENT_WEBCLIENT_WORKPANEL_DESKTOP_ACTIONS
} from "./action-contracts";
import {
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  getDesktopActionDefinition,
  isDesktopActionMutating
} from "../../../shared/desktop-actions";
import { fail, asRecord, readString } from "./action-values";
import { CURRENT_PAGE_WEB_ACTIONS } from "./page-control-policy";
import { t } from "../../support/i18n/main-i18n";
import { confirmDesktopActionIfNeeded } from "./confirmation-policy";
import { executeAction } from "./action-dispatch";
import { normalizeActionBridgeTimePayload, ActionBridgeTimeContractError } from "./time-normalizer";
import { executeWebappKanban } from "./webapp-kanban";
import { executeWebappAssistant } from "./webapp-assistant";
import { isWebappConnectorAction, executeWebappConnector } from "./webapp-connector";
import { resolveWebappAction } from "../../../shared/webapp-bridge";

export async function handleActionCallRaw(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  const action = typeof request.action === "string" ? request.action.trim() : "";
  const definition = action ? getDesktopActionDefinition(action) : null;
  if (!action || !definition) {
    return fail(action || "unknown", "unknown_action", `unknown action: ${action || "(empty)"}`);
  }
  if (AGENT_PLATFORM_ONLY_ACTIONS.has(action) && invocation.kind !== "agentPlatform") {
    return fail(action, "forbidden", `${action} is available only to an authorized internal Agent Platform Run.`);
  }
  const normalizedRequest = { ...request, action };
  const args = asRecord(request.args);
  for (const reservedField of ["source", ["confirmation", "Summary"].join("")]) {
    if (Object.prototype.hasOwnProperty.call(args, reservedField)) {
      return fail(action, "invalid_args", `${reservedField} is reserved.`);
    }
  }
  if (ARGUMENT_FREE_RUNTIME_ACTIONS.has(action) && Object.keys(args).length > 0) {
    return fail(action, "invalid_args", `${action} does not accept args.`);
  }
  if (CURRENT_PAGE_WEB_ACTIONS.has(action)) {
    const snapshot = options.getCurrentPageSnapshot();
    if (
      request.expectedPageKey &&
      snapshot?.pageKey &&
      request.expectedPageKey !== snapshot.pageKey
    ) {
      return fail(action, "stale_page_target", t("desktopAction.stalePageTarget"), {
        expectedPageKey: request.expectedPageKey,
        currentPageKey: snapshot.pageKey
      });
    }
  }
  const confirmationEligibleInvocation = invocation.kind === "desktop" || invocation.kind === "agentPlatform";
  const agentPlatformConfirmationExempt = invocation.kind === "agentPlatform" &&
    AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS.has(action);
  const requiresConfirmation = definition.confirmation !== "none" &&
    (isDesktopActionMutating(action) || definition.confirmation === "sensitive-read");
  if (requiresConfirmation && confirmationEligibleInvocation && !agentPlatformConfirmationExempt) {
    const confirmationResponse = await confirmDesktopActionIfNeeded(
      options,
      normalizedRequest,
      args,
      definition.confirmation
    );
    if (confirmationResponse) {
      return confirmationResponse;
    }
  }
  try {
    return await executeAction(options, normalizedRequest, invocation);
  } catch (error) {
    return fail(action, "action_failed", error instanceof Error ? error.message : "Unexpected Desktop Action exception.", {
      stage: "execution", executionState: "unknown",
      cause: error instanceof Error ? { name: error.name, message: error.message, code: (error as NodeJS.ErrnoException).code } : { message: "Non-Error exception" },
    });
  }
}

export function normalizeActionResponseTimePayload(
  response: DesktopActionCallResponse
): DesktopActionCallResponse {
  if (response.result === undefined) return response;
  const schema = getDesktopActionDefinition(response.action)?.outputSchema;
  if (!schema) return response;
  try {
    return {
      ...response,
      result: normalizeActionBridgeTimePayload(
        response.result,
        schema,
        `desktop.action.${response.action}.result`
      )
    };
  } catch (error) {
    if (!(error instanceof ActionBridgeTimeContractError)) throw error;
    return fail(response.action, "time_contract_violation", "time contract violation", {
      code: "time_contract_violation",
      field: error.field,
      location: error.location,
      expected: "epoch_ms_int64"
    });
  }
}

export async function handleActionCall(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  const isWebapp = invocation.kind === "webappPage" || invocation.kind === "webappBackend";
  if (["kanban.boards.list", "kanban.issues.list", "kanban.issues.get"].includes(request.action)) return executeWebappKanban(options, request.action, asRecord(request.args), invocation);
  if (request.action === "assistant.events" || request.action === "assistant.stop") return executeWebappAssistant(options, request.action, asRecord(request.args), invocation);
  if (isWebappConnectorAction(request.action)) return executeWebappConnector(options, request.action, asRecord(request.args), invocation);
  const action = isWebapp ? resolveWebappAction(request.action) : request.action;
  const response = normalizeActionResponseTimePayload(
    await handleActionCallRaw(options, { ...request, action }, invocation)
  );
  return isWebapp ? { ...response, action: request.action } : response;
}

export async function handleDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request);
}

export async function handleAgentPlatformDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request, { kind: "agentPlatform" });
}

export async function handleAgentWebclientWorkPanelActionRequest(
  options: DesktopActionBridgeOptions,
  input: {
    requestId?: string;
    action: AgentWebclientWorkPanelAction;
    ownerChatId: string;
    args?: Record<string, unknown>;
  }
) {
  const method = typeof input.action === "string" ? input.action.trim() : "";
  if (!AGENT_WEBCLIENT_WORKPANEL_ACTIONS.has(method)) {
    return fail(`desktop.workpanel.${method || "unknown"}`, "forbidden", "This action is unavailable to the Agent WebClient WorkPanel bridge.");
  }
  const bridgeAction = method as AgentWebclientWorkPanelAction;
  const action = AGENT_WEBCLIENT_WORKPANEL_DESKTOP_ACTIONS[bridgeAction];
  const ownerChatId = typeof input.ownerChatId === "string" ? input.ownerChatId.trim() : "";
  if (!ownerChatId) {
    return fail(action, "source_chat_required", "A trusted WorkPanel owner chat is required.");
  }
  return handleActionCall(options, {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    action,
    args: bridgeAction === "openItem"
      ? asRecord(input.args)
      : { tabId: readString(asRecord(input.args), "itemId") },
    source: { chatId: ownerChatId }
  }, { kind: "agentWebclientWorkPanel" });
}

export async function handleWebappPageActionRequest(
  options: DesktopActionBridgeOptions,
  webappId: string,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, {
    ...request,
    source: { webappId }
  }, { kind: "webappPage", webappId });
}
