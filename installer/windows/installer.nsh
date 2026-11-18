!define MUI_BGCOLOR "FBFBFA"
!define MUI_TEXTCOLOR "111111"

!macro PullColorCaption
  ; DWM caption and text colors use COLORREF (00BBGGRR). Older systems
  ; ignore these attributes and keep their native caption colors.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x00100F0F, i 4) i'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00ECEDED, i 4) i'
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Установка PULL"
  !define MUI_WELCOMEPAGE_TEXT "Выберите, для кого установить приложение, и укажите папку установки."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Удаление PULL"
  !define MUI_WELCOMEPAGE_TEXT "Мастер удалит PULL с этого компьютера."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.PullSetCaption
  !macro customHeader
    UninstallCaption "PULL — удаление"
    Function un.PullSetCaption
      !insertmacro PullColorCaption
    FunctionEnd
  !macroend
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT PullSetCaption
  !macro customHeader
    Caption "PULL — установка"
    Function PullSetCaption
      !insertmacro PullColorCaption
    FunctionEnd
  !macroend
!endif
