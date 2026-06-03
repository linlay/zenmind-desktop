export const APP_BRAND = {
  "id": "xiaojun",
  "packageName": "xiaojun-desktop",
  "storageNamespace": "zenmind-desktop",
  "productName": "XiaoJun",
  "appId": "cc.xiaojun.desktop",
  "description": "XiaoJun 应用壳",
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
      "app.name": "XiaoJun",
      "app.productName": "XiaoJun",
      "startup.envImport.title": "初始化 XiaoJun 环境",
      "taskBoard.prompt.intro": "请你处理下面这个 XiaoJun 任务看板任务，并在完成后总结结果。"
    },
    "en-US": {
      "app.name": "XiaoJun",
      "app.productName": "XiaoJun",
      "startup.envImport.title": "Initialize XiaoJun Environment",
      "taskBoard.prompt.intro": "Please handle this XiaoJun task board task and summarize the result when finished."
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
