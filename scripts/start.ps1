# InquiryDesk one-click starter for Windows.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Host.UI.RawUI.WindowTitle = "InquiryDesk"
Write-Host ""
Write-Host "=== InquiryDesk ===" -ForegroundColor Green
Write-Host ""

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed. Opening the download page..." -ForegroundColor Yellow
  Write-Host "Install the version marked 'LTS', then double-click 'Start InquiryDesk' again."
  Start-Process "https://nodejs.org/"
  Read-Host "Press Enter to close"
  exit 1
}
$ver = (node -v).TrimStart("v").Split(".")
if ([int]$ver[0] -lt 20) {
  Write-Host "Your Node.js is too old ($(node -v)). Install the LTS version from nodejs.org, then try again." -ForegroundColor Yellow
  Start-Process "https://nodejs.org/"
  Read-Host "Press Enter to close"
  exit 1
}

function Set-Password {
  $sec = Read-Host "Type your Supabase DATABASE password (it will not be shown) and press Enter" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ([string]::IsNullOrWhiteSpace($plain)) { Write-Host "No password entered."; return $false }
  $enc = [Uri]::EscapeDataString($plain)
  $text = [IO.File]::ReadAllText("$PWD\.env.local")
  $text = [Regex]::Replace($text, '(?m)^DATABASE_URL=postgresql://([^:]+):[^@]*@', { param($m) "DATABASE_URL=postgresql://$($m.Groups[1].Value):$enc@" })
  [IO.File]::WriteAllText("$PWD\.env.local", $text, (New-Object Text.UTF8Encoding($false)))
  return $true
}

# 2. Packages (first run only)
if (-not (Test-Path "node_modules")) {
  Write-Host "Installing InquiryDesk (first time only, takes a few minutes)..." -ForegroundColor Cyan
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host "Installation failed. Check your internet connection and try again." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
}

# 3. Password + connection check
if ((Get-Content .env.local -Raw) -match '\[YOUR-PASSWORD\]') { if (-not (Set-Password)) { Read-Host "Press Enter to close"; exit 1 } }
for ($i = 0; $i -lt 3; $i++) {
  Write-Host "Checking the database connection..." -ForegroundColor Cyan
  $out = node scripts/check-db.mjs
  Write-Host $out
  if ($LASTEXITCODE -eq 0) { break }
  if ($out -match "WRONG_PASSWORD") {
    Write-Host "That password was not accepted. Try again (or reset it in Supabase)." -ForegroundColor Yellow
    [void](Set-Password)
  } else { Read-Host "Press Enter to close"; exit 1 }
}
if ($LASTEXITCODE -ne 0) { Read-Host "Press Enter to close"; exit 1 }

# 4. Start
Write-Host ""
Write-Host "Starting InquiryDesk. Your browser will open at http://localhost:3000" -ForegroundColor Green
Write-Host "Keep this window open while you use the app. Close it to stop."
Start-Job { Start-Sleep 8; Start-Process "http://localhost:3000" } | Out-Null
npm run dev
