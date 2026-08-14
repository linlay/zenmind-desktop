export type BrandLocale = "zh-CN" | "en-US";

export type DesktopPetSignatureVariant = {
  path: string;
  frameCount: number;
  durationMs: number;
  weight?: number;
};

export type DesktopPetSignatureAction = {
  id: string;
  label: string;
  trigger: string[];
  variants: DesktopPetSignatureVariant[];
};

export type DesktopPetState = {
  path: string;
  frameCount: number;
  durationMs: number;
  loop?: boolean;
  mirror?: boolean;
  holdMs?: number;
  alts?: DesktopPetSignatureAction[];
};

export type DesktopPetBrandConfig = {
  id: string;
  displayName: string;
  description: string;
  preview: string;
  states: Record<string, DesktopPetState>;
  signature?: DesktopPetSignatureAction[];
};

export type AppBrand = {
  id: string;
  packageName: string;
  storageNamespace: string;
  productName: string;
  appId: string;
  description: string;
  protocols: {
    open: {
      scheme: string;
    };
  };
  paths: {
    runtimeRootDirName: string;
    desktopDataSubdir: string;
    programDataDirName: string;
  };
  installer: {
    shutdownArg: string;
  };
  desktopPet: DesktopPetBrandConfig;
  i18n: Record<BrandLocale, Partial<Record<string, string>>>;
};

type NodeRequire = (id: string) => unknown;
type ProcessLike = {
  env: Record<string, string | undefined>;
  cwd: () => string;
};
type FsLike = {
  existsSync: (filePath: string) => boolean;
  statSync: (filePath: string) => { isFile: () => boolean; isDirectory: () => boolean; mtimeMs: number };
  readFileSync: (filePath: string, encoding: "utf8") => string;
  readdirSync: (filePath: string, options: { withFileTypes: true }) => Array<{
    name: string;
    isDirectory: () => boolean;
  }>;
};
type PathLike = {
  join: (...segments: string[]) => string;
  resolve: (...segments: string[]) => string;
};

declare const __DESKTOP_APP_BRAND__: AppBrand | undefined;
declare const require: NodeRequire | undefined;
declare const __dirname: string | undefined;

function injectedBrandPayload() {
  if (typeof __DESKTOP_APP_BRAND__ !== "undefined") {
    return __DESKTOP_APP_BRAND__;
  }
  return undefined;
}

function nodeRequire() {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") {
    return globalRequire;
  }
  if (typeof require === "function") {
    return require;
  }
  return undefined;
}

function nodeDirname() {
  return typeof __dirname === "string" ? __dirname : "";
}

function nodeProcess() {
  return (globalThis as { process?: ProcessLike }).process;
}

function readJsonFile(requireFn: NodeRequire, filePath: string) {
  const fs = requireFn("node:fs") as FsLike;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as AppBrand;
}

function projectRootFromCompiledSharedDir(requireFn: NodeRequire) {
  const path = requireFn("node:path") as PathLike;
  const dirname = nodeDirname();
  return dirname ? path.resolve(dirname, "..", "..") : "";
}

function newestGeneratedBrandPath(requireFn: NodeRequire, projectRoot: string) {
  const fs = requireFn("node:fs") as FsLike;
  const path = requireFn("node:path") as PathLike;
  const brandsRoot = path.join(projectRoot, "build", "brands");
  if (!fs.existsSync(brandsRoot) || !fs.statSync(brandsRoot).isDirectory()) {
    return "";
  }

  return fs
    .readdirSync(brandsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(brandsRoot, entry.name, "generated", "brand.json"))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] ?? "";
}

function fallbackBrandPayload() {
  const requireFn = nodeRequire();
  const processRef = nodeProcess();
  if (!requireFn || !processRef) {
    throw new Error("Desktop brand metadata was not injected.");
  }

  const path = requireFn("node:path") as PathLike;
  const projectRoot = projectRootFromCompiledSharedDir(requireFn);
  const explicitBrandJson = processRef.env.DESKTOP_BRAND_JSON?.trim();
  const brandId = processRef.env.BRAND?.trim().toLowerCase();
  const candidates = [
    explicitBrandJson ? path.resolve(projectRoot || processRef.cwd(), explicitBrandJson) : "",
    projectRoot && brandId ? path.join(projectRoot, "build", "brands", brandId, "generated", "brand.json") : "",
    projectRoot ? newestGeneratedBrandPath(requireFn, projectRoot) : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    const payload = readJsonFile(requireFn, candidate);
    if (payload) {
      return payload;
    }
  }

  throw new Error("Desktop brand metadata was not generated. Run npm run brand:sync with BRAND=<brand> first.");
}

export const APP_BRAND = injectedBrandPayload() ?? fallbackBrandPayload();

export const BRAND_ID = APP_BRAND.id;
export const PACKAGE_NAME = APP_BRAND.packageName;
export const STORAGE_NAMESPACE = APP_BRAND.storageNamespace;
export const PRODUCT_NAME = APP_BRAND.productName;
export const APP_ID = APP_BRAND.appId;
export const APP_DESCRIPTION = APP_BRAND.description;
export const DESKTOP_OPEN_PROTOCOL_SCHEME = APP_BRAND.protocols.open.scheme;
export const INSTALLER_SHUTDOWN_ARG = APP_BRAND.installer.shutdownArg;
