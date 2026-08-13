# Windows installed-layout runtime smoke for Zephyr One.
param(
  [string]$Root = "",
  [string]$OutDir = "",
  [int]$ReadyTimeoutSec = 120,
  [int]$HoldSec = 60
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $OutDir) { $OutDir = Join-Path $Root "dist-windows-smoke" }
$Root = (Resolve-Path -LiteralPath $Root).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$script:RunId = [Guid]::NewGuid().ToString("N")
$script:LogPath = Join-Path $OutDir ("smoke-{0}.log" -f $script:RunId)
$script:AppProcess = $null
$script:AppPid = 0
$script:InstallDir = $null
$script:ExpectedNode = $null
$script:ExpectedServer = $null
$script:DataDir = Join-Path (Join-Path $env:APPDATA "com.zephyr.one") "zephyr-data"

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "o"), $Message
  $line | Tee-Object -FilePath $script:LogPath -Append | Write-Host
}

function Get-RedirectLocation([string]$Uri) {
  $request = [System.Net.HttpWebRequest]::Create($Uri)
  $request.AllowAutoRedirect = $false
  $request.Timeout = 15000
  $response = $request.GetResponse()
  try {
    if ([int]$response.StatusCode -ne 302) {
      throw "expected HTTP 302 from $Uri, got $([int]$response.StatusCode)"
    }
    return [string]$response.Headers['Location']
  } finally {
    $response.Close()
  }
}

function Get-CapturedProcessTree {
  if (-not $script:AppPid) { return @() }
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $captured = [System.Collections.Generic.HashSet[uint32]]::new()
  [void]$captured.Add([uint32]$script:AppPid)
  do {
    $changed = $false
    foreach ($item in $all) {
      if ($captured.Contains([uint32]$item.ParentProcessId) -and
          $captured.Add([uint32]$item.ProcessId)) {
        $changed = $true
      }
    }
  } while ($changed)
  return @($all | Where-Object { $captured.Contains([uint32]$_.ProcessId) })
}

function Stop-CapturedRuntime {
  if (-not $script:AppProcess) { return }
  $tree = @(Get-CapturedProcessTree)
  if (-not $script:AppProcess.HasExited) {
    try { $script:AppProcess.Kill() } catch {}
    try { [void]$script:AppProcess.WaitForExit(10000) } catch {}
  }
  foreach ($item in @($tree | Where-Object { $_.ProcessId -ne $script:AppPid })) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Dump-Fail([string]$Reason) {
  Write-Log "FAIL: $Reason"
  $diag = Join-Path $OutDir ("diagnostics-{0}.txt" -f $script:RunId)
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("==== $Reason ====") | Out-Null
  $lines.Add("runId=$($script:RunId)") | Out-Null
  $lines.Add("appPid=$($script:AppPid)") | Out-Null
  $lines.Add("expectedNode=$($script:ExpectedNode)") | Out-Null
  $lines.Add("expectedServer=$($script:ExpectedServer)") | Out-Null
  $lines.Add("dataDir=$($script:DataDir)") | Out-Null
  $lines.Add("---- captured process tree ----") | Out-Null
  try {
    $lines.Add((Get-CapturedProcessTree |
      Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
      Format-List | Out-String)) | Out-Null
  } catch { $lines.Add("$_") | Out-Null }
  $lines.Add("---- captured listening ports ----") | Out-Null
  try {
    $capturedIds = @(Get-CapturedProcessTree | Select-Object -ExpandProperty ProcessId)
    $lines.Add((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $capturedIds -contains $_.OwningProcess } |
      Select-Object LocalAddress,LocalPort,OwningProcess |
      Format-Table -AutoSize | Out-String)) | Out-Null
  } catch { $lines.Add("$_") | Out-Null }
  $lines.Add("---- installed resource roots ----") | Out-Null
  foreach ($path in @($script:InstallDir, (Split-Path -Parent $script:ExpectedNode), (Split-Path -Parent $script:ExpectedServer))) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      try {
        $lines.Add((Get-Item -LiteralPath $path -Force |
          Select-Object FullName,Attributes,LastWriteTime |
          Format-List | Out-String)) | Out-Null
      } catch { $lines.Add("$_") | Out-Null }
    }
  }
  $lines | Set-Content -Encoding utf8 -LiteralPath $diag
  $lines | ForEach-Object { Write-Host $_ }
  Stop-CapturedRuntime
  throw $Reason
}

