import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { resolveNsisToolchain } from "../scripts/build-safe-repair.mjs";
import { writeInstallerInclude } from "../scripts/lib/brand-installers.mjs";
import { loadBrandConfig, brandInstallerDir } from "../scripts/lib/brand-config.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const templates = path.join(path.dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates", "nsis");

test('Windows packaging connects measured extraction while preserving upstream atomic copy and retries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-measured-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brand = loadBrandConfig(process.cwd(), 'cutej');
  writeInstallerInclude(root, brand);
  const config = electronBuilderConfig(brand, { os: 'win32', arch: 'x64' });
  assert.equal(config.nsis.script, undefined, 'preserve the standard uninstaller generation/signing pipeline');
  const script = fs.readFileSync(path.join(brandInstallerDir(root, brand), 'installer.nsh'), 'utf8');
  assert.match(script, /!macro DesktopMeasuredExtractorHeader[\s\S]*!cd/u);
  const extraction = fs.readFileSync(path.join(brandInstallerDir(root, brand), 'measured', 'extractAppPackage.nsh'), 'utf8');
  assert.match(extraction, /CopyFiles \/SILENT/u);
  assert.match(extraction, /LoopExtract7za:/u);
  assert.match(extraction, /DesktopExtract7zMeasured/u);
  assert.doesNotMatch(extraction, /Nsis7z::Extract "/u);
});

