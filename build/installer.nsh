!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ZenMind app data?$\r$\n$\r$\nThis removes %USERPROFILE%\.zenmind\.desktop, including settings, service config, plugins, credentials, logs, caches, and browser profiles. Legacy data under %APPDATA%\zenmind-desktop will also be removed if present." /SD IDNO IDYES removeDesktopData IDNO keepDesktopData

removeDesktopData:
  RMDir /r "$PROFILE\.zenmind\.desktop"
  RMDir /r "$APPDATA\zenmind-desktop"
  Goto doneDataCleanup

keepDesktopData:
  IfFileExists "$APPDATA\zenmind-desktop\user-paths.json" removeLegacyPointer doneDataCleanup

removeLegacyPointer:
  Delete "$APPDATA\zenmind-desktop\user-paths.json"
  RMDir "$APPDATA\zenmind-desktop"

doneDataCleanup:
!macroend
