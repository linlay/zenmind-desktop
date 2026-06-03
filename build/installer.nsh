!macro stopManagedServiceProcesses
  DetailPrint "Stopping XiaoJun managed service processes..."
  nsExec::ExecToLog `%SYSTEMROOT%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; function Stop-DesktopManagedProcesses { $$programRoot = [Environment]::ExpandEnvironmentVariables('%APPDATA%\ZenMind'); if (Test-Path -LiteralPath $$programRoot) { $$normalizedRoot = [System.IO.Path]::GetFullPath($$programRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar); Get-CimInstance Win32_Process | Where-Object { $$path = [string]$$_.ExecutablePath; $$line = [string]$$_.CommandLine; ($$path -and $$path.StartsWith($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($$line -and $$line.IndexOf($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }; $$stateRoot = [Environment]::ExpandEnvironmentVariables('%USERPROFILE%\.zenmind\.desktop\state'); if (Test-Path -LiteralPath $$stateRoot) { Get-ChildItem -LiteralPath $$stateRoot -Filter '*.pid' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $$_.FullName -Force -ErrorAction SilentlyContinue } } }; Stop-DesktopManagedProcesses"`
  Pop $R2
!macroend

!macro customCheckAppRunning
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    DetailPrint "Requesting XiaoJun to exit before installing..."
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      nsExec::ExecToLog `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --desktop-shutdown-for-update`
      Pop $R2
      Sleep 500
    ${endif}

    StrCpy $R1 0
    waitAppExit:
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 != 0
        Goto appExited
      ${endif}
      IntOp $R1 $R1 + 1
      ${if} $R1 < 12
        Sleep 500
        Goto waitAppExit
      ${endif}

      DetailPrint "Force closing XiaoJun before installing..."
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::ExecToLog `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
        Pop $R2
      !else
        nsExec::ExecToLog `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
        Pop $R2
      !endif

    appExited:
  ${endif}

  !insertmacro stopManagedServiceProcesses
!macroend

!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete XiaoJun app data?$\r$\n$\r$\nThis removes %APPDATA%\ZenMind, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles." /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  RMDir /r "$APPDATA\ZenMind"

doneDataCleanup:
!macroend