function runActivityFixture(t, { uninstall = false, fail = false, silent = false, update = true, measured = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const toolchain = resolveNsisToolchain();
  const plugins = fs.readdirSync(path.dirname(toolchain.root))
    .filter((name) => name.startsWith("nsis-resources-"))
    .map((name) => path.join(path.dirname(toolchain.root), name, "plugins", "x86-unicode"))
    .find((dir) => fs.existsSync(path.join(dir, "StdUtils.dll")));
  const brand = { ...loadBrandConfig(process.cwd(), "cutej"), storageNamespace: path.basename(root) };
  writeInstallerInclude(root, brand);
  if (measured) {
    const payload = path.join(root, 'payload');
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, 'program.bin'), randomBytes(2 * 1024 * 1024));
    const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib'));
    const archive = spawnSync(packagingRequire('7zip-bin').path7za, ['a', '-t7z', path.join(root, 'program.7z'), path.join(payload, '*')], { windowsHide: true });
    assert.equal(archive.status, 0);
  }
  const { NsisScriptGenerator } = builderRequire("app-builder-lib/out/targets/nsis/nsisScriptGenerator.js");
  const flags = new NsisScriptGenerator();
  flags.flags(["updated"]);
  const prefix = uninstall ? "un." : "";
  const source = path.join(root, "fixture.nsi");
  fs.writeFileSync(source, `Unicode true
Name "Desktop activity fixture"
OutFile "${path.join(root, "fixture.exe")}"
RequestExecutionLevel user
!addincludedir "${templates}"
!addincludedir "${path.join(templates, "include")}"
!addplugindir /x86-unicode "${plugins}"
!include StdUtils.nsh
!undef StdUtils.ExecShellAsUser
!define StdUtils.ExecShellAsUser "!insertmacro FixtureLaunch"
!macro FixtureLaunch RESULT FILE VERB ARGS
!macroend
${flags.build()}
${uninstall ? "!define BUILD_UNINSTALLER" : ""}
!include "${path.join(brandInstallerDir(root, brand), "installer.nsh")}"
!define PRODUCT_NAME "Fixture"
!define PRODUCT_FILENAME "Fixture"
!define VERSION "1.0.0"
!include common.nsh
!include MUI2.nsh
Var launchLink
Var FixtureLog
Var FixtureCount
Var FixturePhase
${uninstall ? `
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.FixtureLegacyShow
!define FixtureShow \${MUI_PAGE_CUSTOMFUNCTION_SHOW}
!undef MUI_PAGE_CUSTOMFUNCTION_SHOW
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.FixtureShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.FixtureLeave
!insertmacro MUI_UNPAGE_INSTFILES
Function un.FixtureLegacyShow
FunctionEnd
; Compile the actual lifecycle call sites too, without invoking file/process
; operations. Runtime fixtures below replace only the work with wait/retry loops.
Function un.FixtureCompileLifecycle
!insertmacro customCheckAppRunning
!insertmacro customUnInstall
FunctionEnd
` : `
!insertmacro customPageAfterChangeDir
!define FixtureShow \${MUI_PAGE_CUSTOMFUNCTION_SHOW}
!ifdef MUI_PAGE_CUSTOMFUNCTION_LEAVE
!define FixtureLeave \${MUI_PAGE_CUSTOMFUNCTION_LEAVE}
!undef MUI_PAGE_CUSTOMFUNCTION_LEAVE
!endif
!undef MUI_PAGE_CUSTOMFUNCTION_SHOW
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FixtureLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
`}
!insertmacro MUI_LANGUAGE "English"
${measured ? `LangString appCannotBeClosed \${LANG_ENGLISH} "Fixture file retry"
!define PROJECT_DIR "${root}"
!include "${path.join(brandInstallerDir(root, brand), 'measured', 'extractAppPackage.nsh')}"
Function FixtureCompileAtomicExtraction
!insertmacro extractUsing7za "${path.join(root, 'program.7z')}"
FunctionEnd` : ''}
Function ${prefix}FixtureShow
Call \${FixtureShow}
StrCpy $FixturePhase "show"
Call ${prefix}FixtureRecord
FunctionEnd
Function ${prefix}FixtureLeave
!ifdef FixtureLeave
Call \${FixtureLeave}
!endif
StrCpy $FixturePhase "finished"
Call ${prefix}FixtureRecord
FileClose $FixtureLog
Quit
FunctionEnd
Function ${prefix}FixtureRecord
FindWindow $2 "#32770" "" $HWNDPARENT
GetDlgItem $2 $2 1050
System::Call 'user32::GetWindowLong(p r2, i -16) i.r0'
IntOp $0 $0 & 8
SendMessage $2 0x408 0 0 $1
GetDlgItem $6 $HWNDPARENT 1038
System::Call 'user32::GetWindowText(p r6, t .r3, i 1024)'
System::Call 'user32::GetWindowLong(p r2, i -16) i.r4'
IntOp $4 $4 & 0x10000000
System::Call 'user32::GetWindowText(p $mui.InstFilesPage.Text, t .r5, i 1024)'
FileWriteUTF16LE $FixtureLog "$FixturePhase|$0|$1|$3|$4|$5$\\r$\\n"
FunctionEnd
Function .onInit
${uninstall ? `WriteUninstaller "${path.join(root, "uninstall.exe")}"
Quit` : `!insertmacro DesktopUpdateProgressInit
${!update && !silent ? '; Skip only directory selection in the fixture; isUpdated remains false.\nStrCpy $DesktopUpdateMode "1"' : ""}
FileOpen $FixtureLog "${path.join(root, "activity.log")}" w`}
FunctionEnd
${uninstall ? `Function un.onInit
FileOpen $FixtureLog "${path.join(root, "activity.log")}" w
FunctionEnd
Section
SectionEnd` : ""}
Section "${uninstall ? "un.install" : "install"}"
${uninstall ? `!ifmacrodef DesktopUninstallProgressStart
!insertmacro DesktopUninstallProgressStart
!endif` : ""}
!ifmacrodef DesktopProgressAdvance
!insertmacro DesktopProgressAdvance 10
!endif
StrCpy $FixtureCount 0
${measured ? `SetOutPath "${path.join(root, 'extracted')}"
!insertmacro DesktopProgressMeasuredStart
StrCpy $FixturePhase "measured"
Call FixtureRecord
!insertmacro DesktopProgressStage "正在解压程序文件…"
Push 100
Push 50
Call DesktopExtractProgress
StrCpy $FixturePhase "extracting"
Call FixtureRecord
!ifmacrodef DesktopExtract7zMeasured
!insertmacro DesktopExtract7zMeasured "${path.join(root, 'program.7z')}"
!else
Nsis7z::Extract "${path.join(root, 'program.7z')}"
!endif
StrCpy $FixturePhase "extracted"
Call FixtureRecord` : ''}
retry:
!ifmacrodef DesktopProgressAdvance
!insertmacro DesktopProgressAdvance 40
!endif
StrCpy $FixturePhase "waiting"
Call ${prefix}FixtureRecord
Sleep 20
DetailPrint "Waiting for shutdown acknowledgement"
StrCpy $FixturePhase "retry"
Call ${prefix}FixtureRecord
IntOp $FixtureCount $FixtureCount + 1
IntCmp $FixtureCount 3 done retry done
done:
${measured ? '!insertmacro DesktopProgressStage "正在完成安装…"\nStrCpy $FixturePhase "finalizing"\nCall FixtureRecord' : ""}
!ifmacrodef DesktopProgressAdvance
!insertmacro DesktopProgressAdvance 25
!endif
${uninstall && fail ? `!ifmacrodef DesktopProgressStop
!insertmacro DesktopProgressStop 0
!endif` : uninstall ? `!ifmacrodef DesktopUninstallProgressEnd
!insertmacro DesktopUninstallProgressEnd
!endif` : ""}
${fail ? 'Abort "Fixture failure"' : ""}
SectionEnd
`, "utf8");
  const build = spawnSync(toolchain.binary, ["/V2", "/INPUTCHARSET", "UTF8", source], {
    env: { ...process.env, NSISDIR: toolchain.root }, encoding: "utf8", windowsHide: true, timeout: 30_000
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  if (uninstall) {
    const generate = spawnSync(path.join(root, "fixture.exe"), [], { windowsHide: true, timeout: 10_000 });
    assert.equal(generate.error, undefined);
    assert.ok(fs.existsSync(path.join(root, "uninstall.exe")));
  }
  const args = silent ? ["/S"] : update && !uninstall ? ["--updated"] : [];
  // Run this isolated uninstaller in place so the process result covers its UI,
  // rather than just NSIS's parent process that copies itself into TEMP.
  if (uninstall) args.push(`_?=${root}`);
  const run = spawnSync(path.join(root, uninstall ? "uninstall.exe" : "fixture.exe"), args, {
    windowsHide: true, timeout: 10_000
  });
  assert.equal(run.error, undefined, "fixture must finish without interaction");
  const log = fs.readFileSync(path.join(root, "activity.log"), "utf16le").trim();
  // Only the unique fixture's update diagnostics may be removed.
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith(`${brand.storageNamespace}-update-`) && name.endsWith(".log")) fs.rmSync(path.join(os.tmpdir(), name));
  }
  return log ? log.split(/\r?\n/u).map((line) => {
    const [phase, marquee, position, subtitle, visible, status] = line.split("|");
    return { phase, marquee: Number(marquee), position: Number(position), subtitle, visible: Number(visible) !== 0, status };
  }) : [];
}

