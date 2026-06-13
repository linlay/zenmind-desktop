import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BRAND_ID = "zenmind";
export const SUPPORTED_LOCALES = ["zh-CN", "en-US"];
export const INSTALLER_SHUTDOWN_ARG = "--desktop-shutdown-for-update";
export const LEGACY_INSTALLER_SHUTDOWN_ARGS = ["--zenmind-shutdown-for-update"];

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const BRAND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]+$/u;
const REQUIRED_ICON_FILES = ["app-icon.svg", "tray-icon.svg"];

export function resolveBrandId(argv = process.argv.slice(2), env = process.env) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--brand" && argv[index + 1]) {
      return normalizeBrandId(argv[index + 1]);
    }
    if (arg.startsWith("--brand=")) {
      return normalizeBrandId(arg.slice("--brand=".length));
    }
  }
  return normalizeBrandId(env.BRAND || DEFAULT_BRAND_ID);
}

export function loadBrandConfig(rootDir = process.cwd(), brandId = resolveBrandId()) {
  const id = normalizeBrandId(brandId);
  const brandRoot = path.join(rootDir, "brands", id);
  const manifestPath = path.join(brandRoot, "brand.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Brand manifest not found: ${path.relative(rootDir, manifestPath)}`);
  }

  const manifest = readJson(manifestPath);
  const i18n = loadBrandI18n(rootDir, brandRoot, manifest);
  const icons = validateBrandIcons(rootDir, brandRoot);
  const brand = normalizeManifest(rootDir, brandRoot, manifest, i18n, icons);
  return brand;
}

export function syncBrandArtifacts({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  writePackageMetadata = true
} = {}) {
  const brand = loadBrandConfig(rootDir, brandId);

  writeGeneratedBrandFiles(rootDir, brand);
  writeElectronBuilderConfig(rootDir, brand);
  writeInstallerInclude(rootDir, brand);
  writeMacUninstallScript(rootDir, brand);

  if (writePackageMetadata) {
    syncPackageMetadata(rootDir, brand);
  }

  return brand;
}

export function electronBuilderConfigPath(rootDir = process.cwd(), brandId = resolveBrandId()) {
  return path.join(rootDir, "build", `electron-builder.${normalizeBrandId(brandId)}.json`);
}

function normalizeBrandId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!BRAND_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid brand id: ${value}`);
  }
  return normalized;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON ${filePath}: ${message}`);
  }
}

