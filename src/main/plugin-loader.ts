import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { normalizeManifest, readManifestFile } from "./manifest-utils";
import { clearServices, getService, registerService, unregisterService } from "./service-registry";
import { fixShellScriptPermissions } from "./service-manager";
import { extractArchiveToDir } from "./archive-utils";
import { getPluginsRoot } from "./user-paths";

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
