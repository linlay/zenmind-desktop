import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals
} = require("../dist-electron/main/user-paths.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

test("canonical Desktop SSO access-token path follows macOS and Windows roots", () => {
  const macHome = "/Users/tester";
  const macDataRoot = __testInternals.resolveDesktopRoot({
    platform: "darwin",
    homePath: macHome,
    registryDataRootPath: ""
  });
  assert.equal(
    __testInternals.resolveDesktopSsoAccessTokenFilePath(macDataRoot, "darwin"),
    path.posix.join(
      macHome,
      APP_BRAND.paths.runtimeRootDirName,
      APP_BRAND.paths.desktopDataSubdir,
      "state",
      "desktop",
      "sso-access-token.txt"
    )
  );

  const windowsHome = "C:\\Users\\tester";
  const windowsDataRoot = __testInternals.resolveDesktopRoot({
    platform: "win32",
    homePath: windowsHome,
    registryDataRootPath: ""
  });
  assert.equal(
    __testInternals.resolveDesktopSsoAccessTokenFilePath(windowsDataRoot, "win32"),
    path.win32.join(
      windowsHome,
      APP_BRAND.paths.runtimeRootDirName,
      APP_BRAND.paths.desktopDataSubdir,
      "state",
      "desktop",
      "sso-access-token.txt"
    )
  );
});
