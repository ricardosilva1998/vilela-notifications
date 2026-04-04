# Speech recognition session for Atleta Bridge
# Spawned per PTT session. Uses synchronous Recognize() for reliability.
$ErrorActionPreference = "Continue"

try {
    Add-Type -AssemblyName System.Speech
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine

    [Console]::Error.WriteLine("ENGINE: " + $recognizer.RecognizerInfo.Description)
    [Console]::Error.WriteLine("CULTURE: " + $recognizer.RecognizerInfo.Culture.Name)

    try {
        $recognizer.SetInputToDefaultAudioDevice()
        [Console]::Error.WriteLine("AUDIO: Default device OK")
    } catch {
        [Console]::Error.WriteLine("AUDIO_ERROR: " + $_.Exception.Message)
        [Console]::Out.WriteLine("")
        [Console]::Out.Flush()
        exit 1
    }

    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($grammar)

    [Console]::Out.WriteLine("LISTENING")
    [Console]::Out.Flush()
    [Console]::Error.WriteLine("STARTING_RECOGNIZE")

    # Synchronous recognize — blocks until speech+pause detected or timeout
    # Using 30 second timeout; process will be killed on PTT release
    $result = $null
    try {
        $result = $recognizer.Recognize([TimeSpan]::FromSeconds(30))
    } catch {
        [Console]::Error.WriteLine("RECOGNIZE_ERROR: " + $_.Exception.Message)
    }

    if ($result) {
        [Console]::Error.WriteLine("RESULT: '" + $result.Text + "' confidence=" + $result.Confidence)
        [Console]::Out.WriteLine($result.Text)
    } else {
        [Console]::Error.WriteLine("RESULT: empty (no speech detected or timeout)")
        [Console]::Out.WriteLine("")
    }
    [Console]::Out.Flush()

    try { $recognizer.Dispose() } catch {}
} catch {
    [Console]::Error.WriteLine("FATAL: " + $_.Exception.ToString())
    [Console]::Out.WriteLine("")
    [Console]::Out.Flush()
}
