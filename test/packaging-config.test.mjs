import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const electronBuilderConfigPath = path.join(projectRoot, "build", "electron-builder.zenmind.json");
const installerIncludePath = path.join(projectRoot, "build", "installer.nsh");
const uninstallScriptPath = path.join(projectRoot, "scripts", "uninstall.sh");
const distWinScriptPath = path.join(projectRoot, "scripts", "dist-win.mjs");
const distWinDockerScriptPath = path.join(projectRoot, "scripts", "platform", "dist-win-docker.mjs");
const distWinHostScriptPath = path.join(projectRoot, "scripts", "platform", "dist-win-host.mjs");
const stageAppScriptPath = path.join(projectRoot, "scripts", "stage-app.mjs");
const buildMainBundleScriptPath = path.join(projectRoot, "scripts", "build-main-bundle.mjs");
const afterPackScriptPath = path.join(projectRoot, "scripts", "fix-mac-sign.js");
const bundledMainPath = path.join(projectRoot, "build", "bundle", "dist-electron", "main", "index.js");

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function loadElectronBuilderConfig() {
  return JSON.parse(fs.readFileSync(electronBuilderConfigPath, "utf8"));
}

test("renderer declares Ant Design component libraries used by native webclient pages", () => {
  const dependencies = loadPackageJson().dependencies ?? {};

  assert.match(dependencies.antd ?? "", /^\^5\./);
  assert.match(dependencies["@ant-design/icons"] ?? "", /^\^6\./);
  assert.match(dependencies["@ant-design/x"] ?? "", /^\^1\./);
  assert.match(dependencies["@ant-design/x-markdown"] ?? "", /^\^2\./);
});

test("electron-builder packaging uses staged app input, restricted locales, and NSIS uninstall hook", () => {
  const packageJson = loadPackageJson();
  const builderConfig = loadElectronBuilderConfig();
  const extraResources = builderConfig.extraResources ?? [];
  const uninstallResource = extraResources.find((entry) => entry.from === "scripts");
  const trayIconResource = extraResources.find((entry) => entry.from === "public/tray-icon.png");
  const pluginsResource = extraResources.find((entry) => entry.from === "build/resources/plugins");
  const voiceAsrResource = extraResources.find((entry) => entry.from === "build/resources/voice-asr");

  assert.equal(packageJson.dependencies?.["@ffmpeg-installer/ffmpeg"], undefined);
  assert.equal(packageJson.build, undefined);
  assert.ok(!builderConfig.asarUnpack?.includes("node_modules/@ffmpeg-installer/*/ffmpeg"));
  assert.ok(!builderConfig.asarUnpack?.includes("node_modules/@ffmpeg-installer/*/ffmpeg.exe"));
  assert.equal(builderConfig.appId, "cc.zenmind.desktop");
  assert.equal(builderConfig.productName, "ZenMind");
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
  assert.equal(builderConfig.directories?.app, "build/app");
  assert.deepEqual(builderConfig.electronLanguages, ["zh-CN", "en-US"]);
  assert.match(packageJson.scripts?.["build:main"] ?? "", /build:main:types/);
  assert.match(packageJson.scripts?.["build:main"] ?? "", /build:main:bundle/);
  assert.equal(packageJson.scripts?.["icons"], "npm run brand:sync && node ./scripts/generate-app-icons.mjs");
  assert.equal(packageJson.scripts?.["stage:app"], "node ./scripts/stage-app.mjs");
  assert.equal(packageJson.scripts?.["dist:mac"], "node ./scripts/dist-mac.mjs");
  assert.equal(packageJson.scripts?.["dist:win"], "node ./scripts/dist-win.mjs");
  assert.equal(packageJson.scripts?.["dist:win-docker"], "node ./scripts/dist-win.mjs --docker");
  assert.equal(voiceAsrResource, undefined);
  assert.equal(packageJson.scripts?.["sync:plugins"], undefined);
  assert.equal(packageJson.scripts?.["prepare:voice-asr"], undefined);
  assert.notEqual(builderConfig.nsis?.perMachine, true);
  assert.equal(builderConfig.nsis?.include, "build/installer.nsh");
});

test("main-process bundle keeps process tree parser test export bound", () => {
  const bundledMain = fs.readFileSync(bundledMainPath, "utf8");

  assert.match(bundledMain, /parseProcessTreeRowsFromPowerShell:/);
  assert.doesNotMatch(bundledMain, /(?<!:)parseProcessTreeRowsFromPowerShell[,}]/);
});

