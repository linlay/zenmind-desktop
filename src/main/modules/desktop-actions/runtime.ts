import { buildDesktopActionConfirmationDetail, sanitizeConfirmationUrl, summarizeConfirmationArgs } from "./confirmation-presentation";
import {
  buildMutatingActionConfirmationRequest,
  buildSensitiveReadConfirmationRequest,
  buildPageControlActionConfirmationRequest
} from "./confirmation-policy";
import { normalizeActionResponseTimePayload } from "./action-handlers";
import { fetchAgentPlatformWithAuth } from "./platform-http";
import { webappActionRateLimiter } from "./webapp-native-actions";

export const __testInternals = {
  buildDesktopActionConfirmationDetail,
  buildMutatingActionConfirmationRequest,
  buildSensitiveReadConfirmationRequest,
  buildPageControlActionConfirmationRequest,
  normalizeActionResponseTimePayload,
  sanitizeConfirmationUrl,
  summarizeConfirmationArgs,
  fetchAgentPlatformWithAuth,
  clearWebappActionRateLimits: () => webappActionRateLimiter.clear()
};
export * from "./action-http-server";
export * from "./action-contracts";
export * from "./webapp-native-actions";
export * from "./page-control-policy";
export * from "./web-export-actions";
export * from "./confirmation-presentation";
export * from "./webapp-image-input";
export * from "./platform-http";
export * from "./help-routing";
export * from "./action-values";
export * from "./market-action-input";
export * from "./confirmation-policy";
export * from "./renderer-action-results";
export * from "./web-resource-actions";
export * from "./webapp-action-results";
export * from "./webapp-tooling-actions";
export * from "./kanban-actions";
export * from "./pet-actions";
export * from "./local-file-actions";
export * from "./action-dispatch";
export * from "./action-handlers";
export * from "./cdp-handler";
export * from "./confirmation-dialog";
export * from "./action-permissions";
export * from "./page-context-values";
