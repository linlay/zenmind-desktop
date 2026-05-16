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
const stageAppScriptPath = path.join(projectRoot, "scripts", "stage-app.mjs");
const buildMainBundleScriptPath = path.join(projectRoot, "scripts", "build-main-bundle.mjs");

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

test("electron-builder packaging uses staged app input, restricted locales, and NSIS uninstall hook", () => {
  const packageJson = loadPackageJson();
  const extraResources = packageJson.build?.extraResources ?? [];
  const uninstallResource = extraResources.find((entry) => entry.from === "scripts");
  const trayIconResource = extraResources.find((entry) => entry.from === "public/tray-icon.png");
  const pluginsResource = extraResources.find((entry) => entry.from === "build/resources/plugins");
  const voiceAsrResource = extraResources.find((entry) => entry.from === "build/resources/voice-asr");

  assert.equal(packageJson.dependencies?.["@ffmpeg-installer/ffmpeg"], undefined);
  assert.ok(!packageJson.build?.asarUnpack?.includes("node_modules/@ffmpeg-installer/*/ffmpeg"));
  assert.ok(!packageJson.build?.asarUnpack?.includes("node_modules/@ffmpeg-installer/*/ffmpeg.exe"));
  assert.deepEqual(uninstallResource, {
    from: "scripts",
    to: ".",
    filter: ["uninstall.sh"]
  });
  assert.deepEqual(trayIconResource, {
    from: "public/tray-icon.png",
    to: "tray-icon.png"
  });
  assert.equal(pluginsResource, undefined);
  assert.equal(packageJson.build?.directories?.app, "build/app");
  assert.deepEqual(packageJson.build?.electronLanguages, ["zh-CN", "en-US"]);
  assert.match(packageJson.scripts?.["build:main"] ?? "", /build:main:types/);
  assert.match(packageJson.scripts?.["build:main"] ?? "", /build:main:bundle/);
  assert.equal(packageJson.scripts?.["icons"], "node ./scripts/generate-app-icons.mjs");
  assert.equal(packageJson.scripts?.["stage:app"], "node ./scripts/stage-app.mjs");
  assert.match(packageJson.scripts?.["dist:mac"] ?? "", /stage:app -- --os=darwin --arch=arm64/);
  assert.match(packageJson.scripts?.["dist:win"] ?? "", /stage:app -- --os=win32 --arch=x64/);
  assert.doesNotMatch(packageJson.scripts?.["dist:mac"] ?? "", /run icons/);
  assert.doesNotMatch(packageJson.scripts?.["dist:win"] ?? "", /run icons/);
  assert.equal(voiceAsrResource, undefined);
  assert.equal(packageJson.scripts?.["sync:plugins"], undefined);
  assert.equal(packageJson.scripts?.["prepare:voice-asr"], undefined);
  assert.doesNotMatch(packageJson.scripts?.["dist:mac"] ?? "", /prepare:voice-asr/);
  assert.doesNotMatch(packageJson.scripts?.["dist:win"] ?? "", /prepare:voice-asr/);
  assert.match(packageJson.scripts?.["dist:win"] ?? "", /electron-builder --win --x64/);
  assert.equal(packageJson.scripts?.["dist:win-docker"], "node ./scripts/dist-win.mjs");
  assert.notEqual(packageJson.build?.nsis?.perMachine, true);
  assert.equal(packageJson.build?.nsis?.include, "build/installer.nsh");
});

test("custom uninstall assets default to keeping data and delete desktop plus program data on request", () => {
  const installerScript = fs.readFileSync(installerIncludePath, "utf8");
  const uninstallScript = fs.readFileSync(uninstallScriptPath, "utf8");
  const distWinScript = fs.readFileSync(distWinScriptPath, "utf8");
  const tempOutPathMatch = installerScript.match(/!macro customUnInstall\s+SetOutPath \$TEMP\s+SetShellVarContext current/s);

  assert.ok(tempOutPathMatch, "custom uninstall should switch CWD to $TEMP before reading shell vars");
  assert.match(installerScript, /SetShellVarContext current/);
  assert.match(installerScript, /MessageBox MB_YESNO\|MB_ICONQUESTION/);
  assert.match(installerScript, /\/SD IDNO/);
  assert.match(installerScript, /RMDir \/r "\$PROFILE\\.zenmind\\.desktop"/);
  assert.match(installerScript, /RMDir \/r "\$APPDATA\\ZenMind"/);
  assert.doesNotMatch(installerScript, /\$APPDATA\\zenmind-desktop/);
  assert.match(uninstallScript, /APP_NAME="ZenMind"/);
  assert.match(uninstallScript, /APP_PATH="\/Applications\/\$\{APP_NAME\}\.app"/);
  assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.zenmind\/\.desktop"/);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/ZenMind"/);
  assert.doesNotMatch(uninstallScript, /Library\/Application Support\/zenmind-desktop/);
  assert.match(uninstallScript, /default button "Keep Data"/);
  assert.match(distWinScript, /electronuserland\/builder:wine/);
});

