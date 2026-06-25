$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $root "logs"
$logFile = Join-Path $logDir "trigger-github-pages.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
  Add-Content -LiteralPath $logFile -Value "[$timestamp] $Message" -Encoding UTF8
}

try {
  Set-Location $root
  $gh = Get-Command gh -ErrorAction Stop

  $runsJson = & $gh.Source run list --repo fehdfe08/hot-stock-radar --workflow deploy-pages.yml --limit 5 --json status,conclusion,createdAt,databaseId,event 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh run list failed: $runsJson"
  }

  $runs = $runsJson | ConvertFrom-Json
  $now = Get-Date

  $active = @($runs | Where-Object { $_.status -in @("queued", "in_progress", "waiting", "pending", "requested") })
  if ($active.Count -gt 0) {
    Write-Log "Skipped: workflow already active. run=$($active[0].databaseId) status=$($active[0].status)"
    exit 0
  }

  $recentSuccess = @($runs | Where-Object {
    $_.status -eq "completed" -and
    $_.conclusion -eq "success" -and
    ((New-TimeSpan -Start ([datetime]$_.createdAt) -End $now).TotalMinutes -lt 20)
  })
  if ($recentSuccess.Count -gt 0) {
    Write-Log "Skipped: recent successful workflow exists. run=$($recentSuccess[0].databaseId) createdAt=$($recentSuccess[0].createdAt)"
    exit 0
  }

  $output = $null
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    $output = & $gh.Source workflow run deploy-pages.yml --repo fehdfe08/hot-stock-radar --ref main 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Log "Triggered GitHub Pages workflow. $output"
      exit 0
    }
    Start-Sleep -Seconds (10 * $attempt)
  }

  Write-Log "Skipped: GitHub workflow dispatch unavailable after retries. $output"
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 0
}
