import path from "node:path";
import type { App } from "electron";
import { APP_ID, BRAND_ID } from "../shared/brand";

type DevelopmentRuntimeApp = Partial<Pick<App, "isPackaged">>;

export type DesktopDevelopmentRuntimeContext = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
};

function isPathInside(parentPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function isDesktopDevelopmentRuntime(
  app: DevelopmentRuntimeApp,
  context: DesktopDevelopmentRuntimeContext = {}
) {
  if (app.isPackaged === false) {
    return true;
  }

  const platform = context.platform ?? process.platform;
  if (platform !== "darwin") {
    return false;
  }

  // The branded macOS development shell is a copied and renamed Electron.app,
  // so Electron reports app.isPackaged=true. Recognize only the app produced by
  // scripts/platform/dev-darwin.mjs; an environment override alone is not enough.
  const env = context.env ?? process.env;
  const argv = context.argv ?? process.argv;
  const execPath = context.execPath ?? process.execPath;
  const projectRootArgument = argv[1]?.trim() ?? "";
  const resourcesRoot = env.DESKTOP_DEV_RESOURCES_ROOT?.trim() ?? "";
  if (
    env.__CFBundleIdentifier !== `${APP_ID}.dev` ||
    env.VITE_DEV_SERVER_URL !== "http://127.0.0.1:5173" ||
    !path.isAbsolute(projectRootArgument) ||
    !path.isAbsolute(resourcesRoot) ||
    !path.isAbsolute(execPath)
  ) {
    return false;
  }

  const projectRoot = path.resolve(projectRootArgument);
  const expectedResourcesRoot = path.join(projectRoot, "build", "brands", BRAND_ID, "resources");
  const expectedDevAppRoot = path.join(projectRoot, "build", "brands", BRAND_ID, "dev");
  return (
    path.resolve(resourcesRoot) === expectedResourcesRoot &&
    isPathInside(expectedDevAppRoot, execPath)
  );
}
