import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { App } from "electron";
import type {
  WebappRuntimeSettingsInput,
  WebappUpdateInput
} from "../../../../shared/contracts";
import {
  disposeWebappInstallation,
  exportWebappArchive,
  listWebappItems,
  removeWebappItem,
  updateWebappItem,
  type WebappDisposalTarget
} from "./actions";
import {
  isWebappFile,
  readWebappItemFromDir,
  readInstalledWebappItems,
  readWebappItems,
  readWebappUserConfigState,
  readWebappUserConfigValues,
  WEBAPP_FILE,
  writeWebappUserConfigValues,
  writeCanonicalWebappManifest
} from "./store";
import { createWebappRuntime, webappRuntime, type WebappRuntime } from "./runtime";
import {
  createWebappWindowManager,
  webappWindowManager,
  type WebappWindowManager
} from "./window-manager";
import {
  getRuntimeExecutableBindingKey,
  readWebappRuntimeSettings,
  writeWebappRuntimeSettings
} from "./runtime-settings";
import { requireWebsIntegrationPorts, type WebsIntegrationPorts } from "../integration-ports";
import {
  WebappInstallError,
  WebappInstallPolicyError,
  WebappRuntimeRequiredError
} from "./install-errors";
import { getDesktopWebappInstallStagingRoot } from "../../../infrastructure/filesystem/user-paths";

type WebappInstallArchiveOptions = Record<string, unknown> & { expectedId?: string };

function addDirectoryToZip(
  zip: JSZip,
  rootPath: string,
  currentPath = rootPath,
  archiveRoot = path.basename(rootPath)
) {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    const stat = fs.lstatSync(absolutePath);
    const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
    const archivePath = `${archiveRoot}/${relativePath}`;
    if (stat.isSymbolicLink()) {
      throw new Error(`WebApp packages must not contain symbolic links: ${archivePath}`);
    }
    if (stat.isDirectory()) {
      addDirectoryToZip(zip, rootPath, absolutePath, archiveRoot);
    } else if (stat.isFile()) {
      zip.file(archivePath, fs.readFileSync(absolutePath), {
        unixPermissions: stat.mode & 0o777
      });
    } else {
      throw new Error(`WebApp packages may contain only files and directories: ${archivePath}`);
    }
  }
}

/**
 * The single public Main-process facade for the WebApp subsystem.
 * Its collaborators remain concrete modules because they are four necessary
 * responsibilities, not a generic lifecycle framework.
 */
export class WebappManager {
  readonly manifestFileName = WEBAPP_FILE;

  constructor(
    private readonly integrationPorts?: WebsIntegrationPorts,
    readonly runtime: WebappRuntime = webappRuntime,
    readonly windowManager: WebappWindowManager = webappWindowManager
  ) {}

  isManifest(value: unknown) {
    return isWebappFile(value);
  }

  list(app: App) {
    return readWebappItems(app, process.platform, this.integrationPorts);
  }

  listInstalled(app: App, platform: NodeJS.Platform = process.platform) {
    return readInstalledWebappItems(app, platform);
  }

  listResult(app: App) {
    return listWebappItems(app, this.integrationPorts);
  }

  readPackage(packageRoot: string, expectedId = "") {
    return readWebappItemFromDir(packageRoot, expectedId);
  }

  canonicalizePackage(packageRoot: string, expectedId = "") {
    return writeCanonicalWebappManifest(packageRoot, expectedId);
  }

  installArchive(
    app: App,
    archivePath: string,
    options: WebappInstallArchiveOptions = {}
  ) {
    return requireWebsIntegrationPorts(this.integrationPorts)
      .installWebsiteAppArchiveFromPath(app, archivePath, options);
  }

  async installPackageDirectory(
    app: App,
    packageRoot: string,
    options: WebappInstallArchiveOptions = {}
  ) {
    const item = this.readPackage(packageRoot, options.expectedId);
    const stagingRoot = getDesktopWebappInstallStagingRoot(app);
    fs.mkdirSync(stagingRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(stagingRoot, "directory-package-"));
    const archivePath = path.join(temporaryRoot, "webapp.zip");
    try {
      const zip = new JSZip();
      addDirectoryToZip(zip, packageRoot, packageRoot, item.id);
      fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      return await this.installArchive(app, archivePath, options);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  update(app: App, id: string, input: WebappUpdateInput) {
    return updateWebappItem(app, id, input, this.integrationPorts);
  }

  readUserConfig(app: App, id: string) {
    return readWebappUserConfigValues(app, id);
  }

  readUserConfigState(app: App, id: string) {
    return readWebappUserConfigState(app, id);
  }

  saveUserConfig(app: App, id: string, input: unknown) {
    return writeWebappUserConfigValues(app, id, input);
  }

  remove(app: App, id: string) {
    return removeWebappItem(app, id, this.integrationPorts, {
      runtime: this.runtime,
      windowManager: this.windowManager
    });
  }

  dispose(app: App, target: WebappDisposalTarget, stopMessage: string) {
    return disposeWebappInstallation(app, target, stopMessage, this.integrationPorts, {
      runtime: this.runtime,
      windowManager: this.windowManager
    });
  }

  exportArchive(app: App, id: string, archivePath: string) {
    return exportWebappArchive(app, id, archivePath, this.integrationPorts);
  }

  readRuntimeSettings(app: App) {
    return readWebappRuntimeSettings(app);
  }

  saveRuntimeSettings(app: App, input: WebappRuntimeSettingsInput) {
    return writeWebappRuntimeSettings(app, input);
  }

  bindRuntimeExecutable(app: App, webappId: string, runtime: string, executablePath: string) {
    const settings = this.readRuntimeSettings(app);
    return this.saveRuntimeSettings(app, {
      runtimeExecutables: {
        ...settings.runtimeExecutables,
        [getRuntimeExecutableBindingKey(webappId, runtime)]: executablePath
      }
    });
  }
}

export const webappManager = new WebappManager();

export function createWebappManager(ports: WebsIntegrationPorts) {
  const runtime = createWebappRuntime(ports);
  const windowManager = createWebappWindowManager(ports, runtime);
  return new WebappManager(ports, runtime, windowManager);
}
export { WebappInstallError, WebappInstallPolicyError, WebappRuntimeRequiredError };
