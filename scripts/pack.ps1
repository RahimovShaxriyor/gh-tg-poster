# Скрипт сборки чистого zip-архива для деплоя на сервер (PowerShell)
$dest = Join-Path (Split-Path -Parent $PSScriptRoot) "..\gh-tg-web.zip"
$sourceDir = Split-Path -Parent $PSScriptRoot

if (Test-Path $dest) { Remove-Item $dest -Force }

$items = Get-ChildItem -Path $sourceDir -Exclude "node_modules", "data", ".env", "*.zip"
$tempDir = Join-Path $env:TEMP "gh-tg-web-pack"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path "$tempDir\gh-tg-web\data" -Force | Out-Null
New-Item -ItemType File -Path "$tempDir\gh-tg-web\data\.gitkeep" -Force | Out-Null

Copy-Item -Path $items.FullName -Destination "$tempDir\gh-tg-web\" -Recurse -Force

Compress-Archive -Path "$tempDir\gh-tg-web" -DestinationPath $dest -Force
Remove-Item $tempDir -Recurse -Force

Write-Host "Архив успешно создан: $dest (Размер: $((Get-Item $dest).Length) байт)" -ForegroundColor Green
