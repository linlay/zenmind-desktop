import {
  type PageControlGrantScope,
  type PageControlConfirmationDecision,
  isLowRiskPageControlAction,
  resolvePageControlGrantScope,
  pageControlGrantStore
} from "./page-control-policy";
import { type DesktopActionCallRequest, type DesktopActionConfirmationPolicy, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { type DesktopActionConfirmationRequest, type DesktopPageContextSnapshot } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { readRequestPermissionMode } from "./action-permissions";
import {
  getConfirmationRequestId,
  compactConfirmationValue,
  sanitizeConfirmationUrlText,
  summarizeConfirmationArgs,
  buildDesktopActionConfirmationDetail,
  describeDesktopActionSnapshotTarget
} from "./confirmation-presentation";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { type BrowserWindow } from "electron";
import { requestDesktopActionConfirmation } from "./confirmation-dialog";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { actionError } from "./action-values";

export function buildPageControlActionConfirmationRequest(
  scope: PageControlGrantScope,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>
): DesktopActionConfirmationRequest {
  const summary = t("desktopAction.pageControlSummary", { origin: scope.origin });
  const targetLabel = [scope.surfaceLabel, scope.pageTitle].filter(Boolean).join(" · ") || scope.origin;
  const permissionMode = readRequestPermissionMode(request, args);
  return {
    requestId: getConfirmationRequestId(request),
    kind: "page_control",
    title: t("desktopAction.pageControlTitle"),
    summary,
    description: t("desktopAction.pageControlCompactDescription"),
    fields: [
      { label: t("desktopAction.confirmFieldTarget"), value: compactConfirmationValue(sanitizeConfirmationUrlText(targetLabel)) },
      { label: t("desktopAction.confirmFieldPermission"), value: permissionMode },
      { label: t("desktopAction.confirmFieldArgs"), value: compactConfirmationValue(summarizeConfirmationArgs(args)) }
    ],
    details: buildDesktopActionConfirmationDetail(request, args, {
      permissionMode,
      target: targetLabel,
      prefixLines: [
        t("desktopAction.pageControlTarget", { target: targetLabel }),
        t("desktopAction.pageControlGrantDetail"),
        t("desktopAction.pageControlHighRiskDetail")
      ]
    }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "once", label: t("desktopAction.pageControlOnce"), variant: "secondary" },
      { decision: "grant", label: t("desktopAction.pageControlGrant"), variant: "primary" }
    ],
    defaultDecision: "once",
    cancelDecision: "cancel"
  };
}

export async function confirmPageControlAction(
  options: DesktopActionBridgeOptions,
  scope: PageControlGrantScope,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  owner: BrowserWindow | null
): Promise<PageControlConfirmationDecision> {
  const decision = await requestDesktopActionConfirmation(
    options,
    buildPageControlActionConfirmationRequest(scope, request, args),
    owner
  );
  if (decision === "grant" || decision === "once") {
    return decision;
  }
  return "cancel";
}

export function buildMutatingActionConfirmationRequest(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null
): DesktopActionConfirmationRequest {
  const action = request.action;
  const summary = t("desktopAction.confirmSummary", { action });
  const permissionMode = readRequestPermissionMode(request, args);
  const target = describeDesktopActionSnapshotTarget(snapshot);
  const argsSummary = summarizeConfirmationArgs(args);
  return {
    requestId: getConfirmationRequestId(request),
    kind: "action",
    title: t("desktopAction.confirmActionTitle"),
    summary,
    description: t("desktopAction.confirmActionDetail"),
    fields: [
      { label: t("desktopAction.confirmFieldAction"), value: action || "unknown" },
      { label: t("desktopAction.confirmFieldTarget"), value: compactConfirmationValue(sanitizeConfirmationUrlText(target)) },
      { label: t("desktopAction.confirmFieldPermission"), value: permissionMode },
      { label: t("desktopAction.confirmFieldArgs"), value: compactConfirmationValue(argsSummary) }
    ],
    details: buildDesktopActionConfirmationDetail(request, args, {
      permissionMode,
      target
    }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.confirmExecute"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

export function buildSensitiveReadConfirmationRequest(
  request: DesktopActionCallRequest
): DesktopActionConfirmationRequest {
  const categories = t("desktopAction.sensitiveReadCategories");
  return {
    requestId: getConfirmationRequestId(request),
    kind: "action",
    title: t("desktopAction.sensitiveReadTitle"),
    summary: t("desktopAction.sensitiveReadSummary"),
    description: t("desktopAction.sensitiveReadDescription"),
    fields: [
      { label: t("desktopAction.sensitiveReadFieldCategories"), value: categories }
    ],
    details: t("desktopAction.sensitiveReadDetail", { categories }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.sensitiveReadConfirm"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

export async function confirmMutatingAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null,
  owner: BrowserWindow | null
) {
  const decision = await requestDesktopActionConfirmation(
    options,
    buildMutatingActionConfirmationRequest(request, args, snapshot),
    owner
  );
  return decision === "confirm";
}

export async function confirmDesktopActionIfNeeded(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  confirmationPolicy?: DesktopActionConfirmationPolicy
): Promise<DesktopActionCallResponse | null> {
  if (!readDesktopProfileFromRoot(getDesktopConfigRoot(options.app)).general.desktopActionConfirmationEnabled) {
    return null;
  }
  const action = request.action;
  const permissionMode = readRequestPermissionMode(request, args);
  if (permissionMode === "full_access") {
    return null;
  }
  if (confirmationPolicy === "sensitive-read") {
    const decision = await requestDesktopActionConfirmation(
      options,
      buildSensitiveReadConfirmationRequest(request),
      options.getMainWindow()
    );
    if (decision === "confirm") {
      return null;
    }
    return {
      ok: false,
      action,
      requiresConfirmation: true,
      error: actionError("user_cancelled", t("desktopAction.userCancelled"))
    };
  }
  const snapshot = options.getCurrentPageSnapshot();
  if (permissionMode === "page_control" && await isLowRiskPageControlAction(action, args, snapshot)) {
    const scope = await resolvePageControlGrantScope(snapshot, request);
    if (scope && pageControlGrantStore.has(scope)) {
      return null;
    }
    if (scope) {
      const decision = await confirmPageControlAction(options, scope, request, args, options.getMainWindow());
      if (decision === "grant") {
        pageControlGrantStore.grant(scope);
        return null;
      }
      if (decision === "once") {
        return null;
      }
      return {
        ok: false,
        action,
        requiresConfirmation: true,
        error: actionError("user_cancelled", t("desktopAction.userCancelledAuth"))
      };
    }
  }
  const confirmed = await confirmMutatingAction(options, request, args, snapshot, options.getMainWindow());
  if (confirmed) {
    return null;
  }
  return {
    ok: false,
    action,
    requiresConfirmation: true,
    error: actionError("user_cancelled", t("desktopAction.userCancelled"))
  };
}
