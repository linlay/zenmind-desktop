const WEBAPP_ASSISTANT_ACTIONS = Object.freeze([
  "desktop.assistant.complete",
  "desktop.assistant.translate"
] as const);

export const WEBAPP_CAPABILITY_POLICY = Object.freeze({
  backendActionToken: WEBAPP_ASSISTANT_ACTIONS,
  localPageGateway: Object.freeze([
    ...WEBAPP_ASSISTANT_ACTIONS,
    "desktop.web.webapp.selectDirectory"
  ] as const)
});

export type WebappCapabilityScope = keyof typeof WEBAPP_CAPABILITY_POLICY;

export function isWebappActionAllowed(scope: WebappCapabilityScope, action: string) {
  return WEBAPP_CAPABILITY_POLICY[scope].some((allowedAction) => allowedAction === action);
}
