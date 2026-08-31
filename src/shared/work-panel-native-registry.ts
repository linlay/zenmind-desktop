/**
 * Desktop-owned Native WorkPanel surface registry.
 *
 * Public bridges cannot create these descriptors. Main turns a validated,
 * single-use claim into a host descriptor inside the trusted AppShell.
 */
export type WorkPanelNativeSurfaceRegistration = {
  surfaceKey: string;
  closableByDefault: boolean;
};

export const WORK_PANEL_NATIVE_SURFACE_ALLOWLIST:
readonly WorkPanelNativeSurfaceRegistration[] = Object.freeze([
  { surfaceKey: "resource-image", closableByDefault: true },
]);

export function isRegisteredWorkPanelNativeSurface(surfaceKey: unknown) {
  const normalized = typeof surfaceKey === "string" ? surfaceKey.trim() : "";
  return Boolean(normalized) && WORK_PANEL_NATIVE_SURFACE_ALLOWLIST.some(
    (registration) => registration.surfaceKey === normalized,
  );
}
