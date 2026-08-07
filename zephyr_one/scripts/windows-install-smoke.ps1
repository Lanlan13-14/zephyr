# Windows install + runtime smoke for Zephyr One.
# Catches packaging bugs the pure build job never sees (verbatim \\?\ paths,
# missing desktop-runtime/zephyr-core resources, Node early-exit, empty logs).
param(
  [string]$Root = "",
  [string]$OutDir = "",
  [int]$ReadyTimeoutSec = 120,
  [int]$HoldSec = 60
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $OutDir) { $OutDir = Join-Path $Root "dist-windows-smoke" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "o"), $msg
  $line | Tee-Object -FilePath (Join-Path $OutDir "smoke.log") -Append | Write-Host
}

function Dump-Fail([string]$reason) {
  Write-Log "FAIL: $reason"
  $diag = Join-Path $OutDir "diagnostics.txt"
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("==== $reason ====") | Out-Null
  $lines.Add("---- processes ----") | Out-Null
  try {
    $lines.Add((Get-Process -Name "zephyr-one","node" -ErrorAction SilentlyContinue | Format-List Id,ProcessName,Path,StartTime | Out-String)) | Out-Null
  } catch { $lines.Add("$_") | Out-Null }
  $lines.Add("---- install dir tree ----") | Out-Null
  if ($script:InstallDir -and (Test-Path -LiteralPath $script:InstallDir)) {
    try {
      $lines.Add((Get-ChildItem -LiteralPath $script:InstallDir -Recurse -Force -ErrorAction SilentlyContinue |
        Select-Object -First 120 FullName,Length |
        Format-Table -AutoSize | Out-String)) | Out-Null
    } catch { $lines.Add("$_") | Out-Null }
  } else {
    $lines.Add("(no install dir)") | Out-Null
  }
  $lines.Add("---- app data scan under LOCALAPPDATA ----") | Out-Null
  try {
    $hits = Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'zephyr-node\.log|runtime-boot\.json|zephyr-data' } |
      Select-Object -First 40 FullName,Length,LastWriteTime
    $lines.Add(($hits | Format-Table -AutoSize | Out-String)) | Out-Null
  } catch { $lines.Add("$_") | Out-Null }
  $lines.Add("---- node log ----") | Out-Null
  if ($script:NodeLog -and (Test-Path -LiteralPath $script:NodeLog)) {
    $lines.Add((Get-Content -LiteralPath $script:NodeLog -Raw -ErrorAction SilentlyContinue)) | Out-Null
    Copy-Item -LiteralPath $script:NodeLog -Destination (Join-Path $OutDir "zephyr-node.log") -Force
  } else {
    $lines.Add("(missing node log path=$($script:NodeLog))") | Out-Null
  }
  $lines.Add("---- env ----") | Out-Null
  $lines.Add(("LOCALAPPDATA={0}" -f $env:LOCALAPPDATA)) | Out-Null
  $lines.Add(("ZEPHYR_ONE_AUTOSTART_RUNTIME={0}" -f $env:ZEPHYR_ONE_AUTOSTART_RUNTIME)) | Out-Null
  $lines | Set-Content -Encoding utf8 $diag
  throw $reason
}

# Prefer NSIS installer if present; else portable release layout next to built exe.
$bundle = Join-Path $Root "src-tauri\target\release\bundle"
$nsis = Get-ChildItem -Path $bundle -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\nsis\\' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$msi = Get-ChildItem -Path $bundle -Recurse -Filter "*.msi" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$releaseExe = Join-Path $Root "src-tauri\target\release\zephyr-one.exe"

$launchExe = $null
$installDir = $null