test("Windows total install progress stays visible and never regresses during waits", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t);
  assert.equal(samples.filter(({ phase }) => phase === "waiting").length, 3);
  for (const sample of samples.filter(({ phase }) => phase !== "finished")) {
    assert.equal(sample.marquee, 0, `${sample.phase} must not show scrolling activity`);
    assert.equal(sample.visible, true);
  }
  assert.equal(samples.at(-1).marquee, 0);
  assert.equal(samples.at(-1).position, 100);
  const positions = samples.map(s => s.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("Windows extraction maps real bytes into the persistent total progress", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { measured: true });
  const extracted = samples.find(sample => sample.phase === 'extracted');
  assert.equal(samples.find(sample => sample.phase === 'measured').visible, true);
  assert.equal(extracted.status, "正在复制程序文件…");
  assert.equal(extracted.marquee, 0);
  assert.equal(extracted.visible, true);
  assert.equal(extracted.position, 85);
  assert.ok(samples.filter(s => s.phase !== "finished").every(s => s.position < 100));
});

test("Windows installation shows each stage only above the progress bar", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { measured: true, update: false });
  for (const phase of ["extracting", "extracted", "finalizing"]) {
    const sample = samples.find(item => item.phase === phase);
    assert.equal(sample.subtitle, "", `${phase} must not repeat the stage in the header`);
    assert.ok(sample.status.startsWith("正在"), `${phase} must retain the progress status`);
  }
});