function writeJson(filePath, value) {
  writeFileIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return false;
  }
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function requireString(manifest, key) {
  const value = manifest[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireNestedString(manifest, group, key) {
  const value = manifest[group]?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${group}.${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNestedString(manifest, group, key) {
  const value = manifest[group]?.[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${group}.${key}" must be a non-empty string when provided.`);
  }
  return value.trim();
}

function normalizeManifest(rootDir, brandRoot, manifest, i18n, icons) {
  const id = requireString(manifest, "id").toLowerCase();
  if (!BRAND_ID_PATTERN.test(id)) {
    throw new Error(`Brand manifest field "id" is invalid: ${id}`);
  }
  if (id !== path.basename(brandRoot)) {
    throw new Error(`Brand manifest id "${id}" must match directory "${path.basename(brandRoot)}".`);
  }

  const packageName = requireString(manifest, "packageName");
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`Brand packageName is invalid: ${packageName}`);
  }
  const storageNamespace = requireString(manifest, "storageNamespace");
  if (!PACKAGE_NAME_PATTERN.test(storageNamespace)) {
    throw new Error(`Brand storageNamespace is invalid: ${storageNamespace}`);
  }

  const appId = requireString(manifest, "appId");
  if (!APP_ID_PATTERN.test(appId) || !appId.includes(".")) {
    throw new Error(`Brand appId is invalid: ${appId}`);
  }

  const productName = requireString(manifest, "productName");
  const description = requireString(manifest, "description");
  const runtimeRootDirName = `.${id}`;
  const configuredRuntimeRootDirName = optionalNestedString(manifest, "paths", "runtimeRootDirName");
  if (configuredRuntimeRootDirName && configuredRuntimeRootDirName !== runtimeRootDirName) {
    throw new Error(
      `Brand manifest field "paths.runtimeRootDirName" must be "${runtimeRootDirName}" when provided.`
    );
  }
  const desktopDataSubdir = requireNestedString(manifest, "paths", "desktopDataSubdir");
  const programDataDirName = requireNestedString(manifest, "paths", "programDataDirName");
  const microphoneUsageDescription = requireNestedString(manifest, "mac", "microphoneUsageDescription");
  const speechRecognitionUsageDescription = requireNestedString(manifest, "mac", "speechRecognitionUsageDescription");

  return {
    id,
    packageName,
    storageNamespace,
    productName,
    appId,
    description,
    paths: {
      runtimeRootDirName,
      desktopDataSubdir,
      programDataDirName
    },
    mac: {
      microphoneUsageDescription,
      speechRecognitionUsageDescription
    },
    icons,
    installer: {
      shutdownArg: INSTALLER_SHUTDOWN_ARG,
      legacyShutdownArgs: LEGACY_INSTALLER_SHUTDOWN_ARGS
    },
    i18n,
    source: {
      brandRoot: path.relative(rootDir, brandRoot).replace(/\\/gu, "/")
    }
  };
}

function loadBrandI18n(rootDir, brandRoot, manifest) {
  const value = manifest.i18n;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Brand manifest field \"i18n\" must map locales to JSON files.");
  }

  const result = {};
  for (const locale of SUPPORTED_LOCALES) {
    const relativePath = value[locale];
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error(`Brand manifest field "i18n.${locale}" must be a JSON file path.`);
    }
    const filePath = path.join(brandRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Brand i18n file not found: ${path.relative(rootDir, filePath)}`);
    }
    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Brand i18n file must contain an object: ${path.relative(rootDir, filePath)}`);
    }
    result[locale] = parsed;
  }
  return result;
}

