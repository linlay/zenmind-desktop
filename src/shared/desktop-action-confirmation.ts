import { DESKTOP_ACTION_DEFINITIONS, getDesktopActionConfirmation } from "./desktop-actions";

type ExemptibleActionDefinition = Extract<
  typeof DESKTOP_ACTION_DEFINITIONS[number],
  { confirmation: "always" }
>;

export const DESKTOP_EXEMPTIBLE_ACTIONS = DESKTOP_ACTION_DEFINITIONS.filter(
  (definition): definition is ExemptibleActionDefinition => getDesktopActionConfirmation(definition) === "always"
);

export type DesktopExemptibleActionName = ExemptibleActionDefinition["name"];

// Only the always tier is individually exemptible. Drop old external-tier selections as well as wildcards.
export function normalizeDesktopActionConfirmationExemptActions(value: unknown): DesktopExemptibleActionName[] {
  const selected = new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return DESKTOP_EXEMPTIBLE_ACTIONS.filter(({ name }) => selected.has(name)).map(({ name }) => name);
}

export const DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 120;
export const MAX_CONFIRMATION_TIMEOUT_SECONDS = 600;

export function normalizeConfirmationTimeoutSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CONFIRMATION_TIMEOUT_SECONDS, Math.max(1, Math.trunc(value)))
    : DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
}
