; Included by the brand installer. Normal installs and uninstallers keep their existing UI.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL DesktopUpdateLog
Var /GLOBAL DesktopUpdateMode

!macro DesktopUpdateStage STAGE
  ${if} ${isUpdated}
    Push $0
    Push $1
    System::Call 'kernel32::GetTickCount() i.r1'
    ClearErrors
    FileOpen $0 "$DesktopUpdateLog" a
    ${ifNot} ${Errors}
      FileSeek $0 0 END
      FileWrite $0 "$1 ${STAGE}$\r$\n"
      FileClose $0
    ${endif}
    ClearErrors
    Pop $1
    Pop $0
    DetailPrint "${STAGE}"
  ${endif}
!macroend

!macro DesktopUpdateProgressInit
  ; This macro expands from .onInit, after all electron-builder plugin directories
  ; are registered. Include-time page functions must use the cached flag instead.
  StrCpy $DesktopUpdateMode "0"
  ${if} ${isUpdated}
    StrCpy $DesktopUpdateMode "1"
    SetSilent normal
    ; Keep diagnostics outside both directories removed by the old uninstaller.
    Push $0
    Push $1
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    System::Call 'kernel32::GetTickCount() i.r1'
    StrCpy $DesktopUpdateLog "$TEMP\${DESKTOP_UPDATE_LOG_NAMESPACE}-update-$0-$1.log"
    Pop $1
    Pop $0
    !insertmacro DesktopUpdateStage "installer-start version=${VERSION}"
  ${endif}
!macroend

; Defer functions until electron-builder has loaded MUI and its common helpers.
!macro customFinishPage
Function .onInstFailed
  !insertmacro DesktopUpdateStage "install-failed"
FunctionEnd

!define MUI_CUSTOMFUNCTION_ABORT DesktopUpdateAborted
Function DesktopUpdateAborted
  !insertmacro DesktopUpdateStage "user-aborted"
FunctionEnd

Function .onGUIEnd
  !insertmacro DesktopUpdateStage "installer-exit"
FunctionEnd

Function DesktopUpdateProgressShow
  ${if} ${isUpdated}
    !insertmacro MUI_HEADER_TEXT "正在安装更新" "正在替换程序文件，请勿关机。完成后将自动启动；首次启动可能需要几分钟。"
    SetDetailsView show
    SetDetailsPrint both
    !insertmacro DesktopUpdateStage "progress-visible"
    DetailPrint "安装阶段日志：$DesktopUpdateLog"
  ${endif}
FunctionEnd

Function DesktopUpdateFinishPre
  ${if} ${isUpdated}
    !insertmacro DesktopUpdateStage "install-complete"
    !insertmacro DesktopUpdateStage "launch-requested"
    Call DesktopLaunchAfterInstall
    ; Skip the Finish wizard only after successful installation. Failure never launches.
    Abort
  ${endif}
FunctionEnd

  Function DesktopLaunchAfterInstall
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION DesktopLaunchAfterInstall
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE DesktopUpdateFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif
