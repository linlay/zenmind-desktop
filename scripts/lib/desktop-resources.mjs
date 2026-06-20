import path from "node:path";

export const DESKTOP_BUILD_RESOURCES_RELATIVE_PATH = "build/resources";
export const DESKTOP_BUILTIN_SERVICES_DIR_NAME = "services";

export function desktopBuildResourcesRelativePath(...segments) {
  return [DESKTOP_BUILD_RESOURCES_RELATIVE_PATH, ...segments].join("/");
}

export function desktopBuildResourcesDir(rootDir) {
  return path.join(rootDir, "build", "resources");
}

export function desktopBuiltinServicesRelativePath() {
  return desktopBuildResourcesRelativePath(DESKTOP_BUILTIN_SERVICES_DIR_NAME);
}

export function desktopBuiltinServicesDir(rootDir) {
  return path.join(desktopBuildResourcesDir(rootDir), DESKTOP_BUILTIN_SERVICES_DIR_NAME);
}
