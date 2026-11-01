param(
    [string]$JsonPath = ""
)

$ErrorActionPreference = "Stop"
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   RPG Maker Translation Installer (PS)   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
Write-Host "[1/5] Root Directory: $rootDir"

$pluginFile = Join-Path $rootDir "QuickTranslator.js"
if (-not (Test-Path $pluginFile)) {
    Write-Host "[Error] QuickTranslator.js not found in game root!" -ForegroundColor Red
    return
}
Write-Host "[2/5] Plugin ready: QuickTranslator.js" -ForegroundColor Green

$mvJs = Join-Path $rootDir "www\js\plugins.js"
$mzJs = Join-Path $rootDir "js\plugins.js"
$targetJs = ""
$targetPluginDir = ""

if (Test-Path $mvJs) {
    $targetJs = $mvJs
    $targetPluginDir = Join-Path $rootDir "www\js\plugins"
    Write-Host "[3/5] Engine Detected: RPG Maker MV" -ForegroundColor Green
} elseif (Test-Path $mzJs) {
    $targetJs = $mzJs
    $targetPluginDir = Join-Path $rootDir "js\plugins"
    Write-Host "[3/5] Engine Detected: RPG Maker MZ" -ForegroundColor Green
} else {
    Write-Host "[Error] plugins.js not found!" -ForegroundColor Red
    return
}

$finalJson = ""
if ($JsonPath -and (Test-Path $JsonPath)) {
    $finalJson = (Resolve-Path $JsonPath).Path
} else {
    $candidates = Get-ChildItem -Path $rootDir -Filter "*.json" | Where-Object {
        $_.Name -notin @("package.json", "missing.json", "dict.json")
    }
    if ($candidates.Count -gt 0) {
        $finalJson = $candidates[0].FullName
    }
}

if (-not $finalJson -or -not (Test-Path $finalJson)) {
    Write-Host "[Error] Translation JSON file not found!" -ForegroundColor Red
    return
}
Write-Host "[4/5] Selected Dictionary: $finalJson" -ForegroundColor Green

# 部署文件
Copy-Item -Path $pluginFile -Destination (Join-Path $targetPluginDir "QuickTranslator.js") -Force
Copy-Item -Path $finalJson -Destination (Join-Path $rootDir "dict.json") -Force
if (Test-Path (Join-Path $rootDir "www")) {
    Copy-Item -Path $finalJson -Destination (Join-Path $rootDir "www\dict.json") -Force
}
Copy-Item -Path $finalJson -Destination (Join-Path $targetPluginDir "dict.json") -Force
Write-Host "[5/5] Files successfully deployed!" -ForegroundColor Green

# 精准手术刀式写入 plugins.js (按行定位，绝不误伤)
$lines = [System.Collections.Generic.List[string]]([System.IO.File]::ReadAllLines($targetJs, [System.Text.Encoding]::UTF8))
$alreadyExists = $false
foreach ($line in $lines) {
    if ($line -match "QuickTranslator") { $alreadyExists = $true; break }
}

if (-not $alreadyExists) {
    $bak = "$targetJs.bak"
    if (-not (Test-Path $bak)) {
        Copy-Item -Path $targetJs -Destination $bak -Force
        Write-Host "      Created backup: plugins.js.bak" -ForegroundColor Gray
    }
    
    # 找到 '[' 所在的那一行索引
    $insertIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "\[") {
            $insertIndex = $i + 1
            break
        }
    }

    if ($insertIndex -ne -1) {
        $q = [char]34
        $entryLine = "{" + $q + "name" + $q + ":" + $q + "QuickTranslator" + $q + "," + $q + "status" + $q + ":true," + $q + "description" + $q + ":" + $q + "QuickTranslator" + $q + "," + $q + "parameters" + $q + ":{}},"
        $lines.Insert($insertIndex, $entryLine)
        [System.IO.File]::WriteAllLines($targetJs, $lines, [System.Text.Encoding]::UTF8)
        Write-Host "      [Success] Safely injected into line $insertIndex of plugins.js!" -ForegroundColor Green
    } else {
        Write-Host "      [Error] Could not find array bracket in plugins.js!" -ForegroundColor Red
    }
} else {
    Write-Host "      [Notice] QuickTranslator already present in plugins.js." -ForegroundColor Yellow
}

Write-Host "`n>>> Done! Launch Game.exe to play! <<<" -ForegroundColor Cyan