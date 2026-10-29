import type {
  ServiceCommandResult,
  ServiceState,
} from "../../../shared/contracts";
import type { ServiceDefinition } from "../../support/manifest/manifest-utils";
import type { ShareServicePort } from "../../support/share-ports";
import {
  publishPluginBridgeServiceState,
  waitForPluginShareEndpoint,
} from "./bridge";

/** Installed descriptors belong to Plugins; live endpoints belong to its Bridge. */
export function createPluginShareReceivers(options: {
  shares: Pick<ShareServicePort, "registerReceiver">;
  getService(id: string): ServiceDefinition;
  getState(id: string): Promise<ServiceState>;
  start(id: string): Promise<ServiceCommandResult>;
  onError(id: string): void;
}) {
  const registrations = new Map<
    string,
    { signature: string; unregister(): void }
  >();
  let disposed = false;
  function signature(service: ServiceDefinition) {
    return JSON.stringify([service.version, service.shareReceiver]);
  }
  return {
    sync(services: readonly ServiceDefinition[]) {
      if (disposed) return;
      const declared = new Map(
        services
          .filter(
            (service) => service.kind === "plugin" && service.shareReceiver,
          )
          .map((service) => [service.id, service]),
      );
      for (const [id, entry] of registrations) {
        if (
          !declared.has(id) ||
          signature(declared.get(id)!) !== entry.signature
        ) {
          entry.unregister();
          registrations.delete(id);
        }
      }
      for (const [id, service] of declared) {
        if (registrations.has(id)) continue;
        const expected = signature(service);
        try {
          const unregister = options.shares.registerReceiver({
            receiverId: "plugin." + id,
            owner: { type: "plugin", id },
            contextVersions: service.shareReceiver!.contextVersions,
            activate: async ({ signal }) => {
              const current = () =>
                !disposed &&
                !signal.aborted &&
                signature(options.getService(id)) === expected;
              if (!current()) throw new Error("Plugin share receiver changed");
              let state = await options.getState(id);
              if (
                !current() ||
                !state.installed ||
                state.serviceMode !== "service" ||
                !["running", "stopped"].includes(state.status)
              )
                throw new Error("Plugin cannot be activated");
              if (state.status === "stopped") {
                const result = await options.start(id);
                if (!result.ok) throw new Error("Plugin activation failed");
                state = result.service;
              }
              if (!current() || state.status !== "running")
                throw new Error("Plugin share activation ended");
              publishPluginBridgeServiceState(state);
              return waitForPluginShareEndpoint(id, signal);
            },
          });
          registrations.set(id, { signature: expected, unregister });
        } catch {
          options.onError(id);
        }
      }
    },
    dispose() {
      disposed = true;
      for (const entry of registrations.values()) entry.unregister();
      registrations.clear();
    },
  };
}
