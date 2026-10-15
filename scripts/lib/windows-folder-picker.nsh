; Modern Windows folder picker. Input: initial folder, then title. Output: path/cancel/error.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL DesktopFolderPickerInitial
Var /GLOBAL DesktopFolderPickerTitle
Var /GLOBAL DesktopFolderPickerResult

Function DesktopSelectDataFolder
  Pop $DesktopFolderPickerTitle
  Pop $DesktopFolderPickerInitial
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $DesktopFolderPickerResult "error"
  StrCpy $0 0
  StrCpy $2 0
  StrCpy $3 0
  System::Call 'ole32::CoInitializeEx(p 0, i 2) i.r6'
  ; S_OK and S_FALSE both require a matching CoUninitialize.
  ${If} $6 >= 0
    System::Call 'ole32::CoCreateInstance(g "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}", p 0, i 1, g "{42F85136-DB7E-439C-85F1-E4075D135FC8}", *p .r0) i.r1'
    ${If} $1 == 0
      ; FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST.
      System::Call '$0->10(*i .r4) i.r1'
      ${If} $1 == 0
        IntOp $4 $4 | 0x00000860
        System::Call '$0->9(i r4) i.r1'
      ${EndIf}
      ${If} $1 == 0
        System::Call '$0->17(w "$DesktopFolderPickerTitle") i.r1'
      ${EndIf}
      ${If} $1 == 0
        ; An absent initial directory must not prevent choosing another one.
        System::Call 'shell32::SHCreateItemFromParsingName(w "$DesktopFolderPickerInitial", p 0, g "{43826D1E-E718-42EE-BC55-A1E261C37BFE}", *p .r2) i.r5'
        ${If} $5 == 0
          System::Call '$0->12(p r2) i.r5'
          System::Call '$2->2()'
          StrCpy $2 0
        ${EndIf}
        ; Owner keeps the picker modal and on the installer's monitor.
        System::Call '$0->3(p $HWNDPARENT) i.r1'
        ${If} $1 == -2147023673
          StrCpy $DesktopFolderPickerResult "cancel"
        ${ElseIf} $1 == 0
          System::Call '$0->20(*p .r2) i.r1'
          ${If} $1 == 0
            System::Call '$2->5(i 0x80058000, *p .r3) i.r1'
            ${If} $1 == 0
              System::Call '*$3(&w${NSIS_MAX_STRLEN} .r5)'
              StrCpy $DesktopFolderPickerResult $5
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $3 != 0
      System::Call 'ole32::CoTaskMemFree(p r3)'
    ${EndIf}
    ${If} $2 != 0
      System::Call '$2->2()'
    ${EndIf}
    ${If} $0 != 0
      System::Call '$0->2()'
    ${EndIf}
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Push $DesktopFolderPickerResult
FunctionEnd
!endif