test("dist-win docker flow syncs builtin assets on the host before entering Docker", () => {
  const distWinScript = fs.readFileSync(distWinScriptPath, "utf8");
  const stageAppScript = fs.readFileSync(stageAppScriptPath, "utf8");
  const buildMainBundleScript = fs.readFileSync(buildMainBundleScriptPath, "utf8");

  assert.match(distWinScript, /async function syncWindowsBuiltinAssets\(\)/);
  assert.doesNotMatch(distWinScript, /prepareWindowsVoiceAsrAssets/);
  assert.match(
    distWinScript,
    /await syncWindowsBuiltinAssets\(\);\s*\n\s*await runAndWait\(npmCmd, \["run", "build"\]\);\s*\n\s*const npmCacheDir/
  );
  assert.match(
    distWinScript,
    /"--volume",\s*\n\s*"zenmind-desktop-node-modules:\/project\/node_modules",/
  );
  assert.match(
    distWinScript,
    /"npm install --no-package-lock --ignore-scripts",\s*\n\s*"node \.\/scripts\/stage-app\.mjs --os=win32 --arch=x64",\s*\n\s*"npx electron-builder --win --x64",\s*\n\s*"node \.\/scripts\/verify-win-package\.mjs"/
  );
  assert.match(
    distWinScript,
    /await runAndWait\(npmCmd, \["run", "stage:app", "--", "--os=win32", "--arch=x64"\]\);/
  );
  assert.match(
    distWinScript,
    /await runAndWait\(nodeBin\(\), \["\.\/scripts\/verify-win-package\.mjs"\]\);/
  );
  assert.match(stageAppScript, /"build", "bundle", "dist-electron"/);
  assert.match(stageAppScript, /"build", "app"/);
  assert.match(stageAppScript, /"dist-renderer"/);
  assert.match(stageAppScript, /main:\s*"dist-electron\/main\/index\.js"/);
  assert.match(buildMainBundleScript, /"main\/attachment-worker"/);
  assert.match(buildMainBundleScript, /"main",\s*"assistant",\s*"attachment-worker\.ts"/);
  assert.match(stageAppScript, /"@napi-rs\/canvas": desktopPackage\.dependencies/);
  assert.doesNotMatch(stageAppScript, /"@ffmpeg-installer\/ffmpeg": desktopPackage\.dependencies/);
  assert.match(stageAppScript, /--os=\$\{target\.os\}/);
  assert.match(stageAppScript, /--cpu=\$\{target\.arch\}/);
  assert.match(stageAppScript, /"--omit=dev"/);
  assert.match(stageAppScript, /"--include=optional"/);
  assert.match(stageAppScript, /"--ignore-scripts"/);
  assert.match(stageAppScript, /"--no-package-lock"/);
  assert.match(stageAppScript, /@napi-rs\/canvas-win32-x64-msvc/);
  assert.doesNotMatch(stageAppScript, /@ffmpeg-installer\/darwin-arm64/);
  assert.doesNotMatch(stageAppScript, /@ffmpeg-installer\/win32-x64/);
  assert.doesNotMatch(stageAppScript, /ffmpeg\.exe/);
  assert.match(stageAppScript, /unexpected linux canvas runtime packages in win32 stage/);
  assert.doesNotMatch(stageAppScript, /unexpected non-windows ffmpeg runtime packages in win32 stage/);
  assert.doesNotMatch(stageAppScript, /exceljs|docx|pptxgenjs|pdfjs-dist|zod/);
  assert.doesNotMatch(
    distWinScript,
    /"npm install(?: --no-package-lock)?",\s*\n\s*"npm run build",\s*\n\s*"npx electron-builder --win --x64"/
  );
  assert.doesNotMatch(
    distWinScript,
    /"--volume",\s*\n\s*"\/project\/node_modules",/
  );
  assert.doesNotMatch(
    distWinScript,
    /"node \.\/scripts\/sync-builtin-assets\.mjs --os=windows --arch=amd64"/
  );
});
