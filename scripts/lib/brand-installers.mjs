import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP_PACKAGE_NAME, INSTALLER_SHUTDOWN_ARG, resolveBrandId } from "./brand-model.mjs";
import { brandInstallerDir } from "./brand-paths.mjs";

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  fs.writeFileSync(filePath, content);
}

function escapeNsisText(value) {
  return String(value).replace(/\$/gu, "$$").replace(/"/gu, "$\\\"");
}

function nsisIdentifier(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_]/gu, "");
  return normalized || "Desktop";
}

export function writeInstallerInclude(rootDir, brand) {
  const productName = escapeNsisText(brand.productName);
  const dataRegistryKey = `Software\\${brand.storageNamespace}`;
  const nsisPrefix = nsisIdentifier(brand.productName);
  const shutdownArg = brand.installer.shutdownArg;
  const storageNamespace = escapeNsisText(brand.storageNamespace);
  const programDataDirName = escapeNsisText(brand.paths.programDataDirName);
  const runtimeRootDirName = escapeNsisText(brand.paths.runtimeRootDirName);
  const installOwnerToken = `${brand.appId}|${brand.storageNamespace}|install-root|v1`;
  const dataOwnerToken = `${brand.appId}|${brand.storageNamespace}|data-root|v1`;
  const programOwnerToken = `${brand.appId}|${brand.storageNamespace}|program-root|v1`;
  const content = `!include nsDialogs.nsh
!include FileFunc.nsh

!ifdef DELETE_APP_DATA_ON_UNINSTALL
  !error "Windows data cleanup must remain owned by the validated custom uninstaller"
!endif

Var /GLOBAL DesktopDataRoot
Var /GLOBAL DesktopDataRootLayoutVersion
Var /GLOBAL DesktopDefaultInstallDir
Var /GLOBAL DesktopPreviousInstallDir
Var /GLOBAL DesktopProgramDataRoot
Var /GLOBAL DesktopProgramOwnerMarker
Var /GLOBAL DesktopShutdownAckPath
Var /GLOBAL DesktopShutdownStatus
Var /GLOBAL DesktopProcessCleanupDone
Var /GLOBAL DesktopProcessCleanupStatus
Var /GLOBAL DesktopProcessSurvivors
!ifdef BUILD_UNINSTALLER
Var /GLOBAL DesktopOwnedDataRoot
Var /GLOBAL DesktopDataRemoved
Var /GLOBAL DesktopCleanupWarning
!endif
!ifndef BUILD_UNINSTALLER
Var /GLOBAL DesktopDataRootStored
Var /GLOBAL DesktopDataRootAdoptConfirmed
Var /GLOBAL DesktopDataParent
Var /GLOBAL DesktopDataRootInput
Var /GLOBAL DesktopDataRootBrowseButton
Var /GLOBAL DesktopDataRootErrorLabel
!endif

!macro DesktopReadOwnerMarker ROOT EXPECTED RESULT
  StrCpy \${RESULT} "0"
  ClearErrors
  FileOpen $R8 "\${ROOT}\\.desktop-owner" r
  \${ifNot} \${Errors}
    FileRead $R8 $R9
    FileClose $R8
    StrCmp $R9 "\${EXPECTED}" 0 +2
    StrCpy \${RESULT} "1"
  \${endif}
!macroend

!macro DesktopReadOwnerFile FILE EXPECTED RESULT
  StrCpy \${RESULT} "0"
  ClearErrors
  FileOpen $R8 "\${FILE}" r
  \${ifNot} \${Errors}
    FileRead $R8 $R9
    FileClose $R8
    StrCmp $R9 "\${EXPECTED}" 0 +2
    StrCpy \${RESULT} "1"
  \${endif}
!macroend

!macro DesktopDirectoryHasEntries ROOT RESULT
  StrCpy \${RESULT} "0"
  ClearErrors
  FindFirst $R4 $R5 "\${ROOT}\\*.*"
  \${ifNot} \${Errors}
    \${Do}
      \${if} $R5 == ""
        \${ExitDo}
      \${endif}
      \${if} $R5 != "."
      \${andIf} $R5 != ".."
        StrCpy \${RESULT} "1"
        \${ExitDo}
      \${endif}
      FindNext $R4 $R5
    \${Loop}
    FindClose $R4
  \${endif}
!macroend

!macro DesktopWriteOwnerMarker ROOT TOKEN
  CreateDirectory "\${ROOT}"
  ClearErrors
  FileOpen $R8 "\${ROOT}\\.desktop-owner" w
  \${if} \${Errors}
    MessageBox MB_ICONSTOP "无法在应用专属目录中写入安全标记：$\\r$\\n\${ROOT}"
    Abort
  \${endif}
  FileWrite $R8 "\${TOKEN}"
  FileClose $R8
!macroend

!macro DesktopWriteOwnerFile FILE TOKEN
  ClearErrors
  FileOpen $R8 "\${FILE}" w
  \${if} \${Errors}
    MessageBox MB_ICONSTOP "无法写入应用所有权标记：$\\r$\\n\${FILE}"
    Abort
  \${endif}
  FileWrite $R8 "\${TOKEN}"
  FileClose $R8
!macroend

!macro DesktopRestoreOwnerMarker ROOT TOKEN
  CreateDirectory "\${ROOT}"
  ClearErrors
  FileOpen $R8 "\${ROOT}\\.desktop-owner" w
  \${ifNot} \${Errors}
    FileWrite $R8 "\${TOKEN}"
    FileClose $R8
  \${endif}
!macroend

!macro DesktopForceRemoveOwnedRoot ROOT
  System::Call 'kernel32::SetEnvironmentVariableW(w "DESKTOP_OWNED_ROOT_TO_REMOVE", w "\${ROOT}") i.r6'
  nsExec::ExecToLog \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; $$target = [string]$$env:DESKTOP_OWNED_ROOT_TO_REMOVE; if ([string]::IsNullOrWhiteSpace($$target)) { exit 2 }; $$deadline = [DateTime]::UtcNow.AddSeconds(15); do { if (-not (Test-Path -LiteralPath $$target)) { exit 0 }; try { Remove-Item -LiteralPath $$target -Recurse -Force -ErrorAction Stop } catch {}; Start-Sleep -Milliseconds 250 } while ([DateTime]::UtcNow -lt $$deadline); if (Test-Path -LiteralPath $$target) { exit 1 }; exit 0"\`
  Pop $R3
  System::Call 'kernel32::SetEnvironmentVariableW(w "DESKTOP_OWNED_ROOT_TO_REMOVE", w "") i.r6'
!macroend

!macro DesktopValidateOwnedRoot ROOT RESULT
  StrCpy \${RESULT} "1"
  \${if} "\${ROOT}" == ""
    StrCpy \${RESULT} "0"
  \${endif}
  StrCpy $R6 "\${ROOT}" 2
  \${if} $R6 == "\\\\"
    StrCpy \${RESULT} "0"
  \${endif}
  StrLen $R6 "\${ROOT}"
  \${if} $R6 == 3
    StrCpy $R6 "\${ROOT}" 1 1
    StrCpy $R7 "\${ROOT}" 1 2
    \${if} $R6 == ":"
    \${andIf} $R7 == "\\"
      StrCpy \${RESULT} "0"
    \${endif}
  \${endif}
  StrCmp "\${ROOT}" "$PROFILE" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$DESKTOP" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$DOCUMENTS" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$PROFILE\\Downloads" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$APPDATA" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$LOCALAPPDATA" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$WINDIR" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$PROGRAMFILES" 0 +2
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$PROGRAMFILES64" 0 +2
  StrCpy \${RESULT} "0"
  \${if} \${FileExists} "\${ROOT}\\*.*"
    System::Call 'kernel32::GetFileAttributesW(w "\${ROOT}") i.r6'
    IntOp $R7 $R6 & 0x400
    \${if} $R7 != 0
      StrCpy \${RESULT} "0"
    \${endif}
  \${endif}
  \${GetParent} "\${ROOT}" $R6
  \${if} \${FileExists} "$R6\\*.*"
    System::Call 'kernel32::GetFileAttributesW(w "$R6") i.r7'
    IntOp $R7 $R7 & 0x400
    \${if} $R7 != 0
      StrCpy \${RESULT} "0"
    \${endif}
  \${endif}
!macroend

!macro DesktopValidateDataRoot ROOT NORMALIZED RESULT
  StrCpy \${NORMALIZED} ""
  StrCpy \${RESULT} "0"
  \${if} "\${ROOT}" != ""
  \${andIf} \${FileExists} "\${ROOT}\\*.*"
    GetFullPathName \${NORMALIZED} "\${ROOT}"
    \${if} "\${NORMALIZED}" != ""
      \${GetFileName} "\${NORMALIZED}" $R6
      \${if} $R6 == "${runtimeRootDirName}"
        !insertmacro DesktopValidateOwnedRoot \${NORMALIZED} \${RESULT}
      \${endif}
    \${endif}
  \${endif}
!macroend

!macro DesktopResolveDefaultInstallDir
  StrCpy $DesktopDefaultInstallDir "$LOCALAPPDATA\\Programs\\\${APP_FILENAME}"
!macroend

!macro DesktopValidateInstallRoot ROOT RESULT
  !insertmacro DesktopValidateOwnedRoot \${ROOT} \${RESULT}
  \${GetFileName} "\${ROOT}" $R6
  StrCmp "$R6" "\${APP_FILENAME}" +2 0
  StrCpy \${RESULT} "0"
  StrCmp "\${ROOT}" "$APPDATA\\${programDataDirName}" 0 +2
  StrCpy \${RESULT} "0"
  \${if} $DesktopDataRoot != ""
    StrCmp "\${ROOT}" "$DesktopDataRoot" 0 +2
    StrCpy \${RESULT} "0"
  \${endif}
!macroend

!ifndef BUILD_UNINSTALLER
Function ${nsisPrefix}EnsureDataRootDefault
  \${if} $DesktopDataRoot != ""
    Return
  \${endif}
  StrCpy $DesktopDataRootStored "0"
  ReadRegStr $DesktopDataRoot HKCU "${dataRegistryKey}" "DataRoot"
  StrCpy $DesktopDataRootLayoutVersion "0"
  ReadRegDWORD $DesktopDataRootLayoutVersion HKCU "${dataRegistryKey}" "DataRootLayoutVersion"
  \${if} $DesktopDataRootLayoutVersion != "2"
    StrCpy $R0 "0"
    ReadRegDWORD $R0 HKCU "${dataRegistryKey}" "LayoutVersion"
    \${if} $R0 == "2"
      StrCpy $DesktopDataRootLayoutVersion "2"
    \${endif}
  \${endif}
  \${if} $DesktopDataRoot != ""
    \${if} $DesktopDataRootLayoutVersion == "2"
      \${if} \${FileExists} "$DesktopDataRoot\\*.*"
        !insertmacro DesktopDirectoryHasEntries $DesktopDataRoot $R0
        \${if} $R0 == "1"
          StrCpy $DesktopDataRootStored "1"
        \${else}
          StrCpy $DesktopDataRootStored "0"
        \${endif}
      \${else}
        StrCpy $DesktopDataRootStored "0"
      \${endif}
    \${else}
      StrCpy $DesktopDataRootStored "1"
    \${endif}
  \${endif}
  \${if} $DesktopDataRoot == ""
    \${if} \${FileExists} "$PROFILE\\${runtimeRootDirName}\\*.*"
      StrCpy $DesktopDataRoot "$PROFILE\\${runtimeRootDirName}"
      StrCpy $DesktopDataRootStored "1"
    \${else}
      StrCpy $DesktopDataRoot "$PROFILE\\${runtimeRootDirName}"
    \${endif}
    StrCpy $DesktopDataRootLayoutVersion "0"
  \${endif}
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
Function un.${nsisPrefix}EnsureDataRootDefault
  ReadRegStr $DesktopDataRoot HKCU "${dataRegistryKey}" "DataRoot"
  StrCpy $DesktopDataRootLayoutVersion "0"
  ReadRegDWORD $DesktopDataRootLayoutVersion HKCU "${dataRegistryKey}" "DataRootLayoutVersion"
  \${if} $DesktopDataRootLayoutVersion != "2"
    StrCpy $R0 "0"
    ReadRegDWORD $R0 HKCU "${dataRegistryKey}" "LayoutVersion"
    \${if} $R0 == "2"
      StrCpy $DesktopDataRootLayoutVersion "2"
    \${endif}
  \${endif}
  \${if} $DesktopDataRoot == ""
    StrCpy $DesktopDataRoot "$PROFILE\\${runtimeRootDirName}"
    StrCpy $DesktopDataRootLayoutVersion "0"
  \${endif}
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
!macro DesktopValidateStoredDataRootForInstall
  \${if} $DesktopDataRootStored == "1"
  \${andIf} $DesktopDataRootLayoutVersion == "2"
    !insertmacro DesktopReadOwnerMarker $DesktopDataRoot "${dataOwnerToken}" $R0
    !insertmacro DesktopValidateOwnedRoot $DesktopDataRoot $R1
    \${if} $R1 != "1"
      MessageBox MB_ICONSTOP "${productName} 数据目录未通过路径安全校验，安装已停止：$\\r$\\n$DesktopDataRoot" /SD IDOK
      SetErrorLevel 4
      Abort
    \${endif}
    \${if} $R0 != "1"
      \${if} \${FileExists} "$DesktopDataRoot\\.desktop-owner"
        MessageBox MB_ICONSTOP "${productName} 数据目录的安全标记不匹配，安装已停止：$\\r$\\n$DesktopDataRoot" /SD IDOK
        SetErrorLevel 4
        Abort
      \${elseIf} \${Silent}
        MessageBox MB_ICONSTOP "${productName} 数据目录缺少安全标记，静默安装无法确认沿用历史数据，安装已停止：$\\r$\\n$DesktopDataRoot" /SD IDOK
        SetErrorLevel 4
        Abort
      \${endif}
    \${endif}
  \${endif}
!macroend

Function ${nsisPrefix}BrowseDataDirectory
  \${NSD_GetText} $DesktopDataRootInput $DesktopDataParent
  nsDialogs::SelectFolderDialog "选择 ${productName} 数据存放位置" "$DesktopDataParent"
  Pop $0
  \${if} $0 != "error"
    \${GetFileName} "$0" $R3
    \${if} $R3 == "${runtimeRootDirName}"
      StrCpy $DesktopDataParent "$0"
    \${else}
      StrLen $R1 "$0"
      IntOp $R1 $R1 - 1
      StrCpy $R2 "$0" 1 $R1
      \${if} $R2 == "\\"
        StrCpy $DesktopDataParent "$0${runtimeRootDirName}"
      \${else}
        StrCpy $DesktopDataParent "$0\\${runtimeRootDirName}"
      \${endif}
    \${endif}
    \${NSD_SetText} $DesktopDataRootInput "$DesktopDataParent"
  \${endif}
FunctionEnd

Function ${nsisPrefix}ValidateDataRootInput
  \${NSD_GetText} $DesktopDataRootInput $DesktopDataParent
  \${GetFileName} "$DesktopDataParent" $R3
  GetDlgItem $R4 $HWNDPARENT 1
  \${if} $R3 == "${runtimeRootDirName}"
    EnableWindow $R4 1
    \${NSD_Hide} $DesktopDataRootErrorLabel
  \${else}
    EnableWindow $R4 0
    \${NSD_Show} $DesktopDataRootErrorLabel
  \${endif}
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
Function ${nsisPrefix}DataDirectoryPage
  \${if} \${Silent}
    Abort
  \${endif}
  Call ${nsisPrefix}EnsureDataRootDefault
  StrCpy $DesktopDataParent "$DesktopDataRoot"
  nsDialogs::Create 1018
  Pop $0
  \${if} $0 == "error"
    Abort
  \${endif}
  \${NSD_CreateLabel} 0 0 100% 20u "请选择完整的 ${productName} 数据目录。"
  Pop $0
  \${NSD_CreateLabel} 0 24u 100% 12u "路径格式错误：数据目录必须以 ${runtimeRootDirName} 结尾，否则无法安装。"
  Pop $DesktopDataRootErrorLabel
  SetCtlColors $DesktopDataRootErrorLabel 0xD92D20 transparent
  \${NSD_CreateDirRequest} 0 40u 74% 12u "$DesktopDataParent"
  Pop $DesktopDataRootInput
  \${NSD_OnChange} $DesktopDataRootInput ${nsisPrefix}ValidateDataRootInput
  \${NSD_CreateBrowseButton} 78% 39u 22% 14u "浏览..."
  Pop $DesktopDataRootBrowseButton
  \${NSD_OnClick} $DesktopDataRootBrowseButton ${nsisPrefix}BrowseDataDirectory
  Call ${nsisPrefix}ValidateDataRootInput
  nsDialogs::Show
FunctionEnd

Function ${nsisPrefix}DataDirectoryPageLeave
  StrCpy $DesktopDataRootAdoptConfirmed "0"
  StrCpy $DesktopDataRootStored "0"
  \${NSD_GetText} $DesktopDataRootInput $DesktopDataParent
  \${if} $DesktopDataParent == ""
    MessageBox MB_ICONEXCLAMATION "请选择 ${productName} 数据存放位置。"
    Abort
  \${endif}
  \${GetFileName} "$DesktopDataParent" $R3
  \${if} $R3 != "${runtimeRootDirName}"
    MessageBox MB_ICONEXCLAMATION "${productName} 数据目录必须以 ${runtimeRootDirName} 结尾。"
    Abort
  \${endif}
  StrCpy $R0 "$DesktopDataParent" 2
  StrCmp $R0 "\\\\" ${nsisPrefix}DataDirectoryUnsafe
  StrLen $R0 "$DesktopDataParent"
  \${if} $R0 == 3
    StrCpy $R0 "$DesktopDataParent" 1 1
    StrCpy $R1 "$DesktopDataParent" 1 2
    \${if} $R0 == ":"
    \${andIf} $R1 == "\\"
      Goto ${nsisPrefix}DataDirectoryUnsafe
    \${endif}
  \${endif}
  StrCmp "$DesktopDataParent" "$WINDIR" ${nsisPrefix}DataDirectoryUnsafe
  StrCmp "$DesktopDataParent" "$PROGRAMFILES" ${nsisPrefix}DataDirectoryUnsafe
  StrCmp "$DesktopDataParent" "$PROGRAMFILES64" ${nsisPrefix}DataDirectoryUnsafe
  ClearErrors
  CreateDirectory "$DesktopDataParent"
  IfErrors ${nsisPrefix}DataDirectoryCreateFailed
  GetFullPathName $DesktopDataParent "$DesktopDataParent"
  StrCpy $R0 "$DesktopDataParent" 2
  StrCmp $R0 "\\\\" ${nsisPrefix}DataDirectoryUnsafe
  StrLen $R0 "$DesktopDataParent"
  \${if} $R0 == 3
    StrCpy $R0 "$DesktopDataParent" 1 1
    StrCpy $R1 "$DesktopDataParent" 1 2
    \${if} $R0 == ":"
    \${andIf} $R1 == "\\"
      Goto ${nsisPrefix}DataDirectoryUnsafe
    \${endif}
  \${endif}
  StrCmp "$DesktopDataParent" "$WINDIR" ${nsisPrefix}DataDirectoryUnsafe
  StrCmp "$DesktopDataParent" "$PROGRAMFILES" ${nsisPrefix}DataDirectoryUnsafe
  StrCmp "$DesktopDataParent" "$PROGRAMFILES64" ${nsisPrefix}DataDirectoryUnsafe
  System::Call 'kernel32::GetFileAttributesW(w "$DesktopDataParent") i.r0'
  IntOp $R1 $R0 & 0x400
  \${if} $R1 != 0
    Goto ${nsisPrefix}DataDirectoryUnsafe
  \${endif}
  StrCpy $DesktopDataRoot "$DesktopDataParent"
  ClearErrors
  CreateDirectory "$DesktopDataRoot"
  IfErrors ${nsisPrefix}DataDirectoryCreateFailed
  GetFullPathName $DesktopDataRoot "$DesktopDataRoot"
  !insertmacro DesktopDirectoryHasEntries $DesktopDataRoot $R2
  \${if} $R2 == "0"
    Goto ${nsisPrefix}DataDirectoryReady
  \${endif}
  !insertmacro DesktopReadOwnerMarker $DesktopDataRoot "${dataOwnerToken}" $R0
  !insertmacro DesktopValidateOwnedRoot $DesktopDataRoot $R1
  \${if} $R0 == "1"
  \${andIf} $R1 == "1"
    Goto ${nsisPrefix}DataDirectoryReady
  \${endif}
  \${if} $DesktopDataRoot == "$PROFILE\\${runtimeRootDirName}"
    StrCpy $DesktopDataRootAdoptConfirmed "1"
    Goto ${nsisPrefix}DataDirectoryReady
  \${endif}
  \${if} $R1 == "1"
  \${andIfNot} \${FileExists} "$DesktopDataRoot\\.desktop-owner"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "目标目录已有数据但缺少 ${productName} 所有权标记：$\\r$\\n$DesktopDataRoot$\\r$\\n$\\r$\\n仅当你确认这是历史 ${productName} 数据目录时才继续。安装器会保留全部现有文件并补写所有权与注册表记录；以后卸载时选择清理数据将允许删除该目录。" /SD IDNO IDYES ${nsisPrefix}DataDirectoryAdoptLegacy
    Abort
  \${endif}
  MessageBox MB_ICONEXCLAMATION "目标专属目录已存在但不属于 ${productName}：$\\r$\\n$DesktopDataRoot$\\r$\\n请改选其他位置。"
  Abort
${nsisPrefix}DataDirectoryAdoptLegacy:
  StrCpy $DesktopDataRootAdoptConfirmed "1"
  Goto ${nsisPrefix}DataDirectoryReady
${nsisPrefix}DataDirectoryCreateFailed:
  MessageBox MB_ICONEXCLAMATION "所选父目录无法创建，请改选其他位置。"
  Abort
${nsisPrefix}DataDirectoryUnsafe:
  MessageBox MB_ICONEXCLAMATION "不能把系统目录、网络路径、重解析目录或磁盘根目录作为数据存放位置。请改选普通父目录。"
  Abort
${nsisPrefix}DataDirectoryReady:
FunctionEnd
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro stopManagedServiceProcesses
  \${if} $DesktopProcessCleanupDone != "1"
    DetailPrint "Stopping ${productName} app and managed service processes..."
    System::Call 'Kernel32::SetEnvironmentVariable(t,t)i("DESKTOP_MANAGED_APP_EXE", "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}").r0'
    StrCpy $DesktopProgramOwnerMarker "$APPDATA\\${programDataDirName}.desktop-owner"
    !insertmacro DesktopReadOwnerFile $DesktopProgramOwnerMarker "${programOwnerToken}" $R0
    \${if} $R0 == "1"
      System::Call 'Kernel32::SetEnvironmentVariable(t,t)i("DESKTOP_MANAGED_PROGRAM_ROOT", "$APPDATA\\${programDataDirName}").r0'
    \${else}
      System::Call 'Kernel32::SetEnvironmentVariable(t,t)i("DESKTOP_MANAGED_PROGRAM_ROOT", "").r0'
    \${endif}
    !insertmacro DesktopReadOwnerMarker $DesktopDataRoot "${dataOwnerToken}" $R0
    !insertmacro DesktopValidateOwnedRoot $DesktopDataRoot $R1
    \${if} $R0 == "1"
    \${andIf} $R1 == "1"
      System::Call 'Kernel32::SetEnvironmentVariable(t,t)i("DESKTOP_MANAGED_DATA_ROOT", "$DesktopDataRoot").r0'
    \${else}
      System::Call 'Kernel32::SetEnvironmentVariable(t,t)i("DESKTOP_MANAGED_DATA_ROOT", "").r0'
    \${endif}
    nsExec::ExecToStack \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'Stop'; try { $$appExecutable = [System.IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable('DESKTOP_MANAGED_APP_EXE')); $$programRootValue = [Environment]::GetEnvironmentVariable('DESKTOP_MANAGED_PROGRAM_ROOT'); $$programRoot = if ([string]::IsNullOrWhiteSpace($$programRootValue)) { '' } else { [System.IO.Path]::GetFullPath($$programRootValue).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar }; $$dataRootValue = [Environment]::GetEnvironmentVariable('DESKTOP_MANAGED_DATA_ROOT'); $$dataRoot = if ([string]::IsNullOrWhiteSpace($$dataRootValue)) { '' } else { [System.IO.Path]::GetFullPath($$dataRootValue).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar }; $$snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { Write-Output 'PROBE_FAILED'; exit 21 }; function Test-DesktopExecutableUnlocked { if (-not (Test-Path -LiteralPath $$appExecutable)) { return $$true }; try { $$stream = [System.IO.File]::Open($$appExecutable, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); $$stream.Dispose(); return $$true } catch { return $$false } }; $$roots = @($$snapshot | Where-Object { $$path = [string]$$_.ExecutablePath; $$command = [string]$$_.CommandLine; ($$path -and ($$path.Equals($$appExecutable, [StringComparison]::OrdinalIgnoreCase) -or ($$programRoot -and $$path.StartsWith($$programRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($$dataRoot -and $$path.StartsWith($$dataRoot, [StringComparison]::OrdinalIgnoreCase)))) -or ($$command -and (($$programRoot -and $$command.IndexOf($$programRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($$dataRoot -and $$command.IndexOf($$dataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -ge 0))) }); $$children = @{}; foreach ($$entry in $$snapshot) { $$parent = [int]$$entry.ParentProcessId; if (-not $$children.ContainsKey($$parent)) { $$children[$$parent] = [System.Collections.Generic.List[int]]::new() }; $$children[$$parent].Add([int]$$entry.ProcessId) }; $$ids = [System.Collections.Generic.HashSet[int]]::new(); $$depth = @{}; function Add-DesktopTree([int]$$processId, [int]$$level) { if (-not $$ids.Add($$processId)) { return }; $$depth[$$processId] = $$level; if ($$children.ContainsKey($$processId)) { foreach ($$child in $$children[$$processId]) { Add-DesktopTree $$child ($$level + 1) } } }; foreach ($$root in $$roots) { Add-DesktopTree ([int]$$root.ProcessId) 0 }; if ($$ids.Count -eq 0) { if (Test-DesktopExecutableUnlocked) { exit 0 }; Write-Output 'FILE_LOCKED'; exit 22 }; $$ordered = @($$ids | Sort-Object { -[int]$$depth[$$_] }); foreach ($$processId in $$ordered) { Stop-Process -Id $$processId -Force -ErrorAction SilentlyContinue }; foreach ($$root in $$roots) { if (Get-Process -Id $$root.ProcessId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $$root.ProcessId /T /F 2>$$null | Out-Null } }; $$deadline = [DateTime]::UtcNow.AddSeconds(5); do { $$remaining = @($$ids | Where-Object { Get-Process -Id $$_ -ErrorAction SilentlyContinue }); if ($$remaining.Count -eq 0) { if (Test-DesktopExecutableUnlocked) { exit 0 }; Write-Output 'FILE_LOCKED'; exit 22 }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $$deadline); Write-Output ('SURVIVORS=' + ($$remaining -join ',')); exit 20"\`
    Pop $DesktopProcessCleanupStatus
    Pop $DesktopProcessSurvivors
    StrCpy $DesktopProcessCleanupDone "1"
  \${endif}
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInit
  !insertmacro setInstallModePerUser
  !insertmacro DesktopResolveDefaultInstallDir
  ReadRegStr $DesktopPreviousInstallDir HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  \${if} $DesktopPreviousInstallDir != ""
    GetFullPathName $DesktopPreviousInstallDir "$DesktopPreviousInstallDir"
    \${if} $DesktopPreviousInstallDir != $DesktopDefaultInstallDir
      MessageBox MB_ICONSTOP "检测到旧版 ${productName} 位于非默认目录：$\\r$\\n$DesktopPreviousInstallDir$\\r$\\n$\\r$\\n新版程序目录固定为：$\\r$\\n$DesktopDefaultInstallDir$\\r$\\n$\\r$\\n为防止旧卸载器递归删除非默认目录，安装已停止。请先备份该目录并运行随安装包提供的 ${productName} Safe Repair。" /SD IDOK
      SetErrorLevel 3
      Quit
    \${endif}
  \${endif}
  StrCpy $INSTDIR "$DesktopDefaultInstallDir"
  Call ${nsisPrefix}EnsureDataRootDefault
  !insertmacro DesktopValidateStoredDataRootForInstall
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!macro customUnInit
  SetOutPath $TEMP
  Call un.${nsisPrefix}EnsureDataRootDefault
  ClearErrors
  \${GetParameters} $R2
  \${GetOptions} $R2 "--delete-app-data" $R3
  \${ifNot} \${Errors}
    MessageBox MB_ICONSTOP "为防止绕过目录所有权校验，${productName} 卸载器不接受 --delete-app-data。请直接运行卸载器并在安全提示中选择是否删除数据。" /SD IDOK
    SetErrorLevel 5
    Quit
  \${endif}
  !insertmacro DesktopResolveDefaultInstallDir
  GetFullPathName $DesktopPreviousInstallDir "$INSTDIR"
  !insertmacro DesktopReadOwnerMarker $DesktopPreviousInstallDir "${installOwnerToken}" $R0
  !insertmacro DesktopValidateInstallRoot $DesktopPreviousInstallDir $R1
  \${if} $R0 != "1"
  \${orIf} $R1 != "1"
    MessageBox MB_ICONSTOP "当前安装目录缺少 ${productName} 所有权标记或不是合法的专属目录。为保护目录中的其他文件，卸载已停止：$\\r$\\n$DesktopPreviousInstallDir$\\r$\\n$\\r$\\n请使用 ${productName} Safe Repair。" /SD IDOK
    SetErrorLevel 3
    Quit
  \${endif}
!macroend
!endif

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom ${nsisPrefix}DataDirectoryPage ${nsisPrefix}DataDirectoryPageLeave
!macroend
!endif

!ifndef BUILD_UNINSTALLER
!macro DesktopHandleOldUninstallAndRestoreInstallDir
  \${if} \${Errors}
    DetailPrint "Old ${productName} uninstaller was not available; continuing with the fixed program directory."
    ClearErrors
  \${elseIf} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "旧版 ${productName} 卸载失败，错误码：$R0" /SD IDOK
    SetErrorLevel 2
    Quit
  \${endif}
  !insertmacro DesktopResolveDefaultInstallDir
  StrCpy $INSTDIR "$DesktopDefaultInstallDir"
!macroend

!macro customUnInstallCheck
  !insertmacro DesktopHandleOldUninstallAndRestoreInstallDir
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro DesktopHandleOldUninstallAndRestoreInstallDir
!macroend
!endif

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.${nsisPrefix}EnsureDataRootDefault
  !else
    !insertmacro setInstallModePerUser
    !insertmacro DesktopResolveDefaultInstallDir
    ReadRegStr $DesktopPreviousInstallDir HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${if} $DesktopPreviousInstallDir != ""
      GetFullPathName $DesktopPreviousInstallDir "$DesktopPreviousInstallDir"
      \${if} $DesktopPreviousInstallDir != $DesktopDefaultInstallDir
        MessageBox MB_ICONSTOP "检测到旧版 ${productName} 位于非默认目录：$\\r$\\n$DesktopPreviousInstallDir$\\r$\\n$\\r$\\n新版程序目录固定为：$\\r$\\n$DesktopDefaultInstallDir$\\r$\\n$\\r$\\n为防止旧卸载器递归删除非默认目录，安装已停止。请先备份该目录并运行随安装包提供的 ${productName} Safe Repair。" /SD IDOK
        SetErrorLevel 3
        Abort
      \${endif}
    \${endif}
    StrCpy $INSTDIR "$DesktopDefaultInstallDir"
    Call ${nsisPrefix}EnsureDataRootDefault
    !insertmacro DesktopValidateStoredDataRootForInstall
    \${if} $INSTDIR != $DesktopDefaultInstallDir
      MessageBox MB_ICONSTOP "${productName} 程序目录必须固定为：$\\r$\\n$DesktopDefaultInstallDir$\\r$\\n安装已停止。" /SD IDOK
      SetErrorLevel 6
      Abort
    \${endif}
    \${if} \${FileExists} "$INSTDIR\\*.*"
      !insertmacro DesktopDirectoryHasEntries $INSTDIR $R2
      \${if} $R2 == "1"
        !insertmacro DesktopReadOwnerMarker $INSTDIR "${installOwnerToken}" $R0
        \${if} $R0 != "1"
          StrCpy $R1 "0"
          \${if} $DesktopPreviousInstallDir == $DesktopDefaultInstallDir
          \${andIf} $INSTDIR == $DesktopDefaultInstallDir
            StrCpy $R1 "1"
          \${endif}
          \${if} $R1 != "1"
            MessageBox MB_ICONSTOP "目标程序目录已存在但缺少 ${productName} 所有权标记，安装已停止：$\\r$\\n$INSTDIR" /SD IDOK
            SetErrorLevel 6
            Abort
          \${endif}
        \${endif}
      \${endif}
    \${endif}
  !endif
  System::Call 'kernel32::GetCurrentProcessId() i .R6'
  System::Call 'kernel32::GetTickCount() i .R7'
  StrCpy $DesktopShutdownAckPath "$TEMP\\${storageNamespace}-shutdown-$R6-$R7.status"
  Delete "$DesktopShutdownAckPath"
  StrCpy $DesktopShutdownStatus ""
  \${if} \${FileExists} "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Requesting ${productName} to exit and waiting for shutdown acknowledgement..."
    nsExec::ExecToLog \`"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${shutdownArg} "--desktop-shutdown-ack=$DesktopShutdownAckPath"\`
    Pop $R2
    StrCpy $R1 0
    waitShutdownAck:
      \${if} \${FileExists} "$DesktopShutdownAckPath"
        ClearErrors
        FileOpen $R8 "$DesktopShutdownAckPath" r
        \${ifNot} \${Errors}
          FileRead $R8 $R9
          FileClose $R8
          StrCpy $DesktopShutdownStatus $R9 2
        \${endif}
        Goto shutdownAckFinished
      \${endif}
      IntOp $R1 $R1 + 1
      \${if} $R1 < 24
        Sleep 500
        Goto waitShutdownAck
      \${endif}
    shutdownAckFinished:
  \${endif}
  !insertmacro stopManagedServiceProcesses
  Delete "$DesktopShutdownAckPath"
  \${if} $DesktopProcessCleanupStatus != "0"
    MessageBox MB_ICONSTOP "${productName} 仍有受管进程未退出，覆盖安装或卸载已中止。$\\r$\\n$DesktopProcessSurvivors" /SD IDOK
    SetErrorLevel 20
    Abort
  \${endif}
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInstall
  Call ${nsisPrefix}EnsureDataRootDefault
  !insertmacro DesktopResolveDefaultInstallDir
  \${if} $INSTDIR != $DesktopDefaultInstallDir
    MessageBox MB_ICONSTOP "程序安装目录不是 ${productName} 固定目录，安装已停止：$\\r$\\n$INSTDIR"
    Abort
  \${endif}
  StrCpy $R2 "0"
  \${if} $DesktopDataRootStored == "0"
  \${orIf} $DesktopDataRootLayoutVersion == "2"
  \${orIf} $DesktopDataRoot == "$PROFILE\\${runtimeRootDirName}"
    StrCpy $R2 "1"
  \${endif}
  \${if} $R2 == "1"
    !insertmacro DesktopValidateOwnedRoot $DesktopDataRoot $R1
    \${if} $R1 != "1"
      MessageBox MB_ICONSTOP "数据目录未通过最终安全校验，安装已停止：$\\r$\\n$DesktopDataRoot"
      Abort
    \${endif}
    \${if} $DesktopDataRootStored == "0"
    \${andIf} \${FileExists} "$DesktopDataRoot\\*.*"
      !insertmacro DesktopDirectoryHasEntries $DesktopDataRoot $R2
      \${if} $R2 == "1"
        !insertmacro DesktopReadOwnerMarker $DesktopDataRoot "${dataOwnerToken}" $R0
        \${if} $R0 != "1"
          \${if} $DesktopDataRootAdoptConfirmed != "1"
            MessageBox MB_ICONSTOP "目标数据目录已存在但缺少 ${productName} 所有权标记，安装已停止：$\\r$\\n$DesktopDataRoot"
            Abort
          \${endif}
        \${endif}
      \${endif}
    \${endif}
    !insertmacro DesktopWriteOwnerMarker $DesktopDataRoot "${dataOwnerToken}"
    WriteRegDWORD HKCU "${dataRegistryKey}" "DataRootLayoutVersion" 2
    DeleteRegValue HKCU "${dataRegistryKey}" "LayoutVersion"
  \${endif}
  WriteRegStr HKCU "${dataRegistryKey}" "DataRoot" "$DesktopDataRoot"
  StrCpy $DesktopProgramDataRoot "$APPDATA\\${programDataDirName}"
  StrCpy $DesktopProgramOwnerMarker "$APPDATA\\${programDataDirName}.desktop-owner"
  !insertmacro DesktopValidateOwnedRoot $DesktopProgramDataRoot $R1
  \${if} $R1 != "1"
    MessageBox MB_ICONSTOP "程序数据目录未通过安全校验，安装已停止：$\\r$\\n$DesktopProgramDataRoot"
    Abort
  \${endif}
  \${if} \${FileExists} "$DesktopProgramDataRoot\\*.*"
    !insertmacro DesktopReadOwnerFile $DesktopProgramOwnerMarker "${programOwnerToken}" $R0
    \${if} $R0 != "1"
      \${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
      StrCpy $R7 "$APPDATA\\${programDataDirName}.recovery-$0$1$2-$4$5$6"
      ClearErrors
      Rename "$DesktopProgramDataRoot" "$R7"
      \${if} \${Errors}
        MessageBox MB_ICONSTOP "检测到上次卸载残留的程序数据，但无法安全转存，安装已停止：$\\r$\\n$DesktopProgramDataRoot"
        Abort
      \${endif}
    \${endif}
  \${endif}
  CreateDirectory "$DesktopProgramDataRoot"
  !insertmacro DesktopWriteOwnerFile $DesktopProgramOwnerMarker "${programOwnerToken}"
  !insertmacro DesktopWriteOwnerMarker $INSTDIR "${installOwnerToken}"
!macroend
!endif

!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  Call un.${nsisPrefix}EnsureDataRootDefault
  StrCpy $DesktopProgramDataRoot "$APPDATA\\${programDataDirName}"
  StrCpy $DesktopProgramOwnerMarker "$APPDATA\\${programDataDirName}.desktop-owner"
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 ${productName} 应用数据？$\\r$\\n$\\r$\\n只会删除经过所有权校验的应用专属目录；历史自定义目录或安全标记异常时将保留数据。" /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  StrCpy $DesktopDataRemoved "0"
  StrCpy $DesktopCleanupWarning ""
  \${if} $DesktopDataRootLayoutVersion == "2"
    !insertmacro DesktopValidateDataRoot $DesktopDataRoot $DesktopOwnedDataRoot $R1
    StrCpy $R0 "0"
    \${if} $R1 == "1"
      !insertmacro DesktopReadOwnerMarker $DesktopOwnedDataRoot "${dataOwnerToken}" $R0
    \${endif}
    \${if} $R0 == "1"
    \${andIf} $R1 == "1"
      StrCpy $R4 "0"
removeDesktopOwnedDataRetry:
      RMDir /r "$DesktopOwnedDataRoot"
      !insertmacro DesktopForceRemoveOwnedRoot $DesktopOwnedDataRoot
      \${ifNot} \${FileExists} "$DesktopOwnedDataRoot\\*.*"
        StrCpy $DesktopDataRemoved "1"
      \${else}
        IntOp $R4 $R4 + 1
        \${if} $R4 < 2
          Sleep 250
          Goto removeDesktopOwnedDataRetry
        \${endif}
        !insertmacro DesktopRestoreOwnerMarker $DesktopOwnedDataRoot "${dataOwnerToken}"
        StrCpy $DesktopCleanupWarning "运行数据目录删除失败，所有权标记已恢复：$DesktopOwnedDataRoot"
      \${endif}
    \${else}
      StrCpy $DesktopCleanupWarning "运行数据目录未通过规范化路径、品牌目录名或所有权校验，已保留：$DesktopDataRoot"
    \${endif}
  \${else}
    StrCpy $DesktopCleanupWarning "历史自定义运行数据目录缺少所有权信息，已保留：$DesktopDataRoot"
  \${endif}

  !insertmacro DesktopReadOwnerFile $DesktopProgramOwnerMarker "${programOwnerToken}" $R0
  !insertmacro DesktopValidateOwnedRoot $DesktopProgramDataRoot $R1
  \${if} $R0 == "1"
  \${andIf} $R1 == "1"
    StrCpy $R5 "0"
removeDesktopProgramDataRetry:
    RMDir /r "$DesktopProgramDataRoot"
    !insertmacro DesktopForceRemoveOwnedRoot $DesktopProgramDataRoot
    \${if} \${FileExists} "$DesktopProgramDataRoot\\*.*"
      IntOp $R5 $R5 + 1
      \${if} $R5 < 2
        Sleep 250
        Goto removeDesktopProgramDataRetry
      \${endif}
      !insertmacro DesktopWriteOwnerFile $DesktopProgramOwnerMarker "${programOwnerToken}"
      \${if} $DesktopCleanupWarning != ""
        StrCpy $DesktopCleanupWarning "$DesktopCleanupWarning$\\r$\\n"
      \${endif}
      StrCpy $DesktopCleanupWarning "$DesktopCleanupWarning程序数据目录删除失败，所有权标记已恢复：$DesktopProgramDataRoot"
    \${else}
      Delete "$DesktopProgramOwnerMarker"
    \${endif}
  \${else}
    \${if} $DesktopCleanupWarning != ""
      StrCpy $DesktopCleanupWarning "$DesktopCleanupWarning$\\r$\\n"
    \${endif}
    StrCpy $DesktopCleanupWarning "$DesktopCleanupWarning程序数据目录未通过所有权校验，已保留：$DesktopProgramDataRoot"
  \${endif}

  \${if} $DesktopDataRemoved == "1"
    DeleteRegValue HKCU "${dataRegistryKey}" "DataRoot"
    DeleteRegValue HKCU "${dataRegistryKey}" "DataRootLayoutVersion"
    DeleteRegKey /ifempty HKCU "${dataRegistryKey}"
  \${endif}
  \${if} $DesktopCleanupWarning != ""
    MessageBox MB_ICONEXCLAMATION "$DesktopCleanupWarning"
  \${endif}

doneDataCleanup:
!macroend
`;
  writeFileIfChanged(path.join(brandInstallerDir(rootDir, brand), "installer.nsh"), content);
}

