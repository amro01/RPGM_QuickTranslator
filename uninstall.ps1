$ErrorActionPreference = "SilentlyContinue"
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host "   RPG Maker Translation Uninstaller      " -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Yellow

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
Write-Host "[1/3] Root Directory: $rootDir"

$mvJs = Join-Path $rootDir "www\js\plugins.js"
$mzJs = Join-Path $rootDir "js\plugins.js"
$targetJs = ""
$targetPluginDir = ""

if (Test-Path $mvJs) {
    $targetJs = $mvJs
    $targetPluginDir = Join-Path $rootDir "www\js\plugins"
} elseif (Test-Path $mzJs) {
    $targetJs = $mzJs
    $targetPluginDir = Join-Path $rootDir "js\plugins"
} else {
    Write-Host "[Error] plugins.js not found!" -ForegroundColor Red
    return
}

# 1. 还原 plugins.js
Write-Host "[2/3] Restoring plugins.js..." -ForegroundColor Cyan
$bak = "$targetJs.bak"
if (Test-Path $bak) {
    Copy-Item -Path $bak -Destination $targetJs -Force
    Remove-Item -Path $bak -Force
    Write-Host "      [Success] Restored from backup: plugins.js.bak" -ForegroundColor Green
} else {
    # 逐行过滤：任何带有 QuickTranslator 的行直接剔除，彻底杜绝大括号嵌套Bug
    $rawLines = [System.IO.File]::ReadAllLines($targetJs, [System.Text.Encoding]::UTF8)
    $cleanLines = $rawLines | Where-Object { $_ -notmatch "QuickTranslator" }
    [System.IO.File]::WriteAllLines($targetJs, $cleanLines, [System.Text.Encoding]::UTF8)
    Write-Host "      [Success] Removed QuickTranslator entry from plugins.js" -ForegroundColor Green
}

# 2. 清理注入文件
Write-Host "[3/3] Cleaning up injected translator files..." -ForegroundColor Cyan
$filesToRemove = @(
    (Join-Path $targetPluginDir "QuickTranslator.js"),
    (Join-Path $rootDir "dict.json"),
    (Join-Path $rootDir "www\dict.json"),
    (Join-Path $targetPluginDir "dict.json"),
    (Join-Path $rootDir "missing.json"),
    (Join-Path $rootDir "www\missing.json")
)

foreach ($file in $filesToRemove) {
    if (Test-Path $file) {
        Remove-Item -Path $file -Force
    }
}
Write-Host "      [Success] Injected plugin and dict files removed." -ForegroundColor Green
Write-Host "      (Original translation source was kept safe)" -ForegroundColor Gray

Write-Host "`n>>> Done! Game reverted to pristine Japanese! <<<" -ForegroundColor Yellow