import { type Manifest } from "../../../shared/contracts";
import { NormalizeManifestOptions, ServiceDefinition } from "./manifest-types";
import { asObject, asOptionalString, asNumber, asString, asStringArray } from "./manifest-values";
import { assertNoPluginManifestLegacyFields } from "./manifest-plugin-policy";
import {
  resolveServiceMode,
  resolveScripts,
  applyCoreServiceRuntimeOverride,
  resolveRuntime,
  resolveFrontend,
  resolveWeb,
  isServiceKind,
  resolveApi,
  resolveBackend,
  resolveServiceConfigFiles
} from "./manifest-service-fields";
import { resolvePluginSettings, resolvePluginHooks, resolvePluginBridge, resolvePluginResources } from "./manifest-plugin-fields";
import { resolveDesktop } from "./manifest-desktop";
import { applyCoreServiceWebOverride } from "./manifest-service-policy";
import { resolveCommand } from "./manifest-commands";

export function normalizeManifest(manifest: Manifest, options: NormalizeManifestOptions = {}): ServiceDefinition {
  const raw = asObject(manifest);
  assertNoPluginManifestLegacyFields(raw, options);
  const id = asOptionalString(raw.id);
  if (!id) {
    throw new Error("manifest id is required");
  }

  const serviceMode = resolveServiceMode(raw);
  const scripts = resolveScripts(raw, serviceMode);
  const runtime = applyCoreServiceRuntimeOverride(id, resolveRuntime(raw));
  const frontend = resolveFrontend(raw);
  const settings = resolvePluginSettings(raw);
  const desktop = resolveDesktop(raw, options, id, frontend, settings);
  const resolvedWeb = resolveWeb(raw);
  const web = applyCoreServiceWebOverride(id, resolvedWeb, options);
  const pluginApiVersion = asNumber(raw.pluginApiVersion) ?? 0;

  return {
    pluginApiVersion,
    id,
    name: asOptionalString(raw.name) ?? id,
    kind: isServiceKind(raw.kind) ? raw.kind : (options.defaultKind ?? "plugin"),
    serviceMode,
    version: asOptionalString(raw.version) ?? "",
    description: asOptionalString(raw.description) ?? "",
    platform:
      raw.platform === undefined
        ? undefined
        : {
            os: asString(asObject(raw.platform).os),
            arch: asString(asObject(raw.platform).arch)
          },
    frontend,
    frontendMode: frontend.mode,
    api: resolveApi(raw),
    backend: resolveBackend(raw),
    scripts,
    configFiles: resolveServiceConfigFiles(raw, id),
    runtime,
    web,
    prerequisites: asStringArray(raw.prerequisites),
    desktop: {
      ...desktop,
      envBindings: desktop.envBindings
    },
    hooks: resolvePluginHooks(raw),
    bridge: resolvePluginBridge(raw),
    resources: resolvePluginResources(raw),
    settings,
    assetFileName: desktop.assetFileName ?? "",
    bundleTopLevelDir: desktop.bundleTopLevelDir,
    startCommand: resolveCommand(scripts.start) ?? [],
    stopCommand: resolveCommand(scripts.stop) ?? [],
    deployCommand: resolveCommand(scripts.deploy),
    importTargets: []
  };
}
