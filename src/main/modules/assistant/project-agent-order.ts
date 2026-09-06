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

export function createProjectAgentOrderPlan(input: {
  requestedProjectAgentKeys: unknown;
  currentProjectAgentKeys: unknown;
  fullAgentKeys: unknown;
}): ProjectAgentOrderPlan {
  const requestedProjectAgentKeys = validateProjectAgentOrderRequestKeys(
    input.requestedProjectAgentKeys,
  );
  const currentProjectAgentKeys = normalizeCatalogKeys(
    input.currentProjectAgentKeys,
    "currentProjectAgentKeys",
  );
  const fullAgentKeys = normalizeCatalogKeys(input.fullAgentKeys, "fullAgentKeys");
  const currentProjectKeySet = new Set(currentProjectAgentKeys);
  const fullAgentKeySet = new Set(fullAgentKeys);

  for (const key of requestedProjectAgentKeys) {
    if (!currentProjectKeySet.has(key)) {
      throw new Error(`project agent is no longer available: ${key}`);
    }
  }
  for (const key of currentProjectAgentKeys) {
    if (!fullAgentKeySet.has(key)) {
      throw new Error(`project agent is missing from the valid Agent catalog: ${key}`);
    }
  }

  const requestedKeySet = new Set(requestedProjectAgentKeys);
  const projectAgentKeys = [
    ...requestedProjectAgentKeys,
    ...currentProjectAgentKeys.filter((key) => !requestedKeySet.has(key)),
  ];
  let projectIndex = 0;
  const nextFullAgentKeys = fullAgentKeys.map((key) => {
    if (!currentProjectKeySet.has(key)) {
      return key;
    }
    const nextProjectKey = projectAgentKeys[projectIndex];
    projectIndex += 1;
    return nextProjectKey;
  });

  if (projectIndex !== projectAgentKeys.length) {
    throw new Error("project agent slots do not match the current catalog");
  }
  return {
    projectAgentKeys,
    fullAgentKeys: nextFullAgentKeys,
  };
}

export const __testInternals = {
  MAX_PROJECT_ORDER_ITEMS,
};
