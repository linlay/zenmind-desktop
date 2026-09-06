import type { WebContents } from "electron";

import type { DesktopPageContextSnapshot } from "../../../shared/contracts";

import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRegistrationResult,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTabRegistration,
  EmbeddedCdpSiteSurfaceKind,
  EmbeddedCdpSurfaceKind
} from "../../../shared/embedded-cdp";

import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../../shared/browser-surfaces";

import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource
} from "../../../shared/canonical-chat-sync";

import { readAgentWebclientAgentRouteKey } from "../../../shared/agent-webclient-routes";

import { selectSurvivingTabId } from "../../../shared/web-tab-lifecycle";

import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  LEGACY_FIXED_SURFACE_ID_ALIASES,
  MAIN_CHAT_SURFACE_ID,
  createLegacySurfaceIdAliases,
  createWebEntrySurfaceIdentity,
  resolveFixedSurfaceRole,
  resolveLegacyFixedSurfaceId,
  surfaceIdentityMatchesPolicy,
  type SurfaceIdentity,
  type SurfaceRole
} from "../../../shared/surface-identity";

import { reportDeprecatedCompatibilityUse } from "../../support/logging/deprecated-compatibility";

import type { CreateBrowserSurfaceRegistryContext } from "./browser-surface-registry.shared";

import { BrowserSurface, BrowserSurfaceDiagnosticSnapshot, BrowserSurfaceLifecycleEvent, BrowserSurfaceRegistryOptions, BrowserSurfaceTab, BrowserWebContentsDiagnosticSnapshot, PendingGuestTargetWaiter, PendingSurfaceRegistrationDiagnostic, RegisteredSurface, RegisteredWebviewSurfaceTarget, SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN, SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN, SurfaceRegistrationDiagnostic, SurfaceRegistrationInvalidCheck, SurfaceRegistrationRejectionReason, SurfaceRegistrationValidation, WebContentsAccess, activeRegistrationTab, describeMainChatRoute, diagnosticGuestWebContentsIds, guestTargetMatches, isMainChatSurfaceRegistration, mainChatSurfaceRegistrationTransitionAllowed, normalizeSurfaceMatchText, preserveInactiveMainChatIdentity, registeredSurfaceIdentitiesConflict, sameNewChatSource, sanitizeSurfaceDiagnosticEnum, sanitizeSurfaceDiagnosticId, webEntryMatchesSurfaceTarget } from "./browser-surface-registry.shared";

import { createBrowserSurfaceRegistry_emitLifecycle_1, createBrowserSurfaceRegistry_subscribeLifecycle_2, createBrowserSurfaceRegistry_reportRegistrationDiagnostic_3, createBrowserSurfaceRegistry_summarizeRegisteredSurface_4, createBrowserSurfaceRegistry_createRegistrationDiagnostic_5, createBrowserSurfaceRegistry_flushRegistrationDiagnostic_6, createBrowserSurfaceRegistry_scheduleRegistrationDiagnosticFlush_7, createBrowserSurfaceRegistry_rejectSurfaceRegistration_8, createBrowserSurfaceRegistry_settleRegistrationDiagnostics_9, createBrowserSurfaceRegistry_resolveCanonicalSurfaceId_10, createBrowserSurfaceRegistry_removeAliasesForSurface_11, createBrowserSurfaceRegistry_addDerivedAliases_12, createBrowserSurfaceRegistry_fallbackSurfaceType_13, createBrowserSurfaceRegistry_settleGuestTargetWaiters_14, createBrowserSurfaceRegistry_removeGuestTargetsForSurface_15, createBrowserSurfaceRegistry_indexRegisteredSurface_16, createBrowserSurfaceRegistry_expectedRolesForRegistration_17, createBrowserSurfaceRegistry_validateRegistrationIdentity_18, createBrowserSurfaceRegistry_isValidSurfaceTab_19 } from "./browser-surface-registry.operations-1";

import { createBrowserSurfaceRegistry_validateSurfaceRegistration_1, createBrowserSurfaceRegistry_registerSurfaceResult_2, createBrowserSurfaceRegistry_registerSurface_3, createBrowserSurfaceRegistry_unregisterSurface_4, createBrowserSurfaceRegistry_unregisterSurfacesForOwner_5, createBrowserSurfaceRegistry_resolveRegisteredSurface_6, createBrowserSurfaceRegistry_removeChildSurfaces_7, createBrowserSurfaceRegistry_findRegisteredSurfaceWebContents_8, createBrowserSurfaceRegistry_findWebContentsById_9, createBrowserSurfaceRegistry_resolveWebviewSurfaceTarget_10, createBrowserSurfaceRegistry_waitForWebviewSurfaceTarget_11 } from "./browser-surface-registry.operations-2";

