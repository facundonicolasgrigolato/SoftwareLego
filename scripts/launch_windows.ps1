$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$FrontendDir = Join-Path $RootDir "frontend"
$BackendDir = Join-Path $RootDir "backend"
$Url = "http://127.0.0.1:5173/"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   SoftwareLego - Preparando mesa 3D    " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($machinePath, $userPath) -join ";"
}

function Test-Port5173Open {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $ok = $client.ConnectAsync("127.0.0.1", 5173).Wait(400) -and $client.Connected
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

function Find-NodeExe {
    $cmd = Get-Command "node" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Find-PythonInvocation {
    $pyCmd = Get-Command "py" -ErrorAction SilentlyContinue
    if ($pyCmd) {
        try {
            & $pyCmd.Source -3 -c "import sys; assert sys.version_info >= (3,10)" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $exe = & $pyCmd.Source -3 -c "import sys; print(sys.executable)" 2>$null
                if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
            }
        } catch {}
    }

    foreach ($name in @("python", "python3")) {
        $c = Get-Command $name -ErrorAction SilentlyContinue
        if ($c -and ($c.Source -notlike "*WindowsApps\python*.exe")) {
            try {
                & $c.Source -c "import sys; assert sys.version_info >= (3,10)" 2>$null
                if ($LASTEXITCODE -eq 0) { return $c.Source }
            } catch {}
        }
    }

    foreach ($base in @("$env:LOCALAPPDATA\Programs\Python", $env:ProgramFiles, "C:\")) {
        if (-not $base -or -not (Test-Path $base)) { continue }
        $dirs = Get-ChildItem -Path $base -Directory -Filter "Python3*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $dirs) {
            $exe = Join-Path $d.FullName "python.exe"
            if (Test-Path $exe) {
                try {
                    & $exe -c "import sys; assert sys.version_info >= (3,10)" 2>$null
                    if ($LASTEXITCODE -eq 0) { return $exe }
                } catch {}
            }
        }
    }
    return $null
}

function Install-WithWinget {
    param([string]$PackageId, [string]$FriendlyName)
    $winget = Get-Command "winget" -ErrorAction SilentlyContinue
    if (-not $winget) {
        return $false
    }
    Write-Host "[INSTALANDO] Descargando e instalando $FriendlyName (solo la primera vez)..." -ForegroundColor Yellow
    & $winget.Source install -e --id $PackageId --accept-package-agreements --accept-source-agreements --silent
    Refresh-ProcessPath
    return ($LASTEXITCODE -eq 0)
}

if (Test-Port5173Open) {
    Write-Host "SoftwareLego ya esta abierto. Abriendo el navegador en $Url..." -ForegroundColor Green
    Start-Process $Url
    exit 0
}

# 1. Asegurar Node.js
$nodeExe = Find-NodeExe
if (-not $nodeExe) {
    $installed = Install-WithWinget -PackageId "OpenJS.NodeJS.LTS" -FriendlyName "Node.js LTS"
    $nodeExe = Find-NodeExe
    if (-not $nodeExe) {
        Write-Host "[ERROR] No se pudo instalar Node.js automaticamente." -ForegroundColor Red
        Write-Host "Descargalo gratis desde: https://nodejs.org/ (version LTS) y volve a abrir este archivo." -ForegroundColor Yellow
        Start-Process "https://nodejs.org/"
        exit 1
    }
}
$nodeDir = Split-Path -Parent $nodeExe
if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
}
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path $npmCmd)) { $npmCmd = "npm.cmd" }

# 2. Asegurar Python 3.11+
$pythonExe = Find-PythonInvocation
if (-not $pythonExe) {
    $installed = Install-WithWinget -PackageId "Python.Python.3.12" -FriendlyName "Python 3.12"
    $pythonExe = Find-PythonInvocation
    if (-not $pythonExe) {
        Write-Host "[ERROR] No se pudo instalar Python automaticamente." -ForegroundColor Red
        Write-Host "Descargalo gratis desde: https://www.python.org/downloads/ (marca 'Add python.exe to PATH') y volve a abrir este archivo." -ForegroundColor Yellow
        Start-Process "https://www.python.org/downloads/"
        exit 1
    }
}
$env:SOFTWARELEGO_PYTHON = $pythonExe

