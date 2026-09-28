import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveNsisToolchain } from "../scripts/build-safe-repair.mjs";
import { writeInstallerInclude } from "../scripts/lib/brand-installers.mjs";
import { loadBrandConfig, brandInstallerDir } from "../scripts/lib/brand-config.mjs";

test("Windows update shows progress even for legacy silent clients and skips data selection", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-ui-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ["cutej", "zenmind"]) {
    const brand = loadBrandConfig(process.cwd(), id);
    writeInstallerInclude(root, brand);
    const script = fs.readFileSync(path.join(brandInstallerDir(root, brand), "installer.nsh"), "utf8");
    assert.match(script, /!macro customInit\s+!insertmacro DesktopUpdateProgressInit/);
    assert.match(script, /!macro customFinishPage/);
    assert.match(script, /!insertmacro DesktopUpdateStage "install-complete"/);
    assert.match(script, /!insertmacro DesktopUpdateStage "launch-requested"/);
    assert.match(script, /!insertmacro DesktopUpdateStage "cleanup-start"/);
    assert.match(script, /!insertmacro DesktopUpdateStage "cleanup-complete"/);
    assert.match(script, /!insertmacro DesktopUpdateStage "files-installed"/);
  }
});

for (const pluginRegistration of ["before", "after"]) {
test(`generated update progress compiles and runs with plugin registration ${pluginRegistration} the brand include`, { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-ui-compile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const toolchain = resolveNsisToolchain();
  const cache = path.dirname(toolchain.root);
  const plugins = fs.readdirSync(cache).filter((name) => name.startsWith("nsis-resources-"))
    .map((name) => path.join(cache, name, "plugins", "x86-unicode"))
    .find((dir) => fs.existsSync(path.join(dir, "StdUtils.dll")));
  assert.ok(plugins, "NSIS StdUtils resource bundle must be available");
  const require = createRequire(import.meta.url);
  const { NsisScriptGenerator } = require("app-builder-lib/out/targets/nsis/nsisScriptGenerator.js");
  const flags = new NsisScriptGenerator();
  flags.flags(["updated"]);
  const templates = path.resolve("node_modules/app-builder-lib/templates/nsis");
  const brand = { ...loadBrandConfig(process.cwd(), "cutej"), storageNamespace: path.basename(root) };
  writeInstallerInclude(root, brand);
  const source = path.join(root, "smoke.nsi");
  fs.writeFileSync(source, `Unicode true
Name "Update UX compilation fixture"
OutFile "${path.join(root, "smoke.exe")}"
RequestExecutionLevel user
!addincludedir "${templates}"
!addincludedir "${path.join(templates, "include")}"
${pluginRegistration === "before" ? `!addplugindir /x86-unicode "${plugins}"` : ""}
!include StdUtils.nsh
; Replace only the OS launch boundary: never launch or install a real application.
!undef StdUtils.ExecShellAsUser
!define StdUtils.ExecShellAsUser "!insertmacro FixtureLaunch"
!macro FixtureLaunch RESULT FILE VERB ARGS
FileOpen $0 "${path.join(root, "launched.txt")}" a
FileSeek $0 0 END
FileWrite $0 "launch$\\r$\\n"
FileClose $0
!macroend
${flags.build()}
!include "${path.join(brandInstallerDir(root, brand), "installer.nsh")}"
${pluginRegistration === "after" ? `!addplugindir /x86-unicode "${plugins}"` : ""}
!define PRODUCT_NAME "Fixture"
!define PRODUCT_FILENAME "Fixture"
!define VERSION "1.0.0"
!include common.nsh
!include MUI2.nsh
Var launchLink
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
Function .onInit
!insertmacro DesktopUpdateProgressInit
FileOpen $0 "${path.join(root, "log-path.txt")}" w
FileWrite $0 "$DesktopUpdateLog"
FileClose $0
FunctionEnd
Section
!insertmacro DesktopUpdateStage "cleanup-start"
!insertmacro DesktopUpdateStage "files-installed"
SectionEnd
`, "utf8");
  const result = spawnSync(toolchain.binary, ["/INPUTCHARSET", "UTF8", source], {
    env: { ...process.env, NSISDIR: toolchain.root }, encoding: "utf8", windowsHide: true, timeout: 30_000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.statSync(path.join(root, "smoke.exe")).size > 0);
  // Exercise the legacy /S hand-off: it must show its progress page, skip configuration
  // and finish pages, invoke the launch boundary once, and exit without a button click.
  const run = spawnSync(path.join(root, "smoke.exe"), ["--updated", "/S", "--force-run"], {
    encoding: "utf8", timeout: 15_000, windowsHide: true
  });
  const logPathFile = path.join(root, "log-path.txt");
  if (fs.existsSync(logPathFile)) {
    const log = fs.readFileSync(logPathFile, "utf8");
    if (path.dirname(log).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(log).startsWith(`${brand.storageNamespace}-update-`)) {
      t.after(() => fs.rmSync(log, { force: true }));
    }
  }
  assert.equal(run.error, undefined, "fixture must complete without user interaction");
  assert.equal(run.status, 0);
  assert.equal(fs.readFileSync(path.join(root, "launched.txt"), "utf8").trim(), "launch");
  const stages = fs.readFileSync(fs.readFileSync(logPathFile, "utf8"), "utf8");
  assert.match(stages, /installer-start version=1\.0\.0/);
  assert.match(stages, /progress-visible/);
  assert.match(stages, /files-installed[\s\S]*install-complete[\s\S]*launch-requested[\s\S]*installer-exit/);
  assert.doesNotMatch(stages, /install-failed|user-aborted/);
  const silentInstall = spawnSync(path.join(root, "smoke.exe"), ["/S"], {
    encoding: "utf8", timeout: 15_000, windowsHide: true
  });
  assert.equal(silentInstall.status, 0);
  assert.equal(fs.readFileSync(logPathFile, "utf8"), "", "ordinary silent installs do not enter update UI");
  assert.equal(fs.readFileSync(path.join(root, "launched.txt"), "utf8").trim(), "launch", "ordinary silent install must not auto-launch");
});
}
