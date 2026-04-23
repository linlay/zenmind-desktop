!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  IfFileExists "$APPDATA\zenmind-desktop\user-paths.json" removeLegacyData doneLegacyDataCleanup

removeLegacyData:
  RMDir /r "$APPDATA\zenmind-desktop"

doneLegacyDataCleanup:
!macroend
