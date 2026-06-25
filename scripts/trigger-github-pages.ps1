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
  $output = & $gh.Source workflow run deploy-pages.yml --repo fehdfe08/hot-stock-radar --ref main 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh workflow run failed: $output"
  }
  Write-Log "Triggered GitHub Pages workflow. $output"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
