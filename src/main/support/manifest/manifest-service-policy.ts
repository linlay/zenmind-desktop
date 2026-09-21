import { NormalizeManifestOptions } from "./manifest-types";
import { type ManifestWeb } from "../../../shared/contracts";

export type CoreServicePortOverride = {
  defaultPort: number;
};

export const sharedCoreServicePortOverrides: Record<string, CoreServicePortOverride> = {
  "agent-container-hub": {
    defaultPort: 7079
  },
  "agent-platform": {
    defaultPort: 7078
  },
  "agent-webclient": {
    defaultPort: 7080
  },
  "identity-center": {
    defaultPort: 7076
  }
};

export const testCoreServicePortOffsets: Record<string, number> = {
  "agent-webclient": 0,
  "agent-platform": 1,
  "identity-center": 2,
  "agent-container-hub": 3
};

export function getTestCoreServicePortBase() {
  const raw = process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE?.trim() ?? "";
  if (!raw || !/^\d+$/u.test(raw)) {
    return null;
  }

  const portBase = Number.parseInt(raw, 10);
  return Number.isInteger(portBase) && portBase > 0 && portBase + 3 <= 65535
    ? portBase
    : null;
}

export function applyTestCoreServicePortBase(
  overrides: Record<string, CoreServicePortOverride>,
  portBase: number | null
) {
  if (!portBase) {
    return overrides;
  }

  return Object.fromEntries(Object.entries(overrides).map(([serviceId, override]) => {
    const offset = testCoreServicePortOffsets[serviceId];
    return [
      serviceId,
      offset === undefined
        ? override
        : {
            ...override,
            defaultPort: portBase + offset
          }
    ];
  }));
}

export function isValidTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

export function applyConfiguredCoreServiceDefaultPorts(
  overrides: Record<string, CoreServicePortOverride>,
  defaultPorts: Record<string, number> | undefined
) {
  if (!defaultPorts) {
    return overrides;
  }

  return Object.fromEntries(Object.entries(overrides).map(([serviceId, override]) => {
    const defaultPort = defaultPorts[serviceId];
    return [
      serviceId,
      isValidTcpPort(defaultPort)
        ? {
            ...override,
            defaultPort
          }
        : override
    ];
  }));
}

export function getCoreServicePortOverrides(options: NormalizeManifestOptions = {}): Record<string, CoreServicePortOverride> {
  // The defaults are currently shared, but builtin service manifests are platform-specific.
  let overrides: Record<string, CoreServicePortOverride>;
  if (process.platform === "win32") {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  } else if (process.platform === "darwin") {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  } else {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  }

  return applyConfiguredCoreServiceDefaultPorts(overrides, options.coreServiceDefaultPorts);
}

export function getCoreServicePortOverride(serviceId: string, options: NormalizeManifestOptions = {}) {
  return getCoreServicePortOverrides(options)[serviceId];
}

export function applyCoreServiceWebOverride(serviceId: string, web: ManifestWeb, options: NormalizeManifestOptions) {
  const override = getCoreServicePortOverride(serviceId, options);
  if (!override) {
    return web;
  }

  return {
    ...web,
    defaultPort: override.defaultPort
  } satisfies ManifestWeb;
}
