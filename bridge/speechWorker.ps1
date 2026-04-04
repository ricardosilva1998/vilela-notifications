# Speech recognition worker for Atleta Bridge
# Communicates via stdin (START/STOP/EXIT) and stdout (READY/LISTENING/RESULT:text)
$ErrorActionPreference = "Continue"

try {
    Add-Type -AssemblyName System.Speech
} catch {
    [Console]::Out.WriteLine("ERROR:System.Speech not available - " + $_.Exception.Message)
    [Console]::Out.Flush()
    exit 1
}

$recognizer = $null
try {
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $recognizer.SetInputToDefaultAudioDevice()
    $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
} catch {
    [Console]::Out.WriteLine("ERROR:Failed to init speech engine - " + $_.Exception.Message)
    [Console]::Out.Flush()
    exit 1
}

$script:parts = [System.Collections.ArrayList]@()
$script:isListening = $false

$recognizer.Add_SpeechRecognized({
    param($sender, $e)
    if ($e.Result -and $e.Result.Text) {
        [void]$script:parts.Add($e.Result.Text)
    }
})

$recognizer.Add_RecognizeCompleted({
    param($sender, $e)
    # Recognition stopped — this fires after RecognizeAsyncCancel
    $script:isListening = $false
})

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
    try {
        $cmd = [Console]::In.ReadLine()
    } catch {
        break
    }
    if ($cmd -eq $null -or $cmd -eq "EXIT") { break }

    if ($cmd -eq "START") {
        $script:parts.Clear()
        try {
            if ($script:isListening) {
                try { $recognizer.RecognizeAsyncCancel() } catch {}
                Start-Sleep -Milliseconds 50
            }
            $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
            $script:isListening = $true
            [Console]::Out.WriteLine("LISTENING")
            [Console]::Out.Flush()
        } catch {
            [Console]::Out.WriteLine("ERROR:Start failed - " + $_.Exception.Message)
            [Console]::Out.Flush()
        }
    }
    elseif ($cmd -eq "STOP") {
        try {
            if ($script:isListening) {
                $recognizer.RecognizeAsyncCancel()
                $script:isListening = $false
            }
        } catch {}
        Start-Sleep -Milliseconds 200
        $text = ($script:parts -join " ").Trim()
        [Console]::Out.WriteLine("RESULT:" + $text)
        [Console]::Out.Flush()
    }
}

try {
    if ($script:isListening) { $recognizer.RecognizeAsyncCancel() }
    $recognizer.Dispose()
} catch {}
