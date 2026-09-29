# Deploy script: builds the app and uploads dist/ to pnatech.com.my/supply.chain via FTP
# Usage: powershell -File deploy.ps1
# Requires: nothing extra (uses built-in curl.exe), Node.js for the build

$ErrorActionPreference = "Stop"

$host_ = "pnatech.com.my"
$user = "it@pnatech.com.my"
$pass = "pna626064p"
$remotePath = "/supply.chain"
$dist = Join-Path $PSScriptRoot "dist"

# 1. Build
Write-Host "==> Building..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }

# 2. Ensure remote dir exists
Write-Host "==> Ensuring remote directory $remotePath ..." -ForegroundColor Cyan
curl.exe -sS --ftp-create-dirs "ftp://$host_$remotePath/" -u "${user}:${pass}" --connect-timeout 20 | Out-Null

# 3. Upload all files from dist (index.html at root, assets/ recursively)
Write-Host "==> Uploading files..." -ForegroundColor Cyan
$files = Get-ChildItem -Recurse -File $dist
foreach ($f in $files) {
    $rel = $f.FullName.Substring($dist.Length).Replace("\", "/")
    $url = "ftp://$host_$remotePath$rel"
    Write-Host "  $rel"
    curl.exe -sS -T "$($f.FullName)" "$url" -u "${user}:${pass}" --connect-timeout 30
    if ($LASTEXITCODE -ne 0) { Write-Error "Upload failed: $rel"; exit 1 }
}

Write-Host ""
Write-Host "Deployed $($files.Count) files -> https://pnatech.com.my$remotePath/" -ForegroundColor Green