test("Windows install failure stops activity without claiming completion", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { fail: true });
  assert.equal(samples.at(-1).phase, "finished");
  assert.equal(samples.at(-1).marquee, 0);
  assert.equal(samples.at(-1).position, 40);
});

test("Windows uninstall keeps total progress visible across deletion retries", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { uninstall: true });
  assert.equal(samples.filter(({ phase }) => phase === "waiting").length, 3);
  for (const sample of samples.filter(({ phase }) => phase !== "finished" && phase !== "show")) {
    assert.equal(sample.marquee, 0);
    assert.equal(sample.visible, true);
  }
  assert.equal(samples.at(-1).marquee, 0);
  assert.equal(samples.at(-1).position, 100);
});

test("Windows uninstall shutdown failure stops activity without a completed bar", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { uninstall: true, fail: true });
  assert.equal(samples.at(-1).phase, "finished");
  assert.equal(samples.at(-1).marquee, 0);
  assert.ok(samples.at(-1).position < 100);
});

test("Windows ordinary silent install does not show activity UI", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { silent: true });
  assert.ok(samples.every(({ marquee }) => marquee === 0));
  assert.ok(samples.every(({ phase }) => phase !== "show"));
});

test("Windows update keeps preparation above the progress bar and leaves the header subtitle empty", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t);
  assert.equal(samples[0].status, "正在准备安装…");
  assert.ok(samples.every(sample => sample.subtitle === ""));
});

test("Windows manual install keeps its total progress bar visible", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { update: false });
  assert.equal(samples[0].marquee, 0);
  assert.equal(samples[0].visible, true);
  assert.equal(samples[0].subtitle, "");
  assert.equal(samples[0].status, "正在准备安装…");
  assert.equal(samples.at(-1).marquee, 0);
  assert.equal(samples.at(-1).position, 100);
});

test("Windows ordinary silent uninstall does not create activity UI", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { uninstall: true, silent: true });
  assert.ok(samples.every(({ marquee }) => marquee === 0));
  assert.ok(samples.every(({ phase }) => phase !== "show"));
});

test("Windows failure after extraction keeps its reached total instead of claiming completion", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { measured: true, fail: true });
  assert.equal(samples.at(-1).phase, "finished");
  assert.equal(samples.at(-1).visible, true);
  assert.equal(samples.at(-1).position, 85);
  assert.ok(samples.every(s => s.position < 100));
});

test("Windows stage transitions replace the completed extraction percentage", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { measured: true });
  const copied = samples.find(s => s.phase === "extracted");
  const finalizing = samples.find(s => s.phase === "finalizing");
  assert.equal(copied.status, "正在复制程序文件…");
  assert.equal(finalizing.status, "正在完成安装…");
  assert.doesNotMatch(finalizing.status, /100%/u);
  assert.equal(finalizing.position, 85);
});

test("Windows extraction updates only the total bar without a second percentage", { skip: process.platform !== "win32" }, (t) => {
  const samples = runActivityFixture(t, { measured: true });
  const extracting = samples.find(s => s.phase === "extracting");
  assert.equal(extracting.position, 50);
  assert.equal(extracting.status, "正在解压程序文件…");
  assert.ok(samples.every(s => !s.status.includes("%")));
});
