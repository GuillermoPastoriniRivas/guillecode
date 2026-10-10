# Ejecuta GuilleCode en modo dev: Vite ( puerto 5173) + app.exe debug.
# Uso: .\run.ps1    (o clic derecho > Run with PowerShell)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Si hay una instancia de GuilleCode corriendo (app o su sidecar, SOLO las de
# esta carpeta), cerrarla: los builds fallan con el exe lockeado.
Get-Process | Where-Object { $_.Path -like "$root\src-tauri\target*" } |
    ForEach-Object { Stop-Process -Id $_.Id -Force }

function Test-Vite {
    # HTTP real: TcpClient en PS 5.1 pisa bugs raros con IPv6 (::1 lookup).
    try {
        Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return ($_.Exception.Response -ne $null)
    }
}

$viteUp = Test-Vite
if (-not $viteUp) {
    Write-Host "Levantando servidor Vite..." -ForegroundColor Cyan
    Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" -WorkingDirectory $root -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $viteUp = Test-Vite
        if ($viteUp) { break }
    }
    if (-not $viteUp) {
        Write-Warning "Vite no arrancó en 30s; intentando abrir la app igual (si se ve vacía, corré npm run dev a mano)"
    }
}

if (-not (Test-Path (Join-Path $root "dist-pwa\pwa.html"))) {
    Write-Host "Compilando la app del celular (dist-pwa)..." -ForegroundColor Cyan
    npm.cmd run build:pwa
    if ($LASTEXITCODE -ne 0) { throw "npm run build:pwa falló" }
}

if (-not (Test-Path (Join-Path $root "src-tauri\binaries\whisper\whisper-server.exe"))) {
    Write-Host "Descargando el motor de Whisper local..." -ForegroundColor Cyan
    npm.cmd run release:whisper
    if ($LASTEXITCODE -ne 0) { throw "npm run release:whisper falló" }
}

# Compilar siempre (cargo es incremental). Si solo compilamos cuando falta el
# exe, tras tocar el backend Rust se abre un app.exe viejo y la webview tira
# "Command <x> not found" para comandos nuevos.
$exe = Join-Path $root "src-tauri\target\debug\app.exe"
Write-Host "Compilando app (incremental)..." -ForegroundColor Cyan
Push-Location (Join-Path $root "src-tauri")
cargo build
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "cargo build falló (código $LASTEXITCODE)"
}
Pop-Location

Write-Host "Abriendo GuilleCode..." -ForegroundColor Green
Start-Process -FilePath $exe
