!macro customInit
  ; Kill running Atleta Bridge process before installing
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Bridge.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "atleta-bridge.exe"'
  ; Wait a moment for the process to fully exit
  Sleep 1000
!macroend
