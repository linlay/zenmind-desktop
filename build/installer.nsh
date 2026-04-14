!macro customUnInstall
  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ZenMind Desktop app data from $APPDATA\zenmind-desktop?$\r$\n$\r$\nThis removes settings, services, plugins, and credentials." IDNO skipDataCleanup
  RMDir /r "$APPDATA\zenmind-desktop"

skipDataCleanup:
!macroend
