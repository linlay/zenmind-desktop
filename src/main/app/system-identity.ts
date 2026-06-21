import path from "node:path";
import type { App, nativeImage } from "electron";
import { APP_ICON_ASSET_DIRECTORIES, APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import {
  applyPlatformAppInit
} from "../platform-adapter";
import {
  configureNativeAboutPanel,
  resolveDesktopAppInfo
} from "../app-metadata";

export type SystemIdentityRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  appId: string;
  productName: string;
  mainProcessDir: string;
  resourcesPath: string;
  nativeImage: Pick<typeof nativeImage, "createFromPath">;
  safeConsoleError: (message: string, details: Record<string, unknown>) => void;
};

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function projectRootFromMainDir(mainDir: string, platform: NodeJS.Platform) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "win32") {
    return pathApi.resolve(pathApi.join(mainDir, ".."));
  }
  if (platform === "darwin") {
    return pathApi.resolve(pathApi.join(mainDir, ".."));
  }
  return pathApi.resolve(pathApi.join(mainDir, ".."));
}

export function configureSystemIdentity(options: SystemIdentityRuntimeOptions) {
  options.app.setName(options.productName);
  applyPlatformAppInit(options.platform, options.app, options.appId);
  const desktopAppInfo = resolveDesktopAppInfo(options.app);
  configureNativeAboutPanel(options.platform, options.app, desktopAppInfo);

  function getDarwinDockIconCandidatePaths() {
    const pathApi = pathApiForPlatform(options.platform);
    const projectRoot = projectRootFromMainDir(options.mainProcessDir, options.platform);
    const bundledMacDockIconPath = pathApi.join(
      options.resourcesPath,
      APP_ICON_ASSET_FILENAMES.macDockIcon
    );
    const packagedBrandIconPath = pathApi.join(options.resourcesPath, APP_ICON_ASSET_FILENAMES.brandIcon);
    const buildAppIconPath = pathApi.join(
      projectRoot,
      APP_ICON_ASSET_DIRECTORIES.buildIcons,
      APP_ICON_ASSET_FILENAMES.macDockIcon
    );
    const generatedBrandIconPath = pathApi.join(
      projectRoot,
      APP_ICON_ASSET_DIRECTORIES.brandAssets,
      APP_ICON_ASSET_FILENAMES.brandIcon
    );
    const rendererBrandIconPath = pathApi.join(
      projectRoot,
      APP_ICON_ASSET_DIRECTORIES.distRenderer,
      APP_ICON_ASSET_FILENAMES.brandIcon
    );

    if (options.app.isPackaged) {
      return [
        packagedBrandIconPath,
        bundledMacDockIconPath,
        rendererBrandIconPath,
        buildAppIconPath,
        generatedBrandIconPath
      ];
    }

    return [
      bundledMacDockIconPath,
      buildAppIconPath,
      generatedBrandIconPath,
      rendererBrandIconPath
    ];
  }

  function applyDarwinDockIcon(dock: NonNullable<typeof options.app.dock>) {
    for (const iconPath of getDarwinDockIconCandidatePaths()) {
      const icon = options.nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        continue;
      }
      dock.setIcon(icon);
      return;
    }

    options.safeConsoleError("failed to load macOS dock icon", {
      candidates: getDarwinDockIconCandidatePaths()
    });
  }

  function ensureDockIdentity() {
    if (options.platform === "win32") {
      return;
    }
    if (options.platform !== "darwin") {
      return;
    }

    options.app.setActivationPolicy("regular");
    const dock = options.app.dock;
    if (!dock) {
      return;
    }

    applyDarwinDockIcon(dock);
    void dock.show()
      .then(() => {
        applyDarwinDockIcon(dock);
      })
      .catch((error) => {
        options.safeConsoleError("failed to show macOS dock icon", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  return {
    desktopAppInfo,
    ensureDockIdentity
  };
}

export type SystemIdentityRuntime = ReturnType<typeof configureSystemIdentity>;
