param([ValidateSet('start', 'stop', 'status')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLocal = Join-Path $taskRoot '.local'
$taskBin = Join-Path $taskLocal 'postgresql-17.12\pgsql\bin'
$taskData = Join-Path $taskLocal 'pgdata'
$taskLog = Join-Path $taskLocal 'postgres.log'
$taskEnvFile = Join-Path $taskRoot '.env'

if (!(Test-Path (Join-Path $taskBin 'pg_ctl.exe'))) {
  throw 'Portable PostgreSQL is missing. Follow docs/btc-paper-worker.md local setup first.'
}
if ($Action -ne 'start') {
  & (Join-Path $taskBin 'pg_ctl.exe') $Action -D $taskData
  exit $LASTEXITCODE
}
if (!(Test-Path $taskEnvFile)) { throw 'Create the ignored root .env first.' }
$taskEnvText = [IO.File]::ReadAllText($taskEnvFile)
$taskMatch = [regex]::Match($taskEnvText, '(?m)^DATABASE_URL=(.*)\r?$')
if (!$taskMatch.Success) { throw 'DATABASE_URL is missing from .env.' }
$taskUri = [Uri]$taskMatch.Groups[1].Value.Trim()
if ($taskUri.Host -notin @('localhost', '127.0.0.1') -or $taskUri.AbsolutePath -ne '/thesis_market') {
  throw 'Refusing to replace a non-local DATABASE_URL. This helper is only for local thesis_market.'
}

if (!(Test-Path (Join-Path $taskData 'PG_VERSION'))) {
  $taskPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $taskPasswordFile = Join-Path $taskLocal 'init-password.tmp'
  try {
    [IO.File]::WriteAllText($taskPasswordFile, $taskPassword)
    & (Join-Path $taskBin 'initdb.exe') -D $taskData -U postgres -E UTF8 --locale=C --auth=scram-sha-256 "--pwfile=$taskPasswordFile"
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed.' }
    Add-Content -LiteralPath (Join-Path $taskData 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = 5432"
    $taskLocalUrl = "postgresql://postgres:${taskPassword}@127.0.0.1:5432/thesis_market"
    $taskEnvText = [regex]::Replace($taskEnvText, '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$taskLocalUrl")
    [IO.File]::WriteAllText($taskEnvFile, $taskEnvText)
    $taskUri = [Uri]$taskLocalUrl
  } finally {
    if (Test-Path $taskPasswordFile) { Remove-Item -LiteralPath $taskPasswordFile }
  }
}
& (Join-Path $taskBin 'pg_ctl.exe') status -D $taskData *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $taskBin 'pg_ctl.exe') start -D $taskData -l $taskLog -w -t 30
  if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL did not start; inspect .local/postgres.log.' }
}
$taskPreviousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = [Uri]::UnescapeDataString(($taskUri.UserInfo -split ':', 2)[1])
  [string]$taskExists = & (Join-Path $taskBin 'psql.exe') -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc "select 1 from pg_database where datname = 'thesis_market'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to local PostgreSQL.' }
  if ("$taskExists".Trim() -ne '1') {
    & (Join-Path $taskBin 'createdb.exe') -h 127.0.0.1 -p 5432 -U postgres thesis_market
    if ($LASTEXITCODE -ne 0) { throw 'Could not create local thesis_market database.' }
  }
} finally { $env:PGPASSWORD = $taskPreviousPassword }
Write-Output 'Local PostgreSQL ready at 127.0.0.1:5432/thesis_market. Hosted configuration unchanged.'
