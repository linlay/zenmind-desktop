import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const installerIncludePath = path.join(projectRoot, "build", "installer.nsh");
const uninstallScriptPath = path.join(projectRoot, "scripts", "uninstall.sh");
const distWinScriptPath = path.join(projectRoot, "scripts", "dist-win.mjs");

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

test("electron-builder packaging includes uninstall resources and NSIS uninstall hook", () => {
  const packageJson = loadPackageJson();
  const extraResources = packageJson.build?.extraResources ?? [];
  const uninstallResource = extraResources.find((entry) => entry.from === "scripts");

  assert.deepEqual(uninstallResource, {
    from: "scripts",
    to: ".",
    filter: ["uninstall.sh"]
  });
  assert.equal(packageJson.scripts?.["dist:win"], "node ./scripts/dist-win.mjs");
  assert.equal(packageJson.scripts?.["dist:win-docker"], "node ./scripts/dist-win.mjs");
  assert.notEqual(packageJson.build?.nsis?.perMachine, true);
  assert.equal(packageJson.build?.nsis?.include, "build/installer.nsh");
});

test("custom uninstall assets exist with the expected data cleanup targets", () => {
  const installerScript = fs.readFileSync(installerIncludePath, "utf8");
  const uninstallScript = fs.readFileSync(uninstallScriptPath, "utf8");
  const distWinScript = fs.readFileSync(distWinScriptPath, "utf8");
  const tempOutPathMatch = installerScript.match(/!macro customUnInstall\s+SetOutPath \$TEMP\s+SetShellVarContext current/s);

  assert.ok(tempOutPathMatch, "custom uninstall should switch CWD to $TEMP before reading shell vars");
  assert.match(installerScript, /SetShellVarContext current/);
  assert.match(installerScript, /\$APPDATA\\zenmind-desktop/);
  assert.match(uninstallScript, /APP_PATH="\/Applications\/\$\{APP_NAME\}\.app"/);
  assert.match(uninstallScript, /Library\/Application Support\/zenmind-desktop/);
  assert.match(distWinScript, /electronuserland\/builder:wine/);
  assert.match(distWinScript, /ZENMIND_DESKTOP_BUNDLED_BUN_PATH/);
});