$bundle = Join-Path $Root "src-tauri\target\release\bundle"
$nsis = Get-ChildItem -Path $bundle -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\nsis\\' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $nsis) { Dump-Fail "No NSIS installer was produced" }

Write-Log ("Installing NSIS: {0}" -f $nsis.FullName)
$installer = Start-Process -FilePath $nsis.FullName -ArgumentList "/S" -Wait -PassThru
if ($installer.ExitCode -ne 0) { Dump-Fail ("NSIS installer exit {0}" -f $installer.ExitCode) }

$knownCandidates = @(@(
    (Join-Path $env:LOCALAPPDATA "Zephyr One\zephyr-one.exe"),
    (Join-Path $env:ProgramFiles "Zephyr One\zephyr-one.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Zephyr One\zephyr-one.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($knownCandidates.Count -ne 1) {
  Dump-Fail ("Expected exactly one installed Zephyr executable, found {0}" -f $knownCandidates.Count)
}
$launchExe = (Resolve-Path -LiteralPath $knownCandidates[0]).Path
$script:InstallDir = Split-Path -Parent $launchExe
$script:ExpectedNode = Join-Path $script:InstallDir "_up_\desktop-runtime\node.exe"
$script:ExpectedServer = Join-Path $script:InstallDir "_up_\zephyr-core\server.js"
foreach ($required in @($launchExe, $script:ExpectedNode, $script:ExpectedServer)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    Dump-Fail ("Installed runtime file missing: {0}" -f $required)
  }
}
$script:ExpectedNode = (Resolve-Path -LiteralPath $script:ExpectedNode).Path
$script:ExpectedServer = (Resolve-Path -LiteralPath $script:ExpectedServer).Path
Write-Log ("Installed app: {0}" -f $launchExe)
Write-Log ("Expected Node: {0}" -f $script:ExpectedNode)

$installedDlls = @(Get-ChildItem -LiteralPath $script:InstallDir -File -Filter "*.dll" -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Name)
$dynamicFreeRdp = @($installedDlls | Where-Object { $_ -match '^(?:lib)?(?:freerdp|winpr)' })
if ($dynamicFreeRdp.Count -gt 0) {
  Dump-Fail ("installed payload contains FreeRDP/WinPR DLLs: {0}" -f ($dynamicFreeRdp -join ', '))
}

$env:ZEPHYR_ONE_AUTOSTART_RUNTIME = "1"
Write-Log ("Launching installed app cwd='{0}'" -f $script:InstallDir)
$script:AppProcess = Start-Process -FilePath $launchExe -WorkingDirectory $script:InstallDir -PassThru
if (-not $script:AppProcess) { Dump-Fail "Start-Process returned null" }
$script:AppPid = $script:AppProcess.Id
Write-Log ("appPid={0}" -f $script:AppPid)

$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$ready = $false
$port = $null
$nodePid = $null
while ((Get-Date) -lt $deadline) {
  if ($script:AppProcess.HasExited) {
    Dump-Fail ("zephyr-one.exe exited early code={0}" -f $script:AppProcess.ExitCode)
  }
  $tree = @(Get-CapturedProcessTree)
  $nodes = @($tree | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.ExecutablePath -and
    [string]::Equals($_.ExecutablePath, $script:ExpectedNode, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($script:ExpectedServer, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($nodes.Count -gt 1) { Dump-Fail "Captured runtime tree contains multiple installed Node processes" }
  if ($nodes.Count -eq 1) {
    $candidatePid = [uint32]$nodes[0].ProcessId
    $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object {
        $_.OwningProcess -eq $candidatePid -and
        $_.LocalAddress -in @('127.0.0.1', '::1') -and
        $_.LocalPort -gt 1024
      })
    foreach ($connection in $connections) {
      try {
        $response = Invoke-WebRequest -UseBasicParsing `
          -Uri ("http://127.0.0.1:{0}/healthz" -f $connection.LocalPort) -TimeoutSec 2
        $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
        if ($response.StatusCode -eq 200 -and
            $body.ok -eq $true -and
            $body.instanceId -is [string] -and $body.instanceId.Length -ge 16 -and
            $body.version -is [string] -and $body.version.Length -gt 0) {
          $ready = $true
          $port = [int]$connection.LocalPort
          $nodePid = $candidatePid
          $response.Content | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutDir ("healthz-{0}.json" -f $script:RunId))
          break
        }
      } catch {}
    }
  }
  if ($ready) { break }
  Start-Sleep -Seconds 2
}
if (-not $ready -or -not $port -or -not $nodePid) {
  Dump-Fail ("captured installed core not ready within {0}s" -f $ReadyTimeoutSec)
}
Write-Log ("Exact installed Node health ready pid={0} port={1}" -f $nodePid, $port)

try {
  # A dead embedded session must not bounce / -> /app.html -> / forever
  # (ERR_TOO_MANY_REDIRECTS): "/" serves the self-repair document instead of
  # looping, and /app.html still rejects an unauthenticated request home.
  $rootResponse = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/" -f $port) -TimeoutSec 15
  if ($rootResponse.StatusCode -ne 200 -or $rootResponse.Content -notmatch 'zephyr-one-recovery') {
    Dump-Fail ("embedded root did not serve the recovery document (redirect loop guard missing) status={0}" -f $rootResponse.StatusCode)
  }
  $appLocation = Get-RedirectLocation ("http://127.0.0.1:{0}/app.html" -f $port)
  if ($appLocation -ne '/') {
    Dump-Fail ("embedded auth redirect contract changed app={0}" -f $appLocation)
  }
  $assetResponse = Invoke-WebRequest -UseBasicParsing `
    -Uri ("http://127.0.0.1:{0}/zephyr-one-embed.css" -f $port) -TimeoutSec 15
} catch {
  Dump-Fail ("embedded UI route probe failed: {0}" -f $_)
}
if ($assetResponse.StatusCode -ne 200 -or
    $assetResponse.Content.Length -lt 100 -or
    $assetResponse.Content -notmatch 'Zephyr One') {
  Dump-Fail ("Zephyr One UI asset was not an expected product document status={0}" -f $assetResponse.StatusCode)
}
$snippetLength = [Math]::Min(500, $assetResponse.Content.Length)
$assetResponse.Content.Substring(0, $snippetLength) |
  Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutDir ("ui-asset-head-{0}.txt" -f $script:RunId))

$holdDeadline = (Get-Date).AddSeconds($HoldSec)
while ((Get-Date) -lt $holdDeadline) {
  if ($script:AppProcess.HasExited) {
    Dump-Fail ("app exited during hold window code={0}" -f $script:AppProcess.ExitCode)
  }
  $tree = @(Get-CapturedProcessTree)
  $sameNode = @($tree | Where-Object {
    $_.ProcessId -eq $nodePid -and
    $_.ExecutablePath -and
    [string]::Equals($_.ExecutablePath, $script:ExpectedNode, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($sameNode.Count -ne 1) { Dump-Fail "captured installed Node exited or changed during hold" }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $port) -TimeoutSec 5
    $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
    if ($response.StatusCode -ne 200 -or $body.ok -ne $true) {
      Dump-Fail "exact Zephyr health response changed during hold"
    }
  } catch {
    Dump-Fail ("healthz failed during hold: {0}" -f $_)
  }
  Start-Sleep -Seconds 5
}

@(
  "runId=$($script:RunId)",
  "launchExe=$launchExe",
  "installDir=$($script:InstallDir)",
  "dataDir=$($script:DataDir)",
  "node=$($script:ExpectedNode)",
  "nodePid=$nodePid",
  "port=$port",
  "holdSec=$HoldSec"
) | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutDir ("summary-{0}.txt" -f $script:RunId))

Write-Log ("PASS: installed Windows runtime pid={0} port={1} hold={2}s" -f $nodePid, $port, $HoldSec)
Stop-CapturedRuntime
exit 0
