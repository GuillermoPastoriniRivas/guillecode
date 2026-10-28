param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
try {
    $engine = [System.IO.Path]::GetFullPath((Join-Path -Path $InstallDir -ChildPath 'opencode.exe'))
    if (-not (Test-Path -LiteralPath $engine)) { exit 0 }
    # GetFullPath is lexical: RUNNER~1, junctions and long paths may still name
    # the same file differently. Compare the actual file paths returned by Windows.
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FlufyInstallerPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
}
'@
    function Get-EngineFinalPath([string]$Path) {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try {
            $buffer = New-Object System.Text.StringBuilder 32768
            $length = [FlufyInstallerPath]::GetFinalPathNameByHandle($stream.SafeFileHandle, $buffer, $buffer.Capacity, 0)
            if ($length -eq 0 -or $length -ge $buffer.Capacity) {
                throw (New-Object System.ComponentModel.Win32Exception)
            }
            return $buffer.ToString()
        } finally { $stream.Dispose() }
    }
    $engineFinalPath = Get-EngineFinalPath $engine
    # Older apps may leave an orphan or respawn their engine during shutdown.
    # Never terminate CLI/dev engines or another installation by image name.
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='opencode.exe'"
    foreach ($process in $processes) {
        if (-not $process.ExecutablePath) { continue }
        try { $processFinalPath = Get-EngineFinalPath $process.ExecutablePath } catch { continue }
        if ([string]::Equals($processFinalPath, $engineFinalPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            # A process can exit between enumeration and taskkill. Its exit code
            # is secondary to the writable-image check below.
            Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID', $process.ProcessId, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
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