function validateBrandIcons(rootDir, brandRoot) {
  const iconsRoot = path.join(brandRoot, "icons");
  if (!fs.existsSync(iconsRoot) || !fs.statSync(iconsRoot).isDirectory()) {
    throw new Error(`Brand icons directory not found: ${path.relative(rootDir, iconsRoot)}`);
  }

  for (const fileName of REQUIRED_ICON_FILES) {
    const filePath = path.join(iconsRoot, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Brand icon file not found: ${path.relative(rootDir, filePath)}`);
    }
  }

  return {
    appIconSvg: path.relative(rootDir, path.join(iconsRoot, "app-icon.svg")).replace(/\\/gu, "/"),
    trayIconSvg: path.relative(rootDir, path.join(iconsRoot, "tray-icon.svg")).replace(/\\/gu, "/")
  };
}

function runtimeBrandPayload(brand) {
  return {
    id: brand.id,
    packageName: brand.packageName,
    storageNamespace: brand.storageNamespace,
    productName: brand.productName,
    appId: brand.appId,
    description: brand.description,
    paths: brand.paths,
    installer: brand.installer,
    i18n: brand.i18n
  };
}

function writeGeneratedBrandFiles(rootDir, brand) {
  const payload = runtimeBrandPayload(brand);
  writeJson(path.join(rootDir, "build", "generated", "brand.json"), payload);
  writeFileIfChanged(
    path.join(rootDir, "src", "shared", "generated", "brand.ts"),
    [
      `export const APP_BRAND = ${JSON.stringify(payload, null, 2)} as const;`,
      "",
      "export const BRAND_ID = APP_BRAND.id;",
      "export const PACKAGE_NAME = APP_BRAND.packageName;",
      "export const STORAGE_NAMESPACE = APP_BRAND.storageNamespace;",
      "export const PRODUCT_NAME = APP_BRAND.productName;",
      "export const APP_ID = APP_BRAND.appId;",
      "export const APP_DESCRIPTION = APP_BRAND.description;",
      "export const INSTALLER_SHUTDOWN_ARG = APP_BRAND.installer.shutdownArg;",
      "export const LEGACY_INSTALLER_SHUTDOWN_ARGS = APP_BRAND.installer.legacyShutdownArgs;",
      ""
    ].join("\n")
  );
}

function electronBuilderConfig(brand) {
  return {
    appId: brand.appId,
    productName: brand.productName,
    directories: {
      app: "build/app"
    },
    files: [
      "dist-renderer/**/*",
      "dist-electron/**/*",
      "package.json",
      "node_modules/**/*",
      "!node_modules/@napi-rs/canvas-linux-*",
      "!node_modules/@napi-rs/canvas-linux-*/**/*",
      "!node_modules/**/*.d.ts",
      "!node_modules/**/*.map"
    ],
    asarUnpack: [
      "node_modules/@napi-rs/canvas-*/**/*"
    ],
    npmRebuild: false,
    extraResources: [
      {
        from: "build/resources/services",
        to: "services"
      },
      {
        from: "build/resources/env",
        to: "env"
      },
      {
        from: "build/resources/demo",
        to: "demo"
      },
      {
        from: "public/tray-icon.png",
        to: "tray-icon.png"
      },
      {
        from: "scripts",
        to: ".",
        filter: ["uninstall.sh"]
      }
    ],
    mac: {
      icon: "build/icons/icon.icns",
      identity: null,
      extendInfo: {
        NSMicrophoneUsageDescription: brand.mac.microphoneUsageDescription,
        NSSpeechRecognitionUsageDescription: brand.mac.speechRecognitionUsageDescription
      },
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      signIgnore: [".*"]
    },
    electronLanguages: ["zh-CN", "en-US"],
    afterPack: "./scripts/fix-mac-sign.js",
    win: {
      icon: "build/icons/icon.ico",
      target: ["nsis"]
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      include: "build/installer.nsh"
    }
  };
}

function writeElectronBuilderConfig(rootDir, brand) {
  writeJson(electronBuilderConfigPath(rootDir, brand.id), electronBuilderConfig(brand));
}

function syncPackageMetadata(rootDir, brand) {
  const packagePath = path.join(rootDir, "package.json");
  const packageJson = readJson(packagePath);
  packageJson.name = brand.packageName;
  packageJson.description = brand.description;
  delete packageJson.build;
  writeJson(packagePath, packageJson);

  const lockPath = path.join(rootDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    return;
  }
  const packageLock = readJson(lockPath);
  packageLock.name = brand.packageName;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].name = brand.packageName;
  }
  writeJson(lockPath, packageLock);
}

function escapeNsisText(value) {
  return String(value).replace(/\$/gu, "$$").replace(/"/gu, "$\\\"");
}

function writeInstallerInclude(rootDir, brand) {
  const productName = escapeNsisText(brand.productName);
  const programRoot = `%APPDATA%\\${brand.paths.programDataDirName}`;
  const stateRoot = `%USERPROFILE%\\${brand.paths.runtimeRootDirName}\\${brand.paths.desktopDataSubdir}\\state`;
  const shutdownArg = brand.installer.shutdownArg;
  const content = `!macro stopManagedServiceProcesses
  DetailPrint "Stopping ${productName} managed service processes..."
  nsExec::ExecToLog \`%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; function Stop-DesktopManagedProcesses { $$programRoot = [Environment]::ExpandEnvironmentVariables('${programRoot}'); if (Test-Path -LiteralPath $$programRoot) { $$normalizedRoot = [System.IO.Path]::GetFullPath($$programRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar); Get-CimInstance Win32_Process | Where-Object { $$path = [string]$$_.ExecutablePath; $$line = [string]$$_.CommandLine; ($$path -and $$path.StartsWith($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($$line -and $$line.IndexOf($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }; $$stateRoot = [Environment]::ExpandEnvironmentVariables('${stateRoot}'); if (Test-Path -LiteralPath $$stateRoot) { Get-ChildItem -LiteralPath $$stateRoot -Filter '*.pid' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $$_.FullName -Force -ErrorAction SilentlyContinue } } }; Stop-DesktopManagedProcesses"\`
  Pop $R2
!macroend

!macro customCheckAppRunning
  !insertmacro FIND_PROCESS "\${APP_EXECUTABLE_FILENAME}" $R0
  \${if} $R0 == 0
    DetailPrint "Requesting ${productName} to exit before installing..."
    \${if} \${FileExists} "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"
      nsExec::ExecToLog \`"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${shutdownArg}\`
      Pop $R2
      Sleep 500
    \${endif}

    StrCpy $R1 0
    waitAppExit:
      !insertmacro FIND_PROCESS "\${APP_EXECUTABLE_FILENAME}" $R0
      \${if} $R0 != 0
        Goto appExited
      \${endif}
      IntOp $R1 $R1 + 1
      \${if} $R1 < 12
        Sleep 500
        Goto waitAppExit
      \${endif}

      DetailPrint "Force closing ${productName} before installing..."
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::ExecToLog \`taskkill /f /im "\${APP_EXECUTABLE_FILENAME}"\`
        Pop $R2
      !else
        nsExec::ExecToLog \`%SYSTEMROOT%\\System32\\cmd.exe /c taskkill /f /im "\${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"\`
        Pop $R2
      !endif

    appExited:
  \${endif}

  !insertmacro stopManagedServiceProcesses
!macroend

!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ${productName} app data?$\\r$\\n$\\r$\\nThis removes ${programRoot}, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles." /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  RMDir /r "$APPDATA\\${brand.paths.programDataDirName}"

doneDataCleanup:
!macroend
`;
  writeFileIfChanged(path.join(rootDir, "build", "installer.nsh"), content);
}

function shellDoubleQuoted(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

function writeMacUninstallScript(rootDir, brand) {
  const appName = shellDoubleQuoted(brand.productName);
  const runtimeRootDirName = shellDoubleQuoted(brand.paths.runtimeRootDirName);
  const desktopDataSubdir = shellDoubleQuoted(brand.paths.desktopDataSubdir);
  const programDataDirName = shellDoubleQuoted(brand.paths.programDataDirName);
  const content = `#!/bin/bash

set -euo pipefail

APP_NAME="${appName}"
APP_PATH="/Applications/\${APP_NAME}.app"
DATA_PATH="\${HOME}/${runtimeRootDirName}/${desktopDataSubdir}"
PROGRAM_DATA_PATH="\${HOME}/Library/Application Support/${programDataDirName}"

show_dialog() {
  local message="$1"

  osascript -e "display dialog \\"$message\\" buttons {\\"OK\\"} default button \\"OK\\" with icon caution" >/dev/null
}

is_app_running() {
  osascript -e "tell application \\"System Events\\" to return (name of processes) contains \\"$APP_NAME\\""
}

remove_application_bundle() {
  if [ ! -d "$APP_PATH" ]; then
    printf '%s\\n' "Application bundle not found at $APP_PATH. Skipping app removal."
    return 0
  fi

  local escaped_app_path
  escaped_app_path=\${APP_PATH//\\"/\\\\\\"}
  osascript -e "do shell script \\"rm -rf \\\\\\"$escaped_app_path\\\\\\"\\" with administrator privileges" >/dev/null
  printf '%s\\n' "Removed application bundle: $APP_PATH"
}

prompt_for_data_cleanup() {
  osascript -e "button returned of (display dialog \\"Do you also want to delete $APP_NAME app data?\\n\\nThis removes $DATA_PATH and $PROGRAM_DATA_PATH, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles.\\" buttons {\\"Keep Data\\", \\"Delete Data\\"} default button \\"Keep Data\\" with icon caution)"
}

if [ "$(is_app_running)" = "true" ]; then
  show_dialog "$APP_NAME is still running. Quit the app and run this uninstall script again."
  printf '%s\\n' "$APP_NAME is still running. Quit it and rerun this script."
  exit 1
fi

remove_application_bundle

if [ "$(prompt_for_data_cleanup)" = "Delete Data" ]; then
  rm -rf "$DATA_PATH"
  rm -rf "$PROGRAM_DATA_PATH"
  printf '%s\\n' "Removed app data: $DATA_PATH"
  printf '%s\\n' "Removed program data: $PROGRAM_DATA_PATH"
else
  printf '%s\\n' "Kept app data: $DATA_PATH"
  printf '%s\\n' "Kept program data: $PROGRAM_DATA_PATH"
fi

printf '%s\\n' "$APP_NAME uninstall finished."
`;
  const scriptPath = path.join(rootDir, "scripts", "uninstall.sh");
  writeFileIfChanged(scriptPath, content);
  fs.chmodSync(scriptPath, 0o755);
}
