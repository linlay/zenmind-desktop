/**
 * Desktop-owned Native WorkPanel surface registry.
 *
 * The v1 Desktop-only release intentionally ships an empty allowlist. Future
 * native surfaces must be registered here and implemented by WorkPanelHost
 * before their descriptors can be accepted.
 */
export type WorkPanelNativeSurfaceRegistration = {
  surfaceKey: string;
  closableByDefault: boolean;
};

export const WORK_PANEL_NATIVE_SURFACE_ALLOWLIST:
readonly WorkPanelNativeSurfaceRegistration[] = Object.freeze([]);

export function isRegisteredWorkPanelNativeSurface(surfaceKey: unknown) {
  const normalized = typeof surfaceKey === "string" ? surfaceKey.trim() : "";
  return Boolean(normalized) && WORK_PANEL_NATIVE_SURFACE_ALLOWLIST.some(
    (registration) => registration.surfaceKey === normalized,
  );
}
