param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [ValidateSet('Preflight','Verify')][string]$Mode = 'Verify',
    [long]$RequiredKiB = 0
)
$ErrorActionPreference = 'Stop'
try {
    $root = [IO.Path]::GetFullPath($InstallDir)
    if ($Mode -eq 'Preflight') {
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($root))
        $required = [Math]::Max(512MB, ($RequiredKiB * 1024 + 128MB))
        if ($drive.AvailableFreeSpace -lt $required) {
            throw 'No hay espacio libre suficiente para instalar GuilleCode completo. Liberá espacio y reintentá; no se reemplazaron los archivos.'
        }
        exit 0
    }
    $engine = Join-Path $root 'opencode.exe'
    $stream = [IO.File]::OpenRead($engine)
    $reader = New-Object IO.BinaryReader $stream
    try {
        $length = $stream.Length
        if ($length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'Motor OpenCode incompleto o dañado.' }
        $stream.Position = 60
        $pe = [long]$reader.ReadUInt32()
        if ($pe + 24 -gt $length) { throw 'Motor OpenCode incompleto o dañado.' }
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x4550) { throw 'Motor OpenCode incompleto o dañado.' }
        $stream.Position = $pe + 6
        $sections = $reader.ReadUInt16()
        $stream.Position = $pe + 20
        $optional = $reader.ReadUInt16()
        $table = $pe + 24 + $optional
        if ($sections -eq 0 -or $sections -gt 96 -or $table + $sections * 40 -gt $length) { throw 'Motor OpenCode incompleto o dañado.' }
        for ($index = 0; $index -lt $sections; $index++) {
            $stream.Position = $table + $index * 40 + 16
            $size = [long]$reader.ReadUInt32()
            $offset = [long]$reader.ReadUInt32()
            if ($size -gt 0 -and ($offset -eq 0 -or $offset + $size -gt $length)) { throw 'Motor OpenCode incompleto: la extracción no terminó.' }
        }
    } finally { $reader.Dispose() }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $engine
    $start.Arguments = '--version'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'El motor instalado no responde.' }
        $version = $process.StandardOutput.ReadToEnd().Trim()
        if ($process.ExitCode -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+') { throw 'No se pudo comprobar la versión del motor instalado.' }
    } finally { $process.Dispose() }
    [Console]::WriteLine("Motor OpenCode verificado: $version")
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
