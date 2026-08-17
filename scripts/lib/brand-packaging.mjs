import fs from "node:fs";
import path from "node:path";
import { desktopBuiltinServicesRelativePath } from "./desktop-resources.mjs";
import {
  BRAND_RUNTIME_ASSET_DIR_NAME,
  DARWIN_BUNDLE_DEVELOPMENT_REGION,
  DARWIN_BUNDLE_LOCALIZATIONS,
  SUPPORTED_LOCALES
} from "./brand-model.mjs";
import {
  brandBuildRelativePath,
  brandBuildTargetKey,
  currentBrandBuildTarget,
  electronBuilderConfigPath
} from "./brand-paths.mjs";

function parseBooleanEnv(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean value`);
  }
}

function shouldSkipMacTimestamp(env = process.env) {
  return (
    parseBooleanEnv(env.SKIP_NOTARIZE, "SKIP_NOTARIZE") === true ||
    parseBooleanEnv(env.DESKTOP_SKIP_MAC_TIMESTAMP, "DESKTOP_SKIP_MAC_TIMESTAMP") === true
  );
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFileIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function electronBuilderConfig(brand, target = currentBrandBuildTarget()) {
  return {
    appId: brand.appId,
    productName: brand.productName,
    protocols: [
      {
        name: `${brand.productName} Open`,
        schemes: [brand.protocols.open.scheme]
      }
    ],
    directories: {
      app: brandBuildRelativePath(brand, "app", brandBuildTargetKey(target)),
      output: path.posix.join("dist", brand.id)
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
        from: desktopBuiltinServicesRelativePath(),
        to: "services"
      },
      {
        from: brandBuildRelativePath(brand, "resources", "env"),
        to: "env"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png"),
        to: "brand-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png"),
        to: "brand-mark.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png"),
        to: "tray-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, "installer", "uninstall.sh"),
        to: "uninstall.sh"
      }
    ],
    mac: {
      icon: brandBuildRelativePath(brand, "icons", "icon.icns"),
      extendInfo: {
        CFBundleDevelopmentRegion: DARWIN_BUNDLE_DEVELOPMENT_REGION,
        CFBundleLocalizations: DARWIN_BUNDLE_LOCALIZATIONS,
        NSMicrophoneUsageDescription: brand.mac.microphoneUsageDescription,
        NSSpeechRecognitionUsageDescription: brand.mac.speechRecognitionUsageDescription
      },
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      notarize: false,
      timestamp: shouldSkipMacTimestamp() ? "none" : undefined
    },
    electronLanguages: SUPPORTED_LOCALES,
    afterPack: "./scripts/after-pack.js",
    afterSign: "./scripts/verify-mac-services-signing.js",
    win: {
      icon: brandBuildRelativePath(brand, "icons", "icon.ico"),
      signAndEditExecutable: true,
      target: ["nsis"]
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      include: brandBuildRelativePath(brand, "installer", "installer.nsh")
    }
  };
}

export function writeElectronBuilderConfig(rootDir, brand, target) {
  writeJson(electronBuilderConfigPath(rootDir, brand.id), electronBuilderConfig(brand, target));
}
