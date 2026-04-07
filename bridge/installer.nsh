!macro customInit
  ; Kill running Atleta Bridge process before installing
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Bridge.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "atleta-bridge.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Bridge.exe" /T'
  ; Wait for processes to fully exit
  Sleep 2000
!macroend
