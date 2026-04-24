import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { normalizeManifest, readManifestFile, readManifestFromArchive } from "./manifest-utils";
import { clearServices, getService, registerService, unregisterService } from "./service-registry";
import { fixShellScriptPermissions } from "./service-manager";
import { extractArchiveToDir } from "./archive-utils";
import { getPluginsRoot } from "./user-paths";

const BUNDLED_PLUGINS_ROOT_ENV = "ZENMIND_DESKTOP_BUNDLED_PLUGINS_ROOT";
const BUNDLED_PLUGIN_STATE_DIR = ".zenmind-desktop";
const BUNDLED_PLUGIN_STATE_FILE = "bundled-plugin.json";

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
    const manifest = readManifest(path.join(root, entry.name));
    if (manifest?.kind === "plugin") {
      registerService(manifest, { defaultKind: "plugin" });
    }
  }
}

export function getPluginInstallDir(app: App, pluginId: string) {
  return path.join(getPluginsRoot(app), pluginId);
}

export function getBundledPluginsRoot(app: App) {
  if (process.env[BUNDLED_PLUGINS_ROOT_ENV]) {
    return process.env[BUNDLED_PLUGINS_ROOT_ENV];
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "plugins")
    : path.join(process.cwd(), "build", "resources", "plugins");
}

function listBundledPluginArchives(root: string) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const extension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const archivePaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(root, entry.name);
    for (const asset of fs.readdirSync(pluginDir, { withFileTypes: true })) {
      if (asset.isFile() && asset.name.endsWith(extension)) {
        archivePaths.push(path.join(pluginDir, asset.name));
      }
    }
  }

  return archivePaths.sort((left, right) => left.localeCompare(right));
}

function getArchiveSignature(archivePath: string) {
  const stat = fs.statSync(archivePath);
  return `${path.basename(archivePath)}:${stat.size}:${stat.mtimeMs}`;
}

function getBundledPluginStatePath(pluginDir: string) {
  return path.join(pluginDir, BUNDLED_PLUGIN_STATE_DIR, BUNDLED_PLUGIN_STATE_FILE);
}

function readBundledPluginSignature(pluginDir: string) {
  const statePath = getBundledPluginStatePath(pluginDir);
  if (!fs.existsSync(statePath)) {
    return "";
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { archiveSignature?: unknown };
    return typeof state.archiveSignature === "string" ? state.archiveSignature : "";
  } catch {
    return "";
  }
}

function writeBundledPluginSignature(pluginDir: string, archiveSignature: string) {
  const statePath = getBundledPluginStatePath(pluginDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ archiveSignature, installedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

export async function installBundledPlugins(app: App) {
  const root = getBundledPluginsRoot(app);
  const results = [];
  for (const archivePath of listBundledPluginArchives(root)) {
    const manifest = readManifestFromArchive(archivePath);
    const definition = normalizeManifest(manifest, { defaultKind: "plugin" });
    if (definition.kind !== "plugin") {
      continue;
    }

    const targetDir = getPluginInstallDir(app, definition.id);
    const archiveSignature = getArchiveSignature(archivePath);
    if (readBundledPluginSignature(targetDir) === archiveSignature) {
      continue;
    }

    const result = await installPluginFromArchive(app, archivePath);
    if (result.ok) {
      writeBundledPluginSignature(targetDir, archiveSignature);
    }
    results.push(result);
  }
  return results;
}

export async function installPluginFromArchive(app: App, archivePath: string) {
  const root = getPluginsRoot(app);
  fs.mkdirSync(root, { recursive: true });

  // Extract to temp dir first to read manifest
  const tmpDir = fs.mkdtempSync(path.join(root, ".tmp-"));
  try {
    extractArchiveToDir(archivePath, tmpDir);
    const entries = fs.readdirSync(tmpDir);
    if (entries.length !== 1) {
      throw new Error("插件包应包含单个顶层目录");
    }
    const extractedDir = path.join(tmpDir, entries[0]);
    const manifest = readManifest(extractedDir);
    if (!manifest) {
      throw new Error("插件包缺少 manifest.json");
    }
    if (manifest.kind === "builtin") {
      registerService(manifest, {
        defaultKind: "builtin",
        desktop: {
          assetFileName: path.basename(archivePath),
          bundleTopLevelDir: manifest.desktop?.bundleTopLevelDir ?? entries[0]
        }
      });
      const { installBuiltinService } = await import("./service-manager");
      await installBuiltinService(app, manifest.id, { force: true, archivePath });
      return { ok: true, message: `内置服务 ${manifest.name} 已安装。`, serviceId: manifest.id };
    }
    const definition = normalizeManifest(manifest, { defaultKind: "plugin" });

    const targetDir = path.join(root, manifest.id);
    const preservedConfigFiles = preserveExistingConfigFiles(
      targetDir,
      definition.configFiles.map((configFile) => configFile.relativePath)
    );
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(extractedDir, targetDir, { recursive: true });
    restorePreservedConfigFiles(targetDir, preservedConfigFiles);
    fs.rmSync(path.join(targetDir, ".zenmind-desktop"), { recursive: true, force: true });
    fixShellScriptPermissions(targetDir);
    registerService(manifest, { defaultKind: "plugin" });
    return { ok: true, message: `插件 ${manifest.name} 已导入，请完成初始化。`, serviceId: manifest.id };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function uninstallPlugin(app: App, serviceId: string) {
  // Verify it's a plugin, not builtin
  const def = getService(serviceId);
  if (def.kind !== "plugin") {
    return { ok: false, message: "内置服务不可卸载。" };
  }
  const { getServiceState, stopService } = await import("./service-manager");
  const currentState = await getServiceState(app, serviceId);
  if (currentState.status === "running") {
    await stopService(app, serviceId);
  }
  const dir = getPluginInstallDir(app, serviceId);
  fs.rmSync(dir, { recursive: true, force: true });
  unregisterService(serviceId);
  return { ok: true, message: `插件 ${def.name} 已卸载。` };
}