test("main-process bundle handles installer shutdown command from a second instance", () => {
  const bundledMain = fs.readFileSync(bundledMainPath, "utf8");

  assert.match(bundledMain, /--desktop-shutdown-for-update/);
  assert.match(bundledMain, /--zenmind-shutdown-for-update/);
  assert.match(bundledMain, /second-instance/);
  assert.match(bundledMain, /before-quit/);
  assert.match(bundledMain, /shutdownCleanupPromise/);
});

test("custom uninstall assets default to keeping data and delete desktop plus program data on request", () => {
  const installerScript = fs.readFileSync(installerIncludePath, "utf8");
  const uninstallScript = fs.readFileSync(uninstallScriptPath, "utf8");
  const distWinDockerScript = fs.readFileSync(distWinDockerScriptPath, "utf8");
  const tempOutPathMatch = installerScript.match(/!macro customUnInstall\s+SetOutPath \$TEMP\s+SetShellVarContext current/s);

  assert.ok(tempOutPathMatch, "custom uninstall should switch CWD to $TEMP before reading shell vars");
  assert.match(installerScript, /SetShellVarContext current/);
  assert.match(installerScript, /MessageBox MB_YESNO\|MB_ICONQUESTION/);
  assert.match(installerScript, /\/SD IDNO/);
  assert.match(installerScript, /RMDir \/r "\$APPDATA\\ZenMind"/);
  assert.doesNotMatch(installerScript, /\$PROFILE\\.zenmind\\.desktop/);
  assert.doesNotMatch(installerScript, /\$APPDATA\\zenmind-desktop/);
  assert.match(uninstallScript, /APP_NAME="ZenMind"/);
  assert.match(uninstallScript, /APP_PATH="\/Applications\/\$\{APP_NAME\}\.app"/);
  assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.zenmind\/\.desktop"/);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/ZenMind"/);
  assert.doesNotMatch(uninstallScript, /Library\/Application Support\/zenmind-desktop/);
  assert.match(uninstallScript, /default button \\"Keep Data\\"/);
  assert.match(distWinDockerScript, /electronuserland\/builder:wine/);
});

