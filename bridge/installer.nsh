!macro customInit
  ; Kill running Atleta Racing process before installing
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Racing.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Racing.exe" /T'
  ; Also kill legacy Atleta Bridge process for users upgrading from < v3.26
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Bridge.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "atleta-bridge.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "Atleta Bridge.exe" /T'
  ; Wait for processes to fully exit
  Sleep 2000
!macroend
