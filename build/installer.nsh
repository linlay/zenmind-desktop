!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ZenMind app data?$\r$\n$\r$\nThis removes %USERPROFILE%\.zenmind\.desktop and %APPDATA%\ZenMind, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles." /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  RMDir /r "$PROFILE\.zenmind\.desktop"
  RMDir /r "$APPDATA\ZenMind"

doneDataCleanup:
!macroend
