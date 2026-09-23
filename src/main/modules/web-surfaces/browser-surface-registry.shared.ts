// Compatibility exports only. Implementations import their responsibility modules directly.
export { normalizeSurfaceMatchText, webEntryMatchesSurfaceTarget } from "./container-projection";
export { guestTargetMatches } from "./guest-resolution";
export { SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN, SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN, diagnosticGuestWebContentsIds, sanitizeSurfaceDiagnosticEnum, sanitizeSurfaceDiagnosticId } from "./registration-diagnostics";
export { activeRegistrationTab, describeMainChatRoute, isMainChatSurfaceRegistration, mainChatSurfaceRegistrationTransitionAllowed, preserveInactiveMainChatIdentity, registeredSurfaceIdentitiesConflict, sameNewChatSource } from "./registration-policy";
export * from "./registry-contracts";
