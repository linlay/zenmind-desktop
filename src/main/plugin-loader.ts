import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { readManifestFile } from "./manifest-utils";
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
      return {
        ok: false,
        message: `安装包 ${manifest.name} 是内置服务，请在控制中心对应服务卡片中安装。`,
        serviceId: manifest.id
      };
    }

    const targetDir = path.join(root, manifest.id);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(extractedDir, targetDir, { recursive: true });
    fixShellScriptPermissions(targetDir);
    registerService(manifest, { defaultKind: "plugin" });
    return { ok: true, message: `插件 ${manifest.name} 已安装。`, serviceId: manifest.id };
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
