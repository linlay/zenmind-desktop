export const APP_BRAND = {
  "id": "zenmind",
  "packageName": "zenmind-desktop",
  "storageNamespace": "zenmind-desktop",
  "productName": "ZenMind",
  "appId": "cc.zenmind.desktop",
  "description": "ZenMind 应用壳",
  "paths": {
    "runtimeRootDirName": ".zenmind",
    "desktopDataSubdir": ".desktop",
    "programDataDirName": "ZenMind"
  },
  "installer": {
    "shutdownArg": "--desktop-shutdown-for-update",
    "legacyShutdownArgs": [
      "--zenmind-shutdown-for-update"
    ]
  },
  "i18n": {
    "zh-CN": {
      "app.name": "ZenMind",
      "app.productName": "ZenMind",
      "startup.envImport.title": "初始化 ZenMind 环境",
      "taskBoard.prompt.intro": "请你处理下面这个 ZenMind 任务看板任务，并在完成后总结结果。"
    },
    "en-US": {
      "app.name": "ZenMind",
      "app.productName": "ZenMind",
      "startup.envImport.title": "Initialize ZenMind Environment",
      "taskBoard.prompt.intro": "Please handle this ZenMind task board task and summarize the result when finished."
    }
  }
} as const;

export const BRAND_ID = APP_BRAND.id;
export const PACKAGE_NAME = APP_BRAND.packageName;
export const STORAGE_NAMESPACE = APP_BRAND.storageNamespace;
export const PRODUCT_NAME = APP_BRAND.productName;
export const APP_ID = APP_BRAND.appId;
export const APP_DESCRIPTION = APP_BRAND.description;
export const INSTALLER_SHUTDOWN_ARG = APP_BRAND.installer.shutdownArg;
export const LEGACY_INSTALLER_SHUTDOWN_ARGS = APP_BRAND.installer.legacyShutdownArgs;