const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";

function uuidBytes(value) {
  return Buffer.from(String(value).replace(/-/gu, ""), "hex");
}

function formatUuid(buffer) {
  const hex = buffer.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function electronBuilderWindowsGuid(appId) {
  const digest = createHash("sha1")
    .update(uuidBytes(ELECTRON_BUILDER_NS_UUID))
    .update(Buffer.from(String(appId), "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

export function safeRepairScriptPath(rootDir = process.cwd(), brandOrId = resolveBrandId()) {
  return path.join(brandInstallerDir(rootDir, brandOrId), "safe-repair.nsi");
}

export function writeSafeRepairScript(rootDir, brand) {
  const productName = escapeNsisText(brand.productName);
  const programDataDirName = escapeNsisText(brand.paths.programDataDirName);
  const guid = electronBuilderWindowsGuid(brand.appId);
  const installRegistryKey = `Software\\${guid}`;
  const uninstallRegistryKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
  const content = `Unicode true
RequestExecutionLevel user
Name "${productName} Safe Repair"
Caption "${productName} 旧版安装安全修复"
!ifndef SAFE_REPAIR_OUT_FILE
  !define SAFE_REPAIR_OUT_FILE "${productName} Safe Repair.exe"
!endif
OutFile "\${SAFE_REPAIR_OUT_FILE}"
ShowInstDetails show
!include FileFunc.nsh
!include LogicLib.nsh

Var LegacyInstallLocation
Var BackupRoot
Var BackupStamp

Function .onInit
  \${If} \${Silent}
    MessageBox MB_ICONSTOP "Safe Repair 必须由用户交互运行，不能静默执行。" /SD IDOK
    SetErrorLevel 2
    Quit
  \${EndIf}
  ReadRegStr $LegacyInstallLocation HKCU "${installRegistryKey}" "InstallLocation"
  \${If} $LegacyInstallLocation == ""
    MessageBox MB_ICONINFORMATION "未检测到需要隔离的 ${productName} 旧安装记录。"
    Quit
  \${EndIf}
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "检测到旧安装目录：$\\r$\\n$LegacyInstallLocation$\\r$\\n$\\r$\\n本工具不会删除或移动该目录中的任何文件，只会备份并隔离旧卸载注册信息。请先确认已经备份该目录。是否继续？" IDYES +2
  Quit
FunctionEnd

Section "安全隔离旧安装记录"
  StrCpy $BackupRoot "$LOCALAPPDATA\\${programDataDirName}\\repair-backups"
  CreateDirectory "$BackupRoot"
  \${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $BackupStamp "$0$1$2-$4$5$6"
  ClearErrors
  ExecWait '"$SYSDIR\\reg.exe" export "HKCU\\${installRegistryKey}" "$BackupRoot\\$BackupStamp-install.reg" /y' $R0
  \${If} $R0 != 0
    MessageBox MB_ICONSTOP "无法备份旧安装注册信息，未执行任何隔离操作。"
    SetErrorLevel 3
    Abort
  \${EndIf}
  ReadRegStr $R2 HKCU "${uninstallRegistryKey}" "UninstallString"
  \${If} $R2 != ""
    ClearErrors
    ExecWait '"$SYSDIR\\reg.exe" export "HKCU\\${uninstallRegistryKey}" "$BackupRoot\\$BackupStamp-uninstall.reg" /y' $R0
    \${If} $R0 != 0
      MessageBox MB_ICONSTOP "无法备份旧卸载注册信息，未执行任何隔离操作。"
      SetErrorLevel 3
      Abort
    \${EndIf}
  \${EndIf}
  ClearErrors
  FileOpen $R1 "$BackupRoot\\$BackupStamp-info.txt" w
  \${If} \${Errors}
    MessageBox MB_ICONSTOP "无法写入修复备份说明，未执行任何隔离操作。"
    SetErrorLevel 3
    Abort
  \${EndIf}
  FileWrite $R1 "Product=${productName}$\\r$\\n"
  FileWrite $R1 "InstallLocation=$LegacyInstallLocation$\\r$\\n"
  FileClose $R1
  \${If} $R2 != ""
    ClearErrors
    DeleteRegKey HKCU "${uninstallRegistryKey}"
    \${If} \${Errors}
      MessageBox MB_ICONSTOP "旧卸载注册信息已备份，但隔离失败；旧安装发现记录保持不变。"
      SetErrorLevel 4
      Abort
    \${EndIf}
  \${EndIf}
  ClearErrors
  DeleteRegKey HKCU "${installRegistryKey}"
  \${If} \${Errors}
    MessageBox MB_ICONSTOP "注册信息已备份，但无法移除旧安装发现记录。请保留备份并重试。"
    SetErrorLevel 4
    Abort
  \${EndIf}
  MessageBox MB_ICONINFORMATION "旧卸载记录已安全隔离。原目录没有被修改：$\\r$\\n$LegacyInstallLocation$\\r$\\n$\\r$\\n注册信息备份：$BackupRoot$\\r$\\n现在可以重新运行新版 ${productName} 安装器。"
SectionEnd
`;
  writeFileIfChanged(safeRepairScriptPath(rootDir, brand), content);
}

function shellDoubleQuoted(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

export function writeMacUninstallScript(rootDir, brand) {
  const appName = shellDoubleQuoted(brand.productName);
  const storageNamespace = shellDoubleQuoted(brand.storageNamespace);
  const shutdownArg = shellDoubleQuoted(brand.installer.shutdownArg);
  const runtimeRootDirName = shellDoubleQuoted(brand.paths.runtimeRootDirName);
  const desktopDataSubdir = shellDoubleQuoted(brand.paths.desktopDataSubdir);
  const programDataDirName = shellDoubleQuoted(brand.paths.programDataDirName);
  const content = `#!/bin/bash

set -euo pipefail

APP_NAME="${appName}"
APP_PATH="/Applications/\${APP_NAME}.app"
DATA_PATH="\${HOME}/${runtimeRootDirName}/${desktopDataSubdir}"
PROGRAM_DATA_PATH="\${HOME}/Library/Application Support/${programDataDirName}"
STORAGE_NAMESPACE="${storageNamespace}"
SHUTDOWN_ARG="${shutdownArg}"
ACK_PATH="\${TMPDIR:-/tmp}/\${STORAGE_NAMESPACE}-shutdown-\$\$-\$(date +%s).status"
SNAPSHOT_PATH="\${TMPDIR:-/tmp}/\${STORAGE_NAMESPACE}-processes-\$\$-\$(date +%s).snapshot"

cleanup_temp_files() {
  rm -f "$ACK_PATH" "$SNAPSHOT_PATH"
}

trap cleanup_temp_files EXIT

show_dialog() {
  local message="$1"

  osascript -e "display dialog \\"$message\\" buttons {\\"OK\\"} default button \\"OK\\" with icon caution" >/dev/null
}

request_desktop_shutdown() {
  local executable="$APP_PATH/Contents/MacOS/$APP_NAME"
  local attempt=0

  rm -f "$ACK_PATH"
  if [ ! -x "$executable" ]; then
    return 0
  fi

  "$executable" "$SHUTDOWN_ARG" "--desktop-shutdown-ack=$ACK_PATH" >/dev/null 2>&1 &
  while [ "$attempt" -lt 24 ]; do
    if [ -f "$ACK_PATH" ]; then
      head -n 1 "$ACK_PATH" 2>/dev/null || true
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  printf '%s\\n' "NO_ACK"
}

append_unique_pid() {
  local candidate="$1"
  case " $MANAGED_PIDS " in
    *" $candidate "*) ;;
    *) MANAGED_PIDS="$MANAGED_PIDS $candidate" ;;
  esac
}

capture_managed_processes() {
  if ! ps -axo pid=,ppid=,command= >"$SNAPSHOT_PATH"; then
    return 1
  fi

  ROOT_PIDS=""
  MANAGED_PIDS=""
  while read -r pid ppid command; do
    [ -n "\${pid:-}" ] || continue
    [ "$pid" = "\$\$" ] && continue
    local matched=0
    case "$command" in *"$APP_PATH"*) matched=1 ;; esac
    if [ "$matched" = "0" ]; then
      case "$command" in *"$PROGRAM_DATA_PATH"*) matched=1 ;; esac
    fi
    if [ "$matched" = "0" ]; then
      case "$command" in *"$DATA_PATH"*) matched=1 ;; esac
    fi
    if [ "$matched" = "1" ]; then
      ROOT_PIDS="$ROOT_PIDS $pid"
      append_unique_pid "$pid"
    fi
  done <"$SNAPSHOT_PATH"

  local pending="$ROOT_PIDS"
  while [ -n "\${pending// /}" ]; do
    local next=""
    for parent in $pending; do
      while read -r child; do
        [ -n "$child" ] || continue
        append_unique_pid "$child"
        next="$next $child"
      done < <(awk -v parent="$parent" '$2 == parent { print $1 }' "$SNAPSHOT_PATH")
    done
    pending="$next"
  done
}

signal_managed_processes() {
  local signal="$1"
  local current_pgid
  current_pgid="$(ps -o pgid= -p \$\$ | tr -d ' ')"

  for root in $ROOT_PIDS; do
    local pgid
    pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "$pgid" ] && [ "$pgid" != "$current_pgid" ]; then
      kill "-$signal" "-$pgid" 2>/dev/null || true
    fi
  done

  for pid in $MANAGED_PIDS; do
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

wait_for_managed_processes() {
  local timeout_steps="$1"
  local step=0
  while [ "$step" -lt "$timeout_steps" ]; do
    SURVIVOR_PIDS=""
    for pid in $MANAGED_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        SURVIVOR_PIDS="$SURVIVOR_PIDS $pid"
      fi
    done
    if [ -z "\${SURVIVOR_PIDS// /}" ]; then
      return 0
    fi
    step=$((step + 1))
    sleep 0.1
  done
  return 1
}

stop_managed_processes() {
  if ! capture_managed_processes; then
    SURVIVOR_PIDS="process snapshot failed"
    return 2
  fi
  if [ -z "\${MANAGED_PIDS// /}" ]; then
    SURVIVOR_PIDS=""
    return 0
  fi

  signal_managed_processes TERM
  if wait_for_managed_processes 20; then
    return 0
  fi
  signal_managed_processes KILL
  wait_for_managed_processes 10
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

ACK_STATUS="$(request_desktop_shutdown)"
printf '%s\\n' "Desktop shutdown acknowledgement: $ACK_STATUS"

if ! stop_managed_processes; then
  show_dialog "$APP_NAME still has managed processes running. Uninstall was stopped. Remaining PIDs: $SURVIVOR_PIDS"
  printf '%s\\n' "$APP_NAME uninstall stopped; remaining managed PIDs:$SURVIVOR_PIDS"
  exit 20
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
  const scriptPath = path.join(brandInstallerDir(rootDir, brand), "uninstall.sh");
  writeFileIfChanged(scriptPath, content);
  fs.chmodSync(scriptPath, 0o755);
}
