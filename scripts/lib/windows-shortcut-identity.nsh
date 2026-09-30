!include Win\COM.nsh

; Explorer shows the shortcut comment on hover. Keep it equal to the app name.
!define /redef APP_DESCRIPTION "${PRODUCT_NAME}"

!ifndef BUILD_UNINSTALLER
; The custom include is loaded before electron-builder declares $appExe.
!macro customHeader
Function DesktopRefreshShortcutDescription
  System::Store S
  Pop $9
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r1 ".r0"
  ${if} $0 = 0
    ${IUnknown::QueryInterface} $1 '("${IID_IPersistFile}",.r2).r0'
    ${if} $0 = 0
      ${IPersistFile::Load} $2 '("$9",0).r0'
      ${if} $0 = 0
        ${IShellLink::GetPath} $1 '(.r3,${NSIS_MAX_STRLEN},0,0).r0'
        ; Only refresh the installer's own link to this executable.
        ${if} $0 = 0
        ${andIf} $3 == $appExe
          ${IShellLink::GetDescription} $1 '(.r4,${NSIS_MAX_STRLEN}).r0'
          ${if} $0 = 0
          ${andIf} $4 != "${APP_DESCRIPTION}"
            ; Update the loaded link so arguments, icon, hotkey and AUMI survive.
            ${IShellLink::SetDescription} $1 '("${APP_DESCRIPTION}").r0'
            ${if} $0 = 0
              ${IPersistFile::Save} $2 '("$9",1).r0'
            ${endif}
          ${endif}
        ${endif}
      ${endif}
      ${IUnknown::Release} $2 ""
    ${endif}
    ${IUnknown::Release} $1 ""
  ${endif}
  ${if} $0 < 0
    DetailPrint "Could not refresh shortcut description: $9 (HRESULT $0)"
  ${endif}
  System::Store L
FunctionEnd
!macroend

!macro DesktopRefreshShortcutDescriptions
  ; electron-builder keeps existing links on upgrade. Do not recreate deleted links.
  ${if} ${FileExists} "$newStartMenuLink"
    Push "$newStartMenuLink"
    Call DesktopRefreshShortcutDescription
  ${endif}
  ${if} ${FileExists} "$newDesktopLink"
    Push "$newDesktopLink"
    Call DesktopRefreshShortcutDescription
  ${endif}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
!endif
