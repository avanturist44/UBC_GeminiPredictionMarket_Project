param([ValidateSet('start', 'stop', 'status', 'supervise')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLocal = Join-Path $taskRoot '.local'
$taskPidFile = Join-Path $taskLocal 'worker.pid'
$taskSupervisorFile = Join-Path $taskLocal 'worker-supervisor.pid'
$taskStop = Join-Path $taskLocal 'worker.stop'
$taskHealth = Join-Path $taskLocal 'worker.health.json'
$taskOut = Join-Path $taskLocal 'worker.out.log'
$taskErr = Join-Path $taskLocal 'worker.err.log'
$taskSupervisorLog = Join-Path $taskLocal 'worker-supervisor.log'
New-Item -ItemType Directory -Force -Path $taskLocal | Out-Null

function Get-TaskProcess([string]$File, [string]$Expected) {
  if (!(Test-Path -LiteralPath $File)) { return $null }
  $taskValue = [IO.File]::ReadAllText($File).Trim()
  if ($taskValue -notmatch '^\d+$') { return $null }
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskValue" -ErrorAction SilentlyContinue
  if (!$taskProcess) { return $null }
  if ($taskProcess.CommandLine -notlike "*$Expected*") { throw 'Recorded PID belongs to another process; refusing to control it.' }
  return $taskProcess
}
function Write-TaskLog([string]$Message) {
  Add-Content -LiteralPath $taskSupervisorLog -Value "$([DateTime]::UtcNow.ToString('o')) $Message"
}
if ($Action -eq 'status') {
  $taskWorker = Get-TaskProcess $taskPidFile 'apps/worker/src/index.ts'
  $taskSupervisor = Get-TaskProcess $taskSupervisorFile 'local-worker.ps1'
  $taskSnapshot = $null
  if (Test-Path -LiteralPath $taskHealth) { try { $taskSnapshot = Get-Content -LiteralPath $taskHealth -Raw | ConvertFrom-Json } catch {} }
  if (!$taskWorker -or ($taskSnapshot -and $taskSnapshot.pid -ne $taskWorker.ProcessId)) { $taskSnapshot = $null }
  $taskHealthAge = if ($taskSnapshot) { [Math]::Round(([DateTimeOffset]::UtcNow - [DateTimeOffset]$taskSnapshot.updatedAt).TotalSeconds, 1) } else { $null }
  $taskCycleAge = if ($taskSnapshot) { [Math]::Round(([DateTimeOffset]::UtcNow - [DateTimeOffset]$taskSnapshot.lastCycleAt).TotalSeconds, 1) } else { $null }
  $taskStatus = if (!$taskWorker) { 'stopped' } elseif (!$taskSnapshot) { 'starting' } elseif ($taskCycleAge -gt 300) { 'stalled' } elseif ($taskHealthAge -gt 15) { 'heartbeat stale' } elseif (!$taskSnapshot.streamConnected) { 'reconnecting' } else { 'running' }
  [pscustomobject]@{ supervisorRunning = !!$taskSupervisor; workerRunning = !!$taskWorker;
    workerPid = if ($taskWorker) { $taskWorker.ProcessId } else { $null }; status = $taskStatus;
    heartbeatAgeSeconds = $taskHealthAge; cycleAgeSeconds = $taskCycleAge; health = $taskSnapshot } | ConvertTo-Json -Depth 4
  exit 0
}
if ($Action -eq 'stop') {
  Set-Content -LiteralPath $taskStop -Value 'stop requested'
  $taskWorker = Get-TaskProcess $taskPidFile 'apps/worker/src/index.ts'
  if ($taskWorker) {
    Wait-Process -Id $taskWorker.ProcessId -Timeout 40 -ErrorAction SilentlyContinue
    if (Get-Process -Id $taskWorker.ProcessId -ErrorAction SilentlyContinue) {
      # The supervisor may already have stopped it. Revalidate before any forced stop.
      $taskWorker = Get-TaskProcess $taskPidFile 'apps/worker/src/index.ts'
      if ($taskWorker) { Stop-Process -Id $taskWorker.ProcessId }
    }
  }
  $taskSupervisor = Get-TaskProcess $taskSupervisorFile 'local-worker.ps1'
  if ($taskSupervisor) {
    Wait-Process -Id $taskSupervisor.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    $taskSupervisor = Get-TaskProcess $taskSupervisorFile 'local-worker.ps1'
    if ($taskSupervisor) { Stop-Process -Id $taskSupervisor.ProcessId }
  }
  Write-Output 'Local worker and supervisor stopped. A new start requires an explicit start command.'
  exit 0
}

# This launcher is deliberately restricted to the isolated paper database.
$taskEnv = [IO.File]::ReadAllText((Join-Path $taskRoot '.env'))
$taskConnection = [regex]::Match($taskEnv, '(?m)^DATABASE_URL=(.*)\r?$')
if (!$taskConnection.Success -or ([Uri]$taskConnection.Groups[1].Value.Trim()).Host -notin @('localhost', '127.0.0.1')) {
  throw 'Local worker supervisor requires a localhost DATABASE_URL.'
}
if ($Action -eq 'start') {
  if (Get-TaskProcess $taskSupervisorFile 'local-worker.ps1') { Write-Output 'Local supervisor is already running.'; exit 0 }
  if (Get-TaskProcess $taskPidFile 'apps/worker/src/index.ts') { throw 'An unmanaged worker is already running. Stop it before starting the supervisor.' }
  if (Test-Path -LiteralPath $taskStop) { Remove-Item -LiteralPath $taskStop }
  $taskShell = (Get-Process -Id $PID).Path
  $taskSupervisor = Start-Process -FilePath $taskShell -ArgumentList @('-NoLogo', '-NoProfile', '-File', "`"$PSCommandPath`"", 'supervise') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $taskSupervisorFile -Value $taskSupervisor.Id
  Write-Output "Local supervisor started (PID $($taskSupervisor.Id)); logs: .local/worker-supervisor.log"
  exit 0
}

$taskMutexName = 'Local\ThesisMarketWorker-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskRoot))).Substring(0, 16)
$taskMutex = [Threading.Mutex]::new($false, $taskMutexName)
$taskOwnsMutex = $false
try {
  try { $taskOwnsMutex = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskOwnsMutex = $true }
  if (!$taskOwnsMutex) { exit 0 }
  Set-Content -LiteralPath $taskSupervisorFile -Value $PID
  $env:TRADING_MODE = 'paper'
  $env:BTC_BOT_MODE = 'paper'
  $env:NEWS_AGENT_ENABLED = 'false'
  $env:WORKER_HEALTH_FILE = $taskHealth
  $env:WORKER_STOP_FILE = $taskStop
  while (!(Test-Path -LiteralPath $taskStop)) {
    foreach ($taskLogFile in @($taskOut, $taskErr)) {
      if (Test-Path -LiteralPath $taskLogFile) {
        Move-Item -LiteralPath $taskLogFile -Destination "$taskLogFile.$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')).archive"
      }
    }
    $taskStarted = [DateTimeOffset]::UtcNow
    $taskChild = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import', 'tsx', 'apps/worker/src/index.ts') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr -PassThru
    Set-Content -LiteralPath $taskPidFile -Value $taskChild.Id
    Write-TaskLog "worker started pid=$($taskChild.Id); paper BTC only; news scheduling disabled"
    while (!$taskChild.WaitForExit(2000)) {
      if (Test-Path -LiteralPath $taskStop) {
        if (!$taskChild.WaitForExit(35000)) { $taskChild.Kill(); Write-TaskLog 'worker forced to stop after graceful-stop deadline' }
        break
      }
      $taskProgress = $taskStarted
      if (Test-Path -LiteralPath $taskHealth) {
        try {
          $taskSnapshot = Get-Content -LiteralPath $taskHealth -Raw | ConvertFrom-Json
          if ($taskSnapshot.pid -eq $taskChild.Id) { $taskProgress = [DateTimeOffset]$taskSnapshot.lastCycleAt }
        } catch {}
      }
      if (([DateTimeOffset]::UtcNow - $taskProgress).TotalSeconds -gt 300) {
        Write-TaskLog 'worker made no completed-cycle progress for 300 seconds; restarting'
        $taskChild.Kill()
        break
      }
    }
    $taskChild.WaitForExit()
    Write-TaskLog "worker exited code=$($taskChild.ExitCode)"
    if (!(Test-Path -LiteralPath $taskStop)) { Start-Sleep -Seconds 5 }
  }
  Write-TaskLog 'supervisor stopped'
} finally {
  if ($taskOwnsMutex) { $taskMutex.ReleaseMutex() }
  $taskMutex.Dispose()
}
