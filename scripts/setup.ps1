# Blueprint setup — Windows PowerShell wrapper.
# Delegates to the cross-platform scripts/setup.js so the logic stays in one place.
#
# Usage (PowerShell):
#   .\scripts\setup.ps1

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════╗"
Write-Host "  ║       Blueprint Setup (Windows)  ║"
Write-Host "  ╚══════════════════════════════════╝"
Write-Host ""

if (-not (Test-Command "bun")) {
    Write-Host "Bun not found. Installing..."
    powershell -c "irm bun.sh/install.ps1 | iex"
    Write-Host ""
    Write-Host "Bun installed. Please close this PowerShell window, open a new one," -ForegroundColor Yellow
    Write-Host "and re-run .\scripts\setup.ps1" -ForegroundColor Yellow
    exit 0
}

# Hand off to the cross-platform setup script
bun scripts/setup.js
