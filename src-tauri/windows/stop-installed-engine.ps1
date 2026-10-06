param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
try {
    $engine = [System.IO.Path]::GetFullPath((Join-Path -Path $InstallDir -ChildPath 'opencode.exe'))
    # Older apps may leave an orphan or respawn their engine during shutdown.
    # Never terminate CLI/dev engines or another installation by image name.
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='opencode.exe'"
    foreach ($process in $processes) {
        if ([string]::Equals($process.ExecutablePath, $engine, [System.StringComparison]::OrdinalIgnoreCase)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F 2>&1 | Out-Null
        }
    }

    # A kill request is not proof the image is writable yet. Wait for Windows
    # to release the lock BEFORE NSIS copies any part of the new application.
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Test-Path -LiteralPath $engine) {
        try {
            $file = [System.IO.File]::Open($engine, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
            $file.Dispose()
            break
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
