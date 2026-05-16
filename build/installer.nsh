!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ZenMind app data?$\r$\n$\r$\nThis removes %USERPROFILE%\.zenmind\.desktop, including settings, service config, plugins, credentials, logs, caches, and browser profiles." /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  RMDir /r "$PROFILE\.zenmind\.desktop"

doneDataCleanup:
!macroend
