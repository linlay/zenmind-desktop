import fs from "node:fs";
import { createHash } from "node:crypto";
import { prepareAgentEngineDelivery, readCurrentAgentEngineDelivery, revokeAgentEngineDeliveries, type PluginEngineHost, type PluginInstallSource } from "./agent-engines";
import path from "node:path";
import type { App } from "electron";
import { normalizeManifest, readManifestFile } from "../../support/manifest/manifest-utils";
import { clearServices, getService, registerService, unregisterService } from "../services";
import { fixShellScriptPermissions } from "../services";
import type { ServicesFacade } from "../services";
import type { WebappManager } from "../webs";
import { extractArchiveToDir, inspectZipArchiveSafety } from "../../support/archive/archive-utils";
import { getPluginsRoot, getServiceConfigRoot, getServiceStateRoot } from "../../infrastructure/filesystem/user-paths";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { removePluginResources } from "./resources";
import { t } from "../../support/i18n/main-i18n";

const SUPPORTED_PLUGIN_API_VERSION = 1;

function readManifest(pluginDir: string) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return readManifestFile(manifestPath);
  } catch {
    return null;
  }
}

function readManifestKind(manifest: unknown) {
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as { kind?: unknown }).kind
    : undefined;
}

function preserveExistingConfigFiles(targetDir: string, relativePaths: string[]) {
  const preserved = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(targetDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    preserved.set(relativePath, fs.readFileSync(absolutePath, "utf8"));
  }
  return preserved;
}

function restorePreservedConfigFiles(targetDir: string, preserved: Map<string, string>) {
  for (const [relativePath, content] of preserved) {
    const absolutePath = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
}

function preservePluginResourceOwnership(stateDir: string) {
  const ownershipPath = path.join(stateDir, "plugin-resources.json");
  if (!fs.existsSync(ownershipPath)) {
    return "";
  }
  return fs.readFileSync(ownershipPath, "utf8");
}

function restorePluginResourceOwnership(stateDir: string, content: string) {
  if (!content) {
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "plugin-resources.json"), content, "utf8");
}

export function loadInstalledPlugins(app: App) {
  const root = getPluginsRoot(app);
  clearServices("plugin");
  if (!fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const pluginRoot = path.join(root, entry.name);
    try {
      const current = readCurrentAgentEngineDelivery(app, entry.name);
      if (current) {
        registerService(current.manifest, { defaultKind: "plugin" });
        continue;
      }
    } catch (error) {
      console.warn(`Skipping invalid engine delivery for ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const candidateDirs = fs.readdirSync(pluginRoot, { withFileTypes: true })
      .filter((versionEntry) => versionEntry.isDirectory())
      .map((versionEntry) => path.join(pluginRoot, versionEntry.name))
      .sort((left, right) => left.localeCompare(right));
    for (const candidateDir of candidateDirs) {
      const manifest = readManifest(candidateDir);
      if (manifest && readManifestKind(manifest) !== "builtin" && !manifest.resources?.agentEngines?.length) {
        try {
          registerService(manifest, { defaultKind: "plugin" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Skipping invalid installed plugin manifest at ${candidateDir}: ${message}`);
        }
      }
    }
  }
}

function getLatestPluginVersionDir(pluginRoot: string) {
  if (!fs.existsSync(pluginRoot)) {
    return "";
  }
  return fs.readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0] ?? "";
}

export function getPluginInstallDir(app: App, pluginId: string, version?: string) {
  const root = getPluginsRoot(app);
  const pluginRoot = path.join(root, pluginId);
  const resolvedVersion = version?.trim() || (() => {
    try {
      return getService(pluginId).version;
    } catch {
      return getLatestPluginVersionDir(pluginRoot);
    }
  })();
  return resolvedVersion ? path.join(pluginRoot, resolvedVersion) : pluginRoot;
}

function ensurePluginArchivePath(archivePath: string) {
  if (!archivePath.toLowerCase().endsWith(".zip")) {
    throw new Error(t("plugin.archiveZipOnly"));
  }
}

function isSafePathSegment(value: string) {
  return Boolean(value) && value !== "." && value !== ".." && !path.isAbsolute(value) && !/[\\/]/u.test(value);
}

function currentManifestPlatform() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return { os, arch };
}

function isUniversalPlatformValue(value: string) {
  return value === "" || value === "any" || value === "all" || value === "universal" || value === "*";
}

