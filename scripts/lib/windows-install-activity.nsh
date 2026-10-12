; Stage-weighted total progress uses its own control: NSIS instruction positions
; and backwards retry jumps must never overwrite the visible total.
Var /GLOBAL DesktopProgressBar
Var /GLOBAL DesktopTotalProgressBar
Var /GLOBAL DesktopProgressPosition

!macro DesktopProgressAdvance POSITION
  ${ifNot} ${Silent}
    ${if} ${POSITION} > $DesktopProgressPosition
      StrCpy $DesktopProgressPosition ${POSITION}
      SendMessage $DesktopTotalProgressBar 0x402 $DesktopProgressPosition 0
    ${endif}
  ${endif}
!macroend

!macro DesktopProgressStart
  ${ifNot} ${Silent}
    System::Store S
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $DesktopProgressBar $0 1004
    ShowWindow $DesktopProgressBar 0
    ${if} $DesktopTotalProgressBar == ""
      System::Alloc 16
      Pop $1
      System::Call 'user32::GetWindowRect(p $DesktopProgressBar, p r1)'
      System::Call 'user32::MapWindowPoints(p 0, p r0, p r1, i 2)'
      System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
      System::Free $1
      IntOp $4 $4 - $2
      IntOp $5 $5 - $3
      System::Call 'user32::CreateWindowEx(i 0, t "msctls_progress32", t "", i 0x50000000, i r2, i r3, i r4, i r5, p r0, p 1050, p 0, p 0) p .s'
      Pop $DesktopTotalProgressBar
      StrCpy $DesktopProgressPosition 0
      SendMessage $DesktopTotalProgressBar 0x406 0 100
    ${endif}
    System::Store L
  ${endif}
!macroend

!macro DesktopProgressStop POSITION
  ; Failure (0) preserves the last completed stage, rather than jumping backwards.
  !insertmacro DesktopProgressAdvance ${POSITION}
!macroend

!macro DesktopProgressMeasuredStart
  !insertmacro DesktopProgressStart
  ${ifNot} ${Silent}
    !insertmacro DesktopProgressAdvance 15
    SendMessage $DesktopProgressBar 0x402 0 0
    ; The native extraction bar stays hidden; the total is always visible.
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
Var /GLOBAL DesktopExtractCompleted
Var /GLOBAL DesktopExtractTotal

; Nsis7z calls synchronously with completed and total unpacked bytes. Large
; archives can use negative KiB values for both; their ratio remains valid.
!macro DesktopExtractProgressFunction
Function DesktopExtractProgress
  Pop $DesktopExtractCompleted
  Pop $DesktopExtractTotal
  System::Store S
  ${if} $DesktopExtractTotal != 0
  ${andIf} $DesktopExtractTotal != -1
    System::Int64Op $DesktopExtractCompleted * 100
    Pop $0
    System::Int64Op $0 / $DesktopExtractTotal
    Pop $0
    ${if} $0 >= 0
    ${andIf} $0 <= 100
      IntOp $1 $0 * 70
      IntOp $1 $1 / 100
      IntOp $1 $1 + 15
      !insertmacro DesktopProgressAdvance $1
    ${endif}
  ${endif}
  System::Store L
FunctionEnd
!macroend

!macro DesktopExtract7zMeasured FILE
  ${if} ${Silent}
    Nsis7z::Extract "${FILE}"
  ${else}
    !insertmacro DesktopProgressMeasuredStart
    !insertmacro DesktopProgressStage "正在解压程序文件…"
    Push $0
    GetFunctionAddress $0 DesktopExtractProgress
    Nsis7z::ExtractWithCallback "${FILE}" $0
    Pop $0
    ${ifNot} ${Errors}
      !insertmacro DesktopProgressAdvance 85
      !insertmacro DesktopProgressStage "正在复制程序文件…"
    ${endif}
  ${endif}
!macroend
!endif

!macro DesktopProgressEnd
  IfAbort desktopProgressFailed desktopProgressSucceeded
desktopProgressSucceeded:
  !insertmacro DesktopProgressStop 100
  Goto desktopProgressEnded
desktopProgressFailed:
  !insertmacro DesktopProgressStop 0
desktopProgressEnded:
!macroend

!macro DesktopProgressStage TEXT
  ; Update both labels so a measured percentage cannot outlive its stage.
  ; The header still persists when NSIS prints subsequent file details.
  ${ifNot} ${Silent}
  Push $0
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 0x000C 0 "STR:${TEXT}" ; WM_SETTEXT
  ; Use the NSIS status API as well, so its next UI refresh keeps this stage.
  SetDetailsPrint textonly
  DetailPrint "${TEXT}"
  SetDetailsPrint lastused
  Pop $0
  ${endif}
!macroend

!ifdef BUILD_UNINSTALLER
!macro DesktopUninstallProgressStart
  !insertmacro DesktopProgressStart
  !insertmacro DesktopProgressStage "正在停止应用和本地服务…"
!macroend

!macro DesktopUninstallProgressEnd
  !insertmacro DesktopProgressEnd
!macroend
!endif
