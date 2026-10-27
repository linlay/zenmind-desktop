const MAX_PROJECT_ORDER_ITEMS = 500;

export type ProjectAgentOrderPlan = {
  projectAgentKeys: string[];
  fullAgentKeys: string[];
};

function normalizeKeys(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (value.length > MAX_PROJECT_ORDER_ITEMS) {
    throw new Error(`${field} exceeds the supported item limit`);
  }
  const keys = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (keys.some((key) => !key)) {
    throw new Error(`${field} contains an empty agent key`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${field} contains duplicate agent keys`);
  }
  return keys;
}

export function validateProjectAgentOrderRequestKeys(value: unknown) {
  return normalizeKeys(value, "agentKeys");
}

function normalizeCatalogKeys(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const keys = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new Error(`${field} contains invalid agent keys`);
  }
  return keys;
}

// Both views reorder a projection of the same valid Agent catalog.
function createSubsetOrderPlan(requested: unknown, current: unknown, full: unknown, label: string) {
  const requestedKeys = validateProjectAgentOrderRequestKeys(requested);
  const currentKeys = normalizeCatalogKeys(current, "currentAgentKeys");
  const fullKeys = normalizeCatalogKeys(full, "fullAgentKeys");
  const currentSet = new Set(currentKeys);
  const fullSet = new Set(fullKeys);
  for (const key of requestedKeys) {
    if (!currentSet.has(key)) throw new Error(`${label} agent is no longer available: ${key}`);
  }
  for (const key of currentKeys) {
    if (!fullSet.has(key)) throw new Error(`${label} agent is missing from the valid Agent catalog: ${key}`);
  }
  const requestedSet = new Set(requestedKeys);
  const agentKeys = [...requestedKeys, ...currentKeys.filter(key => !requestedSet.has(key))];
  let index = 0;
  const fullAgentKeys = fullKeys.map(key => currentSet.has(key) ? agentKeys[index++] : key);
  if (index !== agentKeys.length) throw new Error(`${label} agent slots do not match the current catalog`);
  return { agentKeys, fullAgentKeys };
}

export function createProjectAgentOrderPlan(input: {
  requestedProjectAgentKeys: unknown;
  currentProjectAgentKeys: unknown;
  fullAgentKeys: unknown;
}): ProjectAgentOrderPlan {
  const plan = createSubsetOrderPlan(input.requestedProjectAgentKeys, input.currentProjectAgentKeys, input.fullAgentKeys, "project");
  return { projectAgentKeys: plan.agentKeys, fullAgentKeys: plan.fullAgentKeys };
}

export function createNavigationAgentOrderPlan(input: {
  requestedAgentKeys: unknown;
  currentAgentKeys: unknown;
  fullAgentKeys: unknown;
}) {
  return createSubsetOrderPlan(input.requestedAgentKeys, input.currentAgentKeys, input.fullAgentKeys, "navigation");
}

export const __testInternals = {
  MAX_PROJECT_ORDER_ITEMS,
};