function assertPathInsidePlugin(pluginDir: string, relativePath: string) {
  const root = path.resolve(pluginDir);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(t("plugin.manifestUnsafePath", { path: relativePath }));
  }
  return candidate;
}

function assertPluginBundleImportable(pluginDir: string, topLevelDir: string, definition: ReturnType<typeof normalizeManifest>) {
  if (definition.pluginApiVersion !== (definition.resources.agentEngines.length ? 2 : SUPPORTED_PLUGIN_API_VERSION)) {
    throw new Error(t("plugin.apiVersionUnsupported", {
      actual: String(definition.pluginApiVersion || "missing"),
      expected: String(SUPPORTED_PLUGIN_API_VERSION)
    }));
  }
  if (!isSafePathSegment(definition.id) || !isSafePathSegment(definition.version)) {
    throw new Error(t("plugin.manifestUnsafeIdentity"));
  }
  if (definition.bundleTopLevelDir !== topLevelDir) {
    throw new Error(t("plugin.bundleRootMismatch", {
      actual: topLevelDir,
      expected: definition.bundleTopLevelDir
    }));
  }

  if (definition.platform) {
    const current = currentManifestPlatform();
    const osMatches = isUniversalPlatformValue(definition.platform.os) || definition.platform.os === current.os;
    const archMatches = isUniversalPlatformValue(definition.platform.arch) || definition.platform.arch === current.arch;
    if (!osMatches || !archMatches) {
      throw new Error(t("plugin.platformMismatch", {
        actual: `${definition.platform.os || "any"}/${definition.platform.arch || "any"}`,
        expected: `${current.os}/${current.arch}`
      }));
    }
  }

  for (const requiredPath of definition.runtime.requiredPaths) {
    const absolutePath = assertPathInsidePlugin(pluginDir, requiredPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(t("plugin.requiredPathMissing", { path: requiredPath }));
    }
  }
}