import { createBrowserSurfaceRegistry_waitForWebviewSurfaceTargetMatching_1, createBrowserSurfaceRegistry_currentPageSnapshotMatchesSurface_2, createBrowserSurfaceRegistry_findWebContentsForSurfaceUrl_3, createBrowserSurfaceRegistry_builtinBrowserSurface_4, createBrowserSurfaceRegistry_listBrowserSurfaces_5, createBrowserSurfaceRegistry_listChatWorkPanelSurfaces_6, createBrowserSurfaceRegistry_listRegisteredSurfaces_7, createBrowserSurfaceRegistry_listDiagnosticSurfaces_8, createBrowserSurfaceRegistry_listWebContentsDiagnostics_9, createBrowserSurfaceRegistry_getRegisteredSurfaceSnapshot_10 } from "./browser-surface-registry.operations-3";

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  const factoryContext: CreateBrowserSurfaceRegistryContext = {
    get options() { return options; },
    get registeredSurfaces() { return registeredSurfaces; },
    get registeredGuestTargets() { return registeredGuestTargets; },
    get pendingGuestTargetWaiters() { return pendingGuestTargetWaiters; },
    get surfaceAliases() { return surfaceAliases; },
    get pendingRegistrationDiagnostics() { return pendingRegistrationDiagnostics; },
    get lifecycleListeners() { return lifecycleListeners; },
    get registrationDiagnosticDedupWindowMs() { return registrationDiagnosticDedupWindowMs; },
    get emitLifecycle() { return emitLifecycle; },
    get subscribeLifecycle() { return subscribeLifecycle; },
    get reportRegistrationDiagnostic() { return reportRegistrationDiagnostic; },
    get summarizeRegisteredSurface() { return summarizeRegisteredSurface; },
    get createRegistrationDiagnostic() { return createRegistrationDiagnostic; },
    get flushRegistrationDiagnostic() { return flushRegistrationDiagnostic; },
    get scheduleRegistrationDiagnosticFlush() { return scheduleRegistrationDiagnosticFlush; },
    get rejectSurfaceRegistration() { return rejectSurfaceRegistration; },
    get settleRegistrationDiagnostics() { return settleRegistrationDiagnostics; },
    get resolveCanonicalSurfaceId() { return resolveCanonicalSurfaceId; },
    get removeAliasesForSurface() { return removeAliasesForSurface; },
    get addDerivedAliases() { return addDerivedAliases; },
    get fallbackSurfaceType() { return fallbackSurfaceType; },
    get settleGuestTargetWaiters() { return settleGuestTargetWaiters; },
    get removeGuestTargetsForSurface() { return removeGuestTargetsForSurface; },
    get indexRegisteredSurface() { return indexRegisteredSurface; },
    get expectedRolesForRegistration() { return expectedRolesForRegistration; },
    get validateRegistrationIdentity() { return validateRegistrationIdentity; },
    get isValidSurfaceTab() { return isValidSurfaceTab; },
    get validateSurfaceRegistration() { return validateSurfaceRegistration; },
    get registerSurfaceResult() { return registerSurfaceResult; },
    get registerSurface() { return registerSurface; },
    get unregisterSurface() { return unregisterSurface; },
    get unregisterSurfacesForOwner() { return unregisterSurfacesForOwner; },
    get resolveRegisteredSurface() { return resolveRegisteredSurface; },
    get removeChildSurfaces() { return removeChildSurfaces; },
    get findRegisteredSurfaceWebContents() { return findRegisteredSurfaceWebContents; },
    get findWebContentsById() { return findWebContentsById; },
    get resolveWebviewSurfaceTarget() { return resolveWebviewSurfaceTarget; },
    get waitForWebviewSurfaceTarget() { return waitForWebviewSurfaceTarget; },
    get waitForWebviewSurfaceTargetMatching() { return waitForWebviewSurfaceTargetMatching; },
    get currentPageSnapshotMatchesSurface() { return currentPageSnapshotMatchesSurface; },
    get findWebContentsForSurfaceUrl() { return findWebContentsForSurfaceUrl; },
    get builtinBrowserSurface() { return builtinBrowserSurface; },
    get listBrowserSurfaces() { return listBrowserSurfaces; },
    get listChatWorkPanelSurfaces() { return listChatWorkPanelSurfaces; },
    get listRegisteredSurfaces() { return listRegisteredSurfaces; },
    get listDiagnosticSurfaces() { return listDiagnosticSurfaces; },
    get listWebContentsDiagnostics() { return listWebContentsDiagnostics; },
    get getRegisteredSurfaceSnapshot() { return getRegisteredSurfaceSnapshot; }
  };
  const registeredSurfaces = new Map<string, RegisteredSurface>();
  const registeredGuestTargets = new Map<number, RegisteredWebviewSurfaceTarget>();
  const pendingGuestTargetWaiters = new Map<
    number,
    Set<PendingGuestTargetWaiter>
  >();
  const surfaceAliases = new Map<string, string>(Object.entries(LEGACY_FIXED_SURFACE_ID_ALIASES));
  const pendingRegistrationDiagnostics = new Map<string, PendingSurfaceRegistrationDiagnostic>();
  const lifecycleListeners = new Set<(event: BrowserSurfaceLifecycleEvent) => void>();
  const registrationDiagnosticDedupWindowMs = Math.max(
    10,
    Math.min(options.registrationDiagnosticDedupWindowMs ?? 1_000, 10_000),
  );

  function emitLifecycle(type: BrowserSurfaceLifecycleEvent["type"], surface: RegisteredSurface) { return createBrowserSurfaceRegistry_emitLifecycle_1(factoryContext, type, surface); }

  function subscribeLifecycle(listener: (event: BrowserSurfaceLifecycleEvent) => void) { return createBrowserSurfaceRegistry_subscribeLifecycle_2(factoryContext, listener); }

  function reportRegistrationDiagnostic(diagnostic: SurfaceRegistrationDiagnostic) { return createBrowserSurfaceRegistry_reportRegistrationDiagnostic_3(factoryContext, diagnostic); }

  function summarizeRegisteredSurface(surface: RegisteredSurface) { return createBrowserSurfaceRegistry_summarizeRegisteredSurface_4(factoryContext, surface); }

  function createRegistrationDiagnostic(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
    reason: SurfaceRegistrationRejectionReason,
    details: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict"> = {},
  ): SurfaceRegistrationDiagnostic { return createBrowserSurfaceRegistry_createRegistrationDiagnostic_5(factoryContext, input, ownerWebContentsId, reason, details); }

  function flushRegistrationDiagnostic(
    key: string,
    resolution: NonNullable<SurfaceRegistrationDiagnostic["resolution"]>,
  ) { return createBrowserSurfaceRegistry_flushRegistrationDiagnostic_6(factoryContext, key, resolution); }

  function scheduleRegistrationDiagnosticFlush(key: string) { return createBrowserSurfaceRegistry_scheduleRegistrationDiagnosticFlush_7(factoryContext, key); }

  function rejectSurfaceRegistration(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
    reason: SurfaceRegistrationRejectionReason,
    details: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict"> = {},
  ): EmbeddedCdpSurfaceRegistrationResult { return createBrowserSurfaceRegistry_rejectSurfaceRegistration_8(factoryContext, input, ownerWebContentsId, reason, details); }

  function settleRegistrationDiagnostics(input: EmbeddedCdpSurfaceRegistration) { return createBrowserSurfaceRegistry_settleRegistrationDiagnostics_9(factoryContext, input); }

  function resolveCanonicalSurfaceId(surfaceId: string) { return createBrowserSurfaceRegistry_resolveCanonicalSurfaceId_10(factoryContext, surfaceId); }

  function removeAliasesForSurface(surfaceId: string) { return createBrowserSurfaceRegistry_removeAliasesForSurface_11(factoryContext, surfaceId); }

  function addDerivedAliases(surface: RegisteredSurface) { return createBrowserSurfaceRegistry_addDerivedAliases_12(factoryContext, surface); }

  function fallbackSurfaceType(surfaceKind: EmbeddedCdpSurfaceKind) { return createBrowserSurfaceRegistry_fallbackSurfaceType_13(factoryContext, surfaceKind); }

  function settleGuestTargetWaiters(
    webContentsId: number,
    target: RegisteredWebviewSurfaceTarget | null,
  ) { return createBrowserSurfaceRegistry_settleGuestTargetWaiters_14(factoryContext, webContentsId, target); }

  function removeGuestTargetsForSurface(surfaceId: string, settleWaiters = true) { return createBrowserSurfaceRegistry_removeGuestTargetsForSurface_15(factoryContext, surfaceId, settleWaiters); }

  function indexRegisteredSurface(surface: RegisteredSurface) { return createBrowserSurfaceRegistry_indexRegisteredSurface_16(factoryContext, surface); }

  function expectedRolesForRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRole[] { return createBrowserSurfaceRegistry_expectedRolesForRegistration_17(factoryContext, input); }

  function validateRegistrationIdentity(input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation { return createBrowserSurfaceRegistry_validateRegistrationIdentity_18(factoryContext, input); }

  function isValidSurfaceTab(input: EmbeddedCdpSurfaceTabRegistration) { return createBrowserSurfaceRegistry_isValidSurfaceTab_19(factoryContext, input); }

  function validateSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation { return createBrowserSurfaceRegistry_validateSurfaceRegistration_1(factoryContext, input); }

  function registerSurfaceResult(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
  ): EmbeddedCdpSurfaceRegistrationResult { return createBrowserSurfaceRegistry_registerSurfaceResult_2(factoryContext, input, ownerWebContentsId); }

  function registerSurface(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number) { return createBrowserSurfaceRegistry_registerSurface_3(factoryContext, input, ownerWebContentsId); }

  function unregisterSurface(input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number) { return createBrowserSurfaceRegistry_unregisterSurface_4(factoryContext, input, ownerWebContentsId); }

  function unregisterSurfacesForOwner(ownerWebContentsId: number) { return createBrowserSurfaceRegistry_unregisterSurfacesForOwner_5(factoryContext, ownerWebContentsId); }

  function resolveRegisteredSurface(surfaceId: string) { return createBrowserSurfaceRegistry_resolveRegisteredSurface_6(factoryContext, surfaceId); }

  function removeChildSurfaces(parentSurfaceId: string) { return createBrowserSurfaceRegistry_removeChildSurfaces_7(factoryContext, parentSurfaceId); }

  function findRegisteredSurfaceWebContents(surfaceId: string, tabId?: string) { return createBrowserSurfaceRegistry_findRegisteredSurfaceWebContents_8(factoryContext, surfaceId, tabId); }

  function findWebContentsById(webContentsId: number) { return createBrowserSurfaceRegistry_findWebContentsById_9(factoryContext, webContentsId); }

  function resolveWebviewSurfaceTarget(webContentsId: number) { return createBrowserSurfaceRegistry_resolveWebviewSurfaceTarget_10(factoryContext, webContentsId); }

  function waitForWebviewSurfaceTarget(
    webContentsId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RegisteredWebviewSurfaceTarget | null> { return createBrowserSurfaceRegistry_waitForWebviewSurfaceTarget_11(factoryContext, webContentsId, timeoutMs, signal); }

  function waitForWebviewSurfaceTargetMatching(
    webContentsId: number,
    predicate: (target: RegisteredWebviewSurfaceTarget) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RegisteredWebviewSurfaceTarget | null> { return createBrowserSurfaceRegistry_waitForWebviewSurfaceTargetMatching_1(factoryContext, webContentsId, predicate, timeoutMs, signal); }

  function currentPageSnapshotMatchesSurface(surfaceId: string, contents?: WebContents | null) { return createBrowserSurfaceRegistry_currentPageSnapshotMatchesSurface_2(factoryContext, surfaceId, contents); }

  function findWebContentsForSurfaceUrl(surfaceUrl: string) { return createBrowserSurfaceRegistry_findWebContentsForSurfaceUrl_3(factoryContext, surfaceUrl); }

  function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserSurface { return createBrowserSurfaceRegistry_builtinBrowserSurface_4(factoryContext, contents, url); }

  function listBrowserSurfaces(): BrowserSurface[] { return createBrowserSurfaceRegistry_listBrowserSurfaces_5(factoryContext); }

  function listChatWorkPanelSurfaces(): BrowserSurface[] { return createBrowserSurfaceRegistry_listChatWorkPanelSurfaces_6(factoryContext); }

  function listRegisteredSurfaces(): BrowserSurface[] { return createBrowserSurfaceRegistry_listRegisteredSurfaces_7(factoryContext); }

  function listDiagnosticSurfaces(): BrowserSurfaceDiagnosticSnapshot[] { return createBrowserSurfaceRegistry_listDiagnosticSurfaces_8(factoryContext); }

  function listWebContentsDiagnostics(): BrowserWebContentsDiagnosticSnapshot[] { return createBrowserSurfaceRegistry_listWebContentsDiagnostics_9(factoryContext); }

  function getRegisteredSurfaceSnapshot(
    surfaceId: string,
    registrationId: string,
    ownerWebContentsId: number
  ) { return createBrowserSurfaceRegistry_getRegisteredSurfaceSnapshot_10(factoryContext, surfaceId, registrationId, ownerWebContentsId); }

  return {
    currentPageSnapshotMatchesSurface,
    findWebContentsById,
    findWebContentsForSurfaceUrl,
    findRegisteredSurfaceWebContents,
    builtinBrowserSurface,
    listBrowserSurfaces,
    listChatWorkPanelSurfaces,
    listDiagnosticSurfaces,
    listRegisteredSurfaces,
    listWebContentsDiagnostics,
    getRegisteredSurfaceSnapshot,
    registerSurface,
    registerSurfaceResult,
    resolveCanonicalSurfaceId,
    resolveWebviewSurfaceTarget,
    waitForWebviewSurfaceTarget,
    waitForWebviewSurfaceTargetMatching,
    unregisterSurface,
    unregisterSurfacesForOwner,
    subscribeLifecycle,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;

export * from "./browser-surface-registry.shared";
