export const DESKTOP_DISPLAY_DEFAULT_DURATION_MS = 8_000;
export const DESKTOP_DISPLAY_MIN_DURATION_MS = 1_000;
export const DESKTOP_DISPLAY_MAX_DURATION_MS = 30_000;

export type DesktopDisplayEffect = "fireworks" | "snowfall" | "nationalDay";

export type DesktopDisplayPayload = {
  kind: "effect";
  effect: DesktopDisplayEffect;
  durationMs: number;
};

export type DesktopDisplayValidationResult =
  | { ok: true; value: DesktopDisplayPayload }
  | { ok: false; reason: "unexpected_fields" | "invalid_kind" | "invalid_effect" | "invalid_duration" };

const DISPLAY_FIELDS = new Set(["kind", "effect", "durationMs"]);
const DISPLAY_EFFECTS = new Set<DesktopDisplayEffect>(["fireworks", "snowfall", "nationalDay"]);

export function validateDesktopDisplayPayload(input: Record<string, unknown>): DesktopDisplayValidationResult {
  const unexpected = Object.keys(input).filter((key) => !DISPLAY_FIELDS.has(key));
  if (unexpected.length > 0) {
    return { ok: false, reason: "unexpected_fields" };
  }
  if (input.kind !== "effect") {
    return { ok: false, reason: "invalid_kind" };
  }
  if (typeof input.effect !== "string" || !DISPLAY_EFFECTS.has(input.effect as DesktopDisplayEffect)) {
    return { ok: false, reason: "invalid_effect" };
  }
  const durationMs = input.durationMs === undefined
    ? DESKTOP_DISPLAY_DEFAULT_DURATION_MS
    : input.durationMs;
  if (
    typeof durationMs !== "number" ||
    !Number.isInteger(durationMs) ||
    durationMs < DESKTOP_DISPLAY_MIN_DURATION_MS ||
    durationMs > DESKTOP_DISPLAY_MAX_DURATION_MS
  ) {
    return { ok: false, reason: "invalid_duration" };
  }
  return {
    ok: true,
    value: { kind: "effect", effect: input.effect as DesktopDisplayEffect, durationMs },
  };
}
