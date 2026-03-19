; ${__FILEDIR__} resolves at parse time to this file's directory (src-tauri/nsis/).
; Define the src-tauri dir here at the top level, NOT inside a macro.
!define SRCTAURI_DIR "${__FILEDIR__}\.."

!macro NSIS_HOOK_POSTINSTALL
  ; Install Visual Elements Manifest for large Start Menu tile icons
  SetOutPath $INSTDIR
  File "${SRCTAURI_DIR}\jade-rust.VisualElementsManifest.xml"
  File "${SRCTAURI_DIR}\icons\Square150x150Logo.png"
  File "${SRCTAURI_DIR}\icons\Square71x71Logo.png"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\jade-rust.VisualElementsManifest.xml"
  Delete "$INSTDIR\Square150x150Logo.png"
  Delete "$INSTDIR\Square71x71Logo.png"
!macroend
