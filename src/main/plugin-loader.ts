import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { App } from "electron";
import { readManifestFile } from "./manifest-utils";
import { clearServices, getService, registerService, unregisterService } from "./service-registry";
import { fixShellScriptPermissions } from "./service-manager";

function getPluginsRoot(app: App) {
  return path.join(app.getPath("userData"), "plugins");
}

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
    if (manifest) {
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
    execFileSync("tar", ["-xzf", archivePath, "-C", tmpDir]);
    const entries = fs.readdirSync(tmpDir);
    if (entries.length !== 1) {
      throw new Error("插件包应包含单个顶层目录");
    }
    const extractedDir = path.join(tmpDir, entries[0]);
    const manifest = readManifest(extractedDir);
    if (!manifest) {
      throw new Error("插件包缺少 manifest.json");
    }

    const targetDir = path.join(root, manifest.id);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(extractedDir, targetDir);
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
  const dir = getPluginInstallDir(app, serviceId);
  fs.rmSync(dir, { recursive: true, force: true });
  unregisterService(serviceId);
  return { ok: true, message: `插件 ${def.name} 已卸载。` };
}