if ($nsis) {
  Write-Log ("Installing NSIS: {0}" -f $nsis.FullName)
  # NSIS silent; product name "Zephyr One"
  $p = Start-Process -FilePath $nsis.FullName -ArgumentList "/S" -Wait -PassThru
  if ($p.ExitCode -ne 0) { Dump-Fail ("NSIS installer exit {0}" -f $p.ExitCode) }
  # Force array (@(...)): a single pipeline string would make $x[0] == 'C' (first char).
  $candidates = @(
    @(
      (Join-Path $env:LOCALAPPDATA "Zephyr One\zephyr-one.exe"),
      (Join-Path $env:ProgramFiles "Zephyr One\zephyr-one.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "Zephyr One\zephyr-one.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  )
  if ($candidates.Count -eq 0) {
    $found = @(Get-ChildItem -Path $env:LOCALAPPDATA,$env:ProgramFiles -Recurse -Filter "zephyr-one.exe" -ErrorAction SilentlyContinue |
      Select-Object -First 5)
    foreach ($f in $found) { $candidates += $f.FullName }
  }
  if ($candidates.Count -eq 0) { Dump-Fail "NSIS finished but zephyr-one.exe not found under LocalAppData/Program Files" }
  $launchExe = [string]$candidates[0]
  if ($launchExe.Length -lt 8 -or -not (Test-Path -LiteralPath $launchExe)) {
    Dump-Fail ("Resolved launch path looks wrong: '{0}' (candidates={1})" -f $launchExe, ($candidates -join '|'))
  }
  $installDir = Split-Path -Parent $launchExe
  Write-Log ("Installed app: {0}" -f $launchExe)
  Write-Log ("Install dir: {0}" -f $installDir)
} elseif (Test-Path -LiteralPath $releaseExe) {
  Write-Log ("No NSIS; using portable release exe: {0}" -f $releaseExe)
  $launchExe = $releaseExe
  $installDir = Split-Path -Parent $launchExe
  $res = Join-Path $installDir "resources"
  if (-not (Test-Path -LiteralPath $res)) {
    Write-Log "WARN: portable layout missing resources/ next to exe — runtime may fail to find core"
  }
} else {
  Dump-Fail "No NSIS installer and no release zephyr-one.exe"
}

# App data / log paths used by runtime::ensure_started
$script:DataDir = Join-Path $env:LOCALAPPDATA "com.zephyr.one\zephyr-data"
if (-not (Test-Path $script:DataDir)) {
  # Tauri may use product identifier path variants
  $alt = Get-ChildItem -Path $env:LOCALAPPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'zephyr|com\.zephyr' }
  foreach ($d in $alt) {
    $cand = Join-Path $d.FullName "zephyr-data"
    if (Test-Path $cand) { $script:DataDir = $cand; break }
    $script:DataDir = $cand
  }
}
$script:NodeLog = Join-Path $script:DataDir "zephyr-node.log"

# Kill leftovers from previous runs
Get-Process -Name "zephyr-one" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if (Test-Path $script:NodeLog) { Remove-Item $script:NodeLog -Force -ErrorAction SilentlyContinue }

if (-not $installDir -or -not (Test-Path -LiteralPath $installDir)) {
  Dump-Fail ("installDir invalid: '{0}'" -f $installDir)
}
$script:InstallDir = $installDir
# CI/headless: start embedded core from Rust setup without waiting on WebView JS.
$env:ZEPHYR_ONE_AUTOSTART_RUNTIME = "1"
Write-Log ("Launching '{0}' cwd='{1}' ZEPHYR_ONE_AUTOSTART_RUNTIME=1" -f $launchExe, $installDir)
$proc = Start-Process -FilePath $launchExe -WorkingDirectory $installDir -PassThru
if (-not $proc) { Dump-Fail "Start-Process returned null" }
Write-Log ("pid={0}" -f $proc.Id)

# Wait for log + Zephyr HTTP line (same contract as Android smoke)
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$ready = $false
$port = $null
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Dump-Fail ("zephyr-one.exe exited early code={0}" -f $proc.ExitCode)
  }
  # Refresh data dir if Tauri created it after start
  if (-not (Test-Path $script:NodeLog)) {
    $guess = Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -Filter "zephyr-node.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($guess) {
      $script:NodeLog = $guess.FullName
      $script:DataDir = Split-Path -Parent $script:NodeLog
      Write-Log ("found node log: {0}" -f $script:NodeLog)
    }
  }
  if (Test-Path $script:NodeLog) {
    $text = Get-Content -Raw $script:NodeLog -ErrorAction SilentlyContinue
    if ($text) {
      Set-Content -Encoding utf8 (Join-Path $OutDir "zephyr-node.log") $text
      if ($text -match 'Zephyr HTTP.*localhost:(\d+)') {
        $port = [int]$Matches[1]
        $ready = $true
        break
      }
      if ($text -match '\[startup\] Zephyr|EISDIR|ENOENT|未找到|失败') {
        Dump-Fail "Node log reports startup failure (see zephyr-node.log)"
      }
      # Catch the historical verbatim-path bug explicitly
      if ($text -match '\\\\\?\\C:' -or $text -match 'EISDIR') {
        Dump-Fail "Node log suggests Windows verbatim path / EISDIR regression"
      }
    }
  }
  Start-Sleep -Seconds 2
}

if (-not $ready -or -not $port) {
  Dump-Fail ("core not ready within {0}s (no Zephyr HTTP line)" -f $ReadyTimeoutSec)
}

Write-Log ("HTTP ready on port {0}" -f $port)
try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $port) -TimeoutSec 10
  $health.Content | Set-Content -Encoding utf8 (Join-Path $OutDir "healthz.json")
  if ($health.StatusCode -lt 200 -or $health.StatusCode -ge 500) {
    Dump-Fail ("healthz status {0}" -f $health.StatusCode)
  }
  $home = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/" -f $port) -TimeoutSec 15
  $home.Content.Substring(0, [Math]::Min(500, $home.Content.Length)) |
    Set-Content -Encoding utf8 (Join-Path $OutDir "index-head.txt")
} catch {
  Dump-Fail ("HTTP probe failed: {0}" -f $_)
}

# Hold: catch delayed Node death / path issues after first success
$holdDeadline = (Get-Date).AddSeconds($HoldSec)
while ((Get-Date) -lt $holdDeadline) {
  if ($proc.HasExited) {
    Dump-Fail ("app exited during hold window code={0}" -f $proc.ExitCode)
  }
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $port) -TimeoutSec 5
  } catch {
    Dump-Fail ("healthz failed during hold: {0}" -f $_)
  }
  Start-Sleep -Seconds 5
}

# Resource layout note for artifact
@(
  "launchExe=$launchExe",
  "installDir=$installDir",
  "dataDir=$script:DataDir",
  "nodeLog=$script:NodeLog",
  "port=$port",
  "holdSec=$HoldSec"
) | Set-Content -Encoding utf8 (Join-Path $OutDir "summary.txt")

Write-Log ("PASS: Windows smoke ok port={0} hold={1}s" -f $port, $HoldSec)

# Clean stop so the runner can finish
Get-Process -Name "zephyr-one" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
exit 0