# 3. Asegurar pymupdf
$hasPyMuPdf = $false
try {
    & $pythonExe -c "import pymupdf" 2>$null
    $hasPyMuPdf = ($LASTEXITCODE -eq 0)
} catch {}

if (-not $hasPyMuPdf) {
    Write-Host "[SETUP] Instalando lector de manuales PDF (pymupdf)..." -ForegroundColor Yellow
    $reqPath = Join-Path $BackendDir "requirements.txt"
    & $pythonExe -m pip install --upgrade pip --quiet
    & $pythonExe -m pip install -r $reqPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Fallo la instalacion de pymupdf." -ForegroundColor Red
        exit 1
    }
}

# 4. Asegurar carpetas base y catalogo offline (Rebrickable + LDraw)
foreach ($dir in @(
    (Join-Path $RootDir "Sets"),
    (Join-Path $RootDir "Saves"),
    (Join-Path $RootDir "output\sets"),
    (Join-Path $RootDir "output\covers")
)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$catalogSqlite = Join-Path $RootDir "data\catalog.sqlite"
$ldrawPartsA = Join-Path $RootDir "data\ldraw\parts"
$ldrawPartsB = Join-Path $RootDir "data\ldraw\ldraw\parts"
$hasLdraw = (Test-Path $ldrawPartsA) -or (Test-Path $ldrawPartsB)

if (-not (Test-Path $catalogSqlite) -or -not $hasLdraw) {
    Write-Host ""
    Write-Host "[PRIMERA VEZ] Descargando catalogo oficial de piezas LEGO (~180 MB)..." -ForegroundColor Yellow
    Write-Host "Esto se hace una sola vez y puede tardar unos minutos. No cierres esta ventana." -ForegroundColor Yellow
    Write-Host ""
    $setupScript = Join-Path $BackendDir "scripts\setup_catalog.py"
    & $pythonExe $setupScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] No se pudo descargar el catalogo LEGO. Revisa tu internet y volve a intentar." -ForegroundColor Red
        exit 1
    }
}

# 5. Asegurar dependencias frontend (incluye peerjs para multijugador)
$needNpmInstall = -not (Test-Path (Join-Path $FrontendDir "node_modules")) `
    -or -not (Test-Path (Join-Path $FrontendDir "node_modules\three")) `
    -or -not (Test-Path (Join-Path $FrontendDir "node_modules\cannon-es")) `
    -or -not (Test-Path (Join-Path $FrontendDir "node_modules\peerjs"))

if ($needNpmInstall) {
    Write-Host "[SETUP] Instalando componentes 3D y red..." -ForegroundColor Yellow
    Push-Location $FrontendDir
    try {
        & $npmCmd install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Fallo la instalacion de componentes web." -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Todo listo! Iniciando SoftwareLego en $Url" -ForegroundColor Green
Write-Host "(Deja esta ventana abierta mientras juegues; cerrala al terminar.)" -ForegroundColor Gray
Write-Host ""

# Espera en segundo plano a que el servidor responda y abre el navegador automaticamente
Start-Job -ScriptBlock {
    param($targetUrl)
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            if ($c.ConnectAsync("127.0.0.1", 5173).Wait(300) -and $c.Connected) {
                $c.Close()
                Start-Process $targetUrl
                return
            }
            $c.Close()
        } catch {}
        Start-Sleep -Milliseconds 300
    }
} -ArgumentList $Url | Out-Null

Push-Location $FrontendDir
try {
    & $npmCmd run dev
} finally {
    Pop-Location
}