export async function installPluginFromArchive(
  app: App,
  archivePath: string,
  initializeService: ServicesFacade["initializeService"],
  engineHost?: PluginEngineHost,
  source?: PluginInstallSource
) {
  ensurePluginArchivePath(archivePath);

  const root = getPluginsRoot(app);
  fs.mkdirSync(root, { recursive: true });

  // Extract to temp dir first to read manifest
  const tmpDir = fs.mkdtempSync(path.join(root, ".tmp-"));
  let delivery: Awaited<ReturnType<typeof prepareAgentEngineDelivery>> | undefined;
  let rollback: (() => void) | undefined;
  let committed = false;
  try {
    // Inspect the exact snapshot that will be extracted; do not trust a mutable
    // download path or let Windows tar see unvalidated ZIP paths.
    const snapshot = path.join(tmpDir, "archive.zip");
    const archiveStat = fs.statSync(archivePath);
    if (!archiveStat.isFile() || archiveStat.size > 512 * 1024 * 1024) throw new Error("Plugin archive exceeds the size limit");
    fs.copyFileSync(archivePath, snapshot);
    const inspected = await inspectZipArchiveSafety(snapshot, { maxEntries: 100_000, maxFileBytes: 512 * 1024 * 1024, maxExpandedBytes: 2 * 1024 * 1024 * 1024 });
    for (const entry of inspected.entries) {
      if (entry.split("/").some((part: string) => /[<>:"|?*\0]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error("Unsafe portable plugin ZIP path");
    }
    const archiveDigest = `sha256:${createHash("sha256").update(fs.readFileSync(snapshot)).digest("hex")}`;
    const contents = path.join(tmpDir, "contents");
    await extractArchiveToDir(snapshot, contents);
    const entries = fs.readdirSync(contents);
    if (entries.length !== 1) {
      throw new Error(t("plugin.archiveSingleRootRequired"));
    }
    const extractedDir = path.join(contents, entries[0]);
    const manifest = readManifest(extractedDir);
    if (!manifest) {
      throw new Error(t("plugin.manifestMissing"));
    }
    if (readManifestKind(manifest) === "builtin") {
      throw new Error(t("plugin.builtinManifestRejected"));
    }
    const definition = normalizeManifest(manifest, { defaultKind: "plugin" });
    assertPluginBundleImportable(extractedDir, entries[0], definition);
    if (source && (source.kind !== "market" || !source.authorizationRef || source.archiveDigest !== archiveDigest || source.pluginId !== definition.id || source.pluginVersion !== definition.version)) {
      throw new Error("Plugin source identity/version or archive digest mismatch");
    }
    if (definition.serviceMode === "resource" && typeof initializeService !== "function") {
      throw new Error("Plugin initialization must be supplied by the application composition root.");
    }

    if (definition.resources.agentEngines.length) {
      delivery = await prepareAgentEngineDelivery(app, definition, extractedDir, archiveDigest, engineHost, source);
    }
    const targetDir = getPluginInstallDir(app, manifest.id, definition.version);
    const configDir = getServiceConfigRoot(app, manifest.id, "plugin");
    const stateDir = getServiceStateRoot(app, manifest.id, "plugin");
    if (delivery) {
      let previousManifest: ReturnType<typeof readManifest> = null;
      try {
        const previous = getService(definition.id);
        previousManifest = readCurrentAgentEngineDelivery(app, previous.id)?.manifest ?? readManifest(getPluginInstallDir(app, previous.id, previous.version));
        if (!previousManifest) throw new Error("Previous engine installation manifest is unreadable");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("unknown service id:")) throw error;
      }
      const backups = [targetDir, configDir, stateDir].map((directory, index) => {
        const backup = path.join(tmpDir, "rollback", String(index));
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Engine installation/state root must be a real directory");
        if (stat) fs.cpSync(directory, backup, { recursive: true });
        return { directory, backup, existed: Boolean(stat) };
      });
      rollback = () => {
        for (const saved of backups) {
          fs.rmSync(saved.directory, { recursive: true, force: true });
          if (saved.existed) fs.cpSync(saved.backup, saved.directory, { recursive: true });
        }
        if (previousManifest) registerService(previousManifest, { defaultKind: "plugin" });
        else unregisterService(definition.id);
      };
    }
    const preservedConfigFiles = preserveExistingConfigFiles(
      configDir,
      definition.configFiles.map((configFile) => configFile.relativePath)
    );
    const preservedPluginResourceOwnership = preservePluginResourceOwnership(stateDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(extractedDir, targetDir, { recursive: true });
    restorePreservedConfigFiles(configDir, preservedConfigFiles);
    restorePluginResourceOwnership(stateDir, preservedPluginResourceOwnership);
    fs.rmSync(path.join(targetDir, `.${STORAGE_NAMESPACE}`), { recursive: true, force: true });
    fixShellScriptPermissions(targetDir);
    registerService(manifest, { defaultKind: "plugin" });
    if (definition.serviceMode === "resource") {
      const initialization = await initializeService(app, manifest.id);
      if (initialization.ok) { delivery?.commit(); committed = true; }
      return {
        ok: initialization.ok,
        message: initialization.ok ? t("plugin.importedInitialized", { name: manifest.name }) : initialization.message,
        serviceId: manifest.id
      };
    }
    return { ok: true, message: t("plugin.importedNeedsInit", { name: manifest.name }), serviceId: manifest.id };
  } finally {
    if (rollback && !committed) {
      try { rollback(); }
      catch (error) { throw new Error(`Engine rollback failed; recovery files retained at ${tmpDir}`, { cause: error }); }
    }
    try {
      delivery?.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      if (!committed) throw error;
      console.warn(`Plugin installation committed; staging cleanup retained at ${tmpDir}`, error);
    }
  }
}

export async function uninstallPlugin(
  app: App,
  serviceId: string,
  services: Pick<ServicesFacade, "getServiceState" | "stopService">,
  webapps: WebappManager,
  engineHost?: PluginEngineHost
) {
  // Verify it's a plugin, not builtin
  const def = getService(serviceId);
  if (def.kind !== "plugin") {
    return { ok: false, message: t("service.builtinNotUninstallable") };
  }
  const removeDelivery = def.resources.agentEngines.length ? await revokeAgentEngineDeliveries(app, def, engineHost) : undefined;
  const currentState = await services.getServiceState(app, serviceId);
  if (currentState.status === "running") {
    const stopped = await services.stopService(app, serviceId);
    if (!stopped.ok) return { ok: false, message: stopped.message };
  }
  await removePluginResources(app, def, webapps);
  removeDelivery?.();
  const dir = getPluginInstallDir(app, serviceId, def.version);
  fs.rmSync(def.resources.agentEngines.length ? path.dirname(dir) : dir, { recursive: true, force: true });
  unregisterService(serviceId);
  return { ok: true, message: t("plugin.uninstall.done", { name: def.name }) };
}
