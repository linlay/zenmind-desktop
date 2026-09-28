import { EmbeddedCdpSurfaceRegistration, EmbeddedCdpSurfaceRegistrationResult } from "../../../shared/embedded-cdp";
import type { BrowserSurfaceRegistryOptions, PendingSurfaceRegistrationDiagnostic, RegisteredSurface, SurfaceRegistrationDiagnostic, SurfaceRegistrationRejectionReason } from "./registry-contracts";

export const SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export const SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token)/iu;

export function sanitizeSurfaceDiagnosticId(value: unknown) {
  if (typeof value !== "string") return "(missing)";
  const normalized = value.trim();
  if (!normalized) return "(missing)";
  if (
    normalized.length > 192 ||
    !SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN.test(normalized) ||
    SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN.test(normalized)
  ) {
    return `(redacted:${normalized.length})`;
  }
  return normalized;
}

export function sanitizeSurfaceDiagnosticEnum(value: unknown) {
  if (typeof value !== "string") return "(missing)";
  const normalized = value.trim();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(normalized) &&
    !SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN.test(normalized)
    ? normalized
    : "(invalid)";
}

export function diagnosticGuestWebContentsIds(input: unknown) {
  if (!input || typeof input !== "object") return [];
  const tabs = (input as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return [];
  return [...new Set(tabs.flatMap((tab) => {
    const value = tab && typeof tab === "object"
      ? (tab as { webContentsId?: unknown }).webContentsId
      : null;
    return Number.isSafeInteger(value) && Number(value) > 0 ? [Number(value)] : [];
  }))];
}

/** Private registration diagnostics responsibility. */
export function createRegistrationDiagnostics(options: Pick<BrowserSurfaceRegistryOptions, "reportRegistrationDiagnostic" | "registrationDiagnosticDedupWindowMs">) {
  const pendingRegistrationDiagnostics = new Map<string, PendingSurfaceRegistrationDiagnostic>();
  const registrationDiagnosticDedupWindowMs = Math.max(10, Math.min(options.registrationDiagnosticDedupWindowMs ?? 1_000, 10_000));

  function reportRegistrationDiagnostic(diagnostic: SurfaceRegistrationDiagnostic): void {
    try {
      options.reportRegistrationDiagnostic?.(diagnostic);
    }
    catch {
      // Diagnostics must never affect surface authorization or registration.
    }
  }

  function summarizeRegisteredSurface(surface: RegisteredSurface): { registrationId: string; surfaceId: string; surfaceRole: string; ownerWebContentsId: number | null; guestWebContentsIds: number[]; } {
    return {
      registrationId: sanitizeSurfaceDiagnosticId(surface.registrationId),
      surfaceId: sanitizeSurfaceDiagnosticId(surface.surfaceId),
      surfaceRole: sanitizeSurfaceDiagnosticEnum(surface.surfaceRole),
      ownerWebContentsId: Number.isSafeInteger(surface.ownerWebContentsId)
        ? surface.ownerWebContentsId
        : null,
      guestWebContentsIds: diagnosticGuestWebContentsIds(surface),
    };
  }

  function createRegistrationDiagnostic(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">): SurfaceRegistrationDiagnostic {
    const candidate = input as unknown as Record<string, unknown> | null;
    return {
      event: "surface-registration-rejected",
      reason,
      registrationId: sanitizeSurfaceDiagnosticId(candidate?.registrationId),
      surfaceId: sanitizeSurfaceDiagnosticId(candidate?.surfaceId),
      surfaceKind: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceKind),
      surfaceRole: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceRole),
      surfaceLevel: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceLevel),
      ownerWebContentsId: Number.isSafeInteger(ownerWebContentsId) && ownerWebContentsId > 0
        ? ownerWebContentsId
        : null,
      guestWebContentsIds: diagnosticGuestWebContentsIds(input),
      parentSurfaceId: sanitizeSurfaceDiagnosticId(candidate?.parentSurfaceId),
      presentationScope: sanitizeSurfaceDiagnosticEnum(candidate?.presentationScope),
      hasOwnerChatId: typeof candidate?.ownerChatId === "string" && Boolean(candidate.ownerChatId.trim()),
      ...details,
      occurrenceCount: 1,
    };
  }

  function flushRegistrationDiagnostic(key: string, resolution: NonNullable<SurfaceRegistrationDiagnostic["resolution"]>): void {
    const pending = pendingRegistrationDiagnostics.get(key);
    if (!pending)
      return;
    pendingRegistrationDiagnostics.delete(key);
    if (pending.timer)
      clearTimeout(pending.timer);
    if (pending.count <= 1)
      return;
    reportRegistrationDiagnostic({
      ...pending.diagnostic,
      event: "surface-registration-rejection-summary",
      occurrenceCount: pending.count,
      resolution,
    });
  }

  function scheduleRegistrationDiagnosticFlush(key: string): void {
    const pending = pendingRegistrationDiagnostics.get(key);
    if (!pending)
      return;
    if (pending.timer)
      clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      flushRegistrationDiagnostic(key, "retry_window_expired");
    }, registrationDiagnosticDedupWindowMs);
    pending.timer.unref?.();
  }

  function rejectSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">): EmbeddedCdpSurfaceRegistrationResult {
    const diagnostic = createRegistrationDiagnostic(input, ownerWebContentsId, reason, details);
    const key = `${diagnostic.registrationId}\u0000${reason}`;
    const pending = pendingRegistrationDiagnostics.get(key);
    if (pending) {
      pending.count += 1;
      pending.diagnostic = diagnostic;
      scheduleRegistrationDiagnosticFlush(key);
      return {
        ok: false,
        reason: reason === "invalid_registration"
          ? "invalid_registration"
          : reason === "main_chat_owner_transition_rejected"
            ? "route_not_aligned"
            : "ownership_conflict",
      };
    }
    pendingRegistrationDiagnostics.set(key, { diagnostic, count: 1, timer: null });
    reportRegistrationDiagnostic(diagnostic);
    scheduleRegistrationDiagnosticFlush(key);
    return {
      ok: false,
      reason: reason === "invalid_registration"
        ? "invalid_registration"
        : reason === "main_chat_owner_transition_rejected"
          ? "route_not_aligned"
          : "ownership_conflict",
    };
  }

  function settleRegistrationDiagnostics(input: EmbeddedCdpSurfaceRegistration): void {
    const registrationId = sanitizeSurfaceDiagnosticId(input.registrationId);
    const surfaceId = sanitizeSurfaceDiagnosticId(input.surfaceId);
    for (const [key, pending] of pendingRegistrationDiagnostics) {
      if (pending.diagnostic.registrationId === registrationId) {
        flushRegistrationDiagnostic(key, "registered");
      }
      else if (pending.diagnostic.surfaceId === surfaceId) {
        flushRegistrationDiagnostic(key, "replaced");
      }
    }
  }

  return { summarizeRegisteredSurface, rejectSurfaceRegistration, settleRegistrationDiagnostics };
}
