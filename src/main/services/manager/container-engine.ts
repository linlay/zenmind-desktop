import path from "node:path";
import {
  __containerEngineTestInternals,
  clearContainerEngineProbeCache as clearSharedContainerEngineProbeCache,
  probeContainerEngines as probeSharedContainerEngines,
  type ContainerEngineProbeResult
} from "../../container-engine";
import { beginStartupTiming } from "../../startup-timing";

let containerEngineDiagOnce = false;

type ContainerEngineProbeOptions = {
  cache?: boolean;
};

export function clearContainerEngineProbeCache() {
  clearSharedContainerEngineProbeCache();
}

export async function probeContainerEngines(
  options: ContainerEngineProbeOptions = {}
): Promise<ContainerEngineProbeResult> {
  const timing = beginStartupTiming("containerEngineAvailable", {}, { log: false });
  let selectedEngine = "";
  try {
    const result = await probeSharedContainerEngines({
      cache: options.cache !== false
    });
    selectedEngine = result.engine;

    if (!containerEngineDiagOnce) {
      containerEngineDiagOnce = true;
      const pathPreview = (process.env.PATH ?? "")
        .split(path.delimiter)
        .slice(0, 8)
        .join(" | ");
      console.log(`[container-engine] PATH(top 8): ${pathPreview}`);
      for (const probe of result.probes) {
        const detail = probe.message.split(/\r?\n/u)[0] ?? "";
        const log = probe.failure === "unsafe-location" ? console.warn : console.log;
        log(
          `[container-engine] ${probe.engine} version probe -> command=${probe.command || "missing"} ` +
          `installed=${probe.installed} reachable=${probe.reachable} elapsed=${probe.elapsedMs}ms ` +
          `failure=${probe.failure ?? "none"} detail=${detail}`
        );
      }
    }

    return result;
  } finally {
    timing.end({ engine: selectedEngine || "none" });
  }
}

export async function containerEngineAvailable(options: ContainerEngineProbeOptions = {}) {
  return (await probeContainerEngines(options)).engine;
}

export const __testInternals = {
  setProbeOverrideForTests: __containerEngineTestInternals.setProbeOverrideForTests
};
