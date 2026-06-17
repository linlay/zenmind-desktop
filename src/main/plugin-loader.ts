import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { normalizeManifest, readManifestFile } from "./manifest-utils";
import { clearServices, getService, registerService, unregisterService } from "./services/service-registry";
import { fixShellScriptPermissions, initializeService } from "./services/manager";
import { extractArchiveToDir } from "./archive-utils";
import { getPluginsRoot, getServiceConfigRoot, getServiceStateRoot } from "./user-paths";
import { STORAGE_NAMESPACE } from "../shared/generated/brand";
import { removePluginResources } from "./plugin-resources";
import { t } from "./i18n/main-i18n";

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
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginRoot = path.join(root, entry.name);
    const candidateDirs = fs.readdirSync(pluginRoot, { withFileTypes: true })
      .filter((versionEntry) => versionEntry.isDirectory())
      .map((versionEntry) => path.join(pluginRoot, versionEntry.name))
      .sort((left, right) => left.localeCompare(right));
    for (const candidateDir of candidateDirs) {
      const manifest = readManifest(candidateDir);
      if (manifest && readManifestKind(manifest) !== "builtin") {
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

export async function installPluginFromArchive(app: App, archivePath: string) {
  ensurePluginArchivePath(archivePath);

  const root = getPluginsRoot(app);
  fs.mkdirSync(root, { recursive: true });

  // Extract to temp dir first to read manifest
  const tmpDir = fs.mkdtempSync(path.join(root, ".tmp-"));
  try {
    await extractArchiveToDir(archivePath, tmpDir);
    const entries = fs.readdirSync(tmpDir);
    if (entries.length !== 1) {
      throw new Error(t("plugin.archiveSingleRootRequired"));
    }
    const extractedDir = path.join(tmpDir, entries[0]);
    const manifest = readManifest(extractedDir);
    if (!manifest) {
      throw new Error(t("plugin.manifestMissing"));
    }
    if (readManifestKind(manifest) === "builtin") {
      throw new Error(t("plugin.builtinManifestRejected"));
    }
    const definition = normalizeManifest(manifest, { defaultKind: "plugin" });

    const targetDir = getPluginInstallDir(app, manifest.id, definition.version);
    const configDir = getServiceConfigRoot(app, manifest.id, "plugin");
    const stateDir = getServiceStateRoot(app, manifest.id, "plugin");
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
      return {
        ok: initialization.ok,
        message: initialization.ok ? t("plugin.importedInitialized", { name: manifest.name }) : initialization.message,
        serviceId: manifest.id
      };
    }
    return { ok: true, message: t("plugin.importedNeedsInit", { name: manifest.name }), serviceId: manifest.id };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function uninstallPlugin(app: App, serviceId: string) {
  // Verify it's a plugin, not builtin
  const def = getService(serviceId);
  if (def.kind !== "plugin") {
    return { ok: false, message: t("service.builtinNotUninstallable") };
  }
  const { getServiceState, stopService } = await import("./services/manager");
  const currentState = await getServiceState(app, serviceId);
  if (currentState.status === "running") {
    await stopService(app, serviceId);
  }
  await removePluginResources(app, def);
  const dir = getPluginInstallDir(app, serviceId, def.version);
  fs.rmSync(dir, { recursive: true, force: true });
  unregisterService(serviceId);
  return { ok: true, message: t("plugin.uninstall.done", { name: def.name }) };
}