test("windows installer requests graceful app shutdown and cleans managed service processes before overwrite", () => {
  const installerScript = fs.readFileSync(installerIncludePath, "utf8");

  assert.match(installerScript, /!macro customCheckAppRunning/);
  assert.match(installerScript, /--desktop-shutdown-for-update/);
  assert.match(installerScript, /Stop-DesktopManagedProcesses/);
  assert.match(installerScript, /Get-CimInstance Win32_Process/);
  assert.match(installerScript, /%APPDATA%\\ZenMind/);
  assert.match(installerScript, /%USERPROFILE%\\.zenmind\\.desktop\\state/);
  assert.match(installerScript, /Remove-Item -LiteralPath \$\$_.FullName -Force/);
  assert.match(installerScript, /taskkill \/f \/im "\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(installerScript, /nsExec::ExecToLog `%SYSTEMROOT%\\System32\\WindowsPowerShell.*Stop-DesktopManagedProcesses"`\s+Pop \$R2/s);
  assert.match(installerScript, /nsExec::ExecToLog `"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --desktop-shutdown-for-update`\s+Pop \$R2/);
});

test("dist-win docker flow syncs builtin assets on the host before entering Docker", () => {
  const distWinScript = fs.readFileSync(distWinScriptPath, "utf8");
  const distWinDockerScript = fs.readFileSync(distWinDockerScriptPath, "utf8");
  const distWinHostScript = fs.readFileSync(distWinHostScriptPath, "utf8");
  const stageAppScript = fs.readFileSync(stageAppScriptPath, "utf8");
  const buildMainBundleScript = fs.readFileSync(buildMainBundleScriptPath, "utf8");
  const afterPackScript = fs.readFileSync(afterPackScriptPath, "utf8");

  assert.match(distWinScript, /isWindows\(\)/);
  assert.match(distWinScript, /import\("\.\/platform\/dist-win-host\.mjs"\)/);
  assert.match(distWinScript, /import\("\.\/platform\/dist-win-docker\.mjs"\)/);
  assert.match(distWinDockerScript, /async function syncWindowsBuiltinAssets\(\)/);
  assert.doesNotMatch(distWinDockerScript, /prepareWindowsVoiceAsrAssets/);
  assert.match(
    distWinDockerScript,
    /await syncWindowsBuiltinAssets\(\);\s*\n\s*await runAndWait\(npmCmd, \["run", "build"\], \{ cwd: projectRoot \}\);\s*\n\s*const npmCacheDir/
  );
  assert.match(
    distWinDockerScript,
    /"--volume",\s*\n\s*`\$\{brand\.packageName\}-node-modules:\/project\/node_modules`,/
  );
  assert.match(
    distWinDockerScript,
    /"npm install --no-package-lock --ignore-scripts",\s*\n\s*`node \.\/scripts\/sync-brand\.mjs --brand=\$\{brand\.id\}`,\s*\n\s*"node \.\/scripts\/stage-app\.mjs --os=win32 --arch=x64",\s*\n\s*`npx electron-builder --config \$\{path\.posix\.relative\("\/project", electronBuilderConfigPath\("\/project", brand\.id\)\)\} --win --x64`,\s*\n\s*"node \.\/scripts\/verify-win-package\.mjs"/
  );
  assert.match(
    distWinHostScript,
    /await runAndWait\(npmCmd, \["run", "stage:app", "--", "--os=win32", "--arch=x64"\], \{/
  );
  assert.match(
    distWinHostScript,
    /await runAndWait\(nodeBin\(\), \["\.\/scripts\/verify-win-package\.mjs"\], \{ cwd: projectRoot \}\);/
  );
  assert.match(stageAppScript, /"build", "bundle", "dist-electron"/);
  assert.match(stageAppScript, /"build", "app"/);
  assert.match(stageAppScript, /"dist-renderer"/);
  assert.match(stageAppScript, /main:\s*"dist-electron\/main\/index\.js"/);
  assert.match(stageAppScript, /desktopBuildTarget:/);
  assert.match(buildMainBundleScript, /"main\/attachment-worker"/);
  assert.match(buildMainBundleScript, /"main",\s*"copilot",\s*"attachments",\s*"attachment-worker\.ts"/);
  assert.match(stageAppScript, /"@napi-rs\/canvas": desktopPackage\.dependencies/);
  assert.doesNotMatch(stageAppScript, /"@ffmpeg-installer\/ffmpeg": desktopPackage\.dependencies/);
  assert.match(stageAppScript, /--os=\$\{target\.os\}/);
  assert.match(stageAppScript, /--cpu=\$\{target\.arch\}/);
  assert.match(stageAppScript, /"--omit=dev"/);
  assert.match(stageAppScript, /"--include=optional"/);
  assert.match(stageAppScript, /"--ignore-scripts"/);
  assert.match(stageAppScript, /"--no-package-lock"/);
  assert.match(stageAppScript, /@napi-rs\/canvas-win32-x64-msvc/);
  assert.equal(loadElectronBuilderConfig().afterPack, "./scripts/fix-mac-sign.js");
  assert.match(afterPackScript, /case "darwin\/arm64":\s*\n\s*return "canvas-darwin-arm64";/);
  assert.match(afterPackScript, /case "win32\/x64":\s*\n\s*return "canvas-win32-x64-msvc";/);
  assert.match(afterPackScript, /function pruneUnusedCanvasRuntimes\(context, resourcesRoot\)/);
  assert.match(afterPackScript, /entry\.name\.startsWith\("canvas-"\)/);
  assert.match(afterPackScript, /ELECTRON_LOCALE_ALLOWLIST[\s\S]*"en\.lproj"[\s\S]*"zh_CN\.lproj"/);
  assert.match(afterPackScript, /context\.electronPlatformName !== "darwin"/);
  assert.doesNotMatch(stageAppScript, /@ffmpeg-installer\/darwin-arm64/);
  assert.doesNotMatch(stageAppScript, /@ffmpeg-installer\/win32-x64/);
  assert.doesNotMatch(stageAppScript, /ffmpeg\.exe/);
  assert.match(stageAppScript, /unexpected canvas runtime packages in \$\{target\.os\}\/\$\{target\.arch\} stage/);
  assert.match(fs.readFileSync(path.join(projectRoot, "scripts", "verify-win-package.mjs"), "utf8"), /unexpected non-win32-x64 canvas runtime packages/);
  assert.doesNotMatch(stageAppScript, /unexpected non-windows ffmpeg runtime packages in win32 stage/);
  assert.doesNotMatch(stageAppScript, /exceljs|docx|pptxgenjs|pdfjs-dist|zod/);
  assert.doesNotMatch(
    distWinDockerScript,
    /"npm install(?: --no-package-lock)?",\s*\n\s*"npm run build",\s*\n\s*"npx electron-builder --win --x64"/
  );
  assert.doesNotMatch(
    distWinDockerScript,
    /"--volume",\s*\n\s*"\/project\/node_modules",/
  );
  assert.doesNotMatch(
    distWinDockerScript,
    /"node \.\/scripts\/sync-builtin-assets\.mjs --os=windows --arch=amd64"/
  );
});
