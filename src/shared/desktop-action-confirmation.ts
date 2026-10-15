import { DESKTOP_ACTION_DEFINITIONS, getDesktopActionConfirmation } from "./desktop-actions";

type ConfirmableActionDefinition = Extract<
  typeof DESKTOP_ACTION_DEFINITIONS[number],
  { confirmation: "external" | "always" }
>;

export const DESKTOP_CONFIRMABLE_ACTIONS = DESKTOP_ACTION_DEFINITIONS.filter(
  (definition): definition is ConfirmableActionDefinition => getDesktopActionConfirmation(definition) !== "none"
);

export type DesktopConfirmableActionName = ConfirmableActionDefinition["name"];

// Persist only exact, registered action names. A saved selection must not exempt future actions.
export function normalizeDesktopActionConfirmationExemptActions(value: unknown): DesktopConfirmableActionName[] {
  const selected = new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return DESKTOP_CONFIRMABLE_ACTIONS.filter(({ name }) => selected.has(name)).map(({ name }) => name);
}

export const DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 120;
export const MAX_CONFIRMATION_TIMEOUT_SECONDS = 600;

export function normalizeConfirmationTimeoutSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CONFIRMATION_TIMEOUT_SECONDS, Math.max(1, Math.trunc(value)))
    : DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
}
