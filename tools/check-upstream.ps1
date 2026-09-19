<#
.SYNOPSIS
    Проверяет, не вышла ли новая версия апстрима dsh-user-mirror, и что в ней изменилось.

.DESCRIPTION
    Смотрит два имени в npm — старое dsh-user-mirror (на нём стоит наш перевод) и новое
    @dsh-plugins/dsh-user-mirror, куда апстрим переехал, — а если в PATH есть gh CLI,
    дополнительно читает версию прямо из репозитория апстрима: там бывает версия, ещё не
    выложенная в npm.

    Затем скачивает новейшую ОПУБЛИКОВАННУЮ версию, сравнивает её файлы с нашей базой
    upstream\<версия>\ и печатает, что именно изменилось и сколько иероглифов в client.js —
    то есть сколько текста переводить при переезде.

    Коды возврата: 0 — новее ничего нет; 1 — апстрим новее; 2 — не удалось проверить.

.PARAMETER Base
    Версия апстрима, на которой стоит наш перевод. По умолчанию — старший каталог в upstream\.

.EXAMPLE
    pwsh -File .\tools\check-upstream.ps1
#>
[CmdletBinding()]
param(
    [string]$Base = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$upstreamRoot = Join-Path $root 'upstream'
$files = @('index.js', 'client.js', 'cordis.patch.yml', 'package.json')

function Get-NpmVersion {
    param([string]$Package)
    $raw = & npm view $Package version 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $value = (($raw | Out-String).Trim())
    if ($value.Length -eq 0 -or $value -like '*ERR*') { return $null }
    return $value
}

function Get-RepoVersion {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\bin\gh.exe'
        if (Test-Path $candidate) { $gh = @{ Source = $candidate } } else { return $null }
    }
    $raw = & $gh.Source api "repos/webkubor/dsh-mirror/contents/package.json" --jq '.content' 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((($raw | Out-String) -replace '\s', '')))
        return ($json | ConvertFrom-Json).version
    } catch {
        return $null
    }
}

function Compare-Version {
    param([string]$Left, [string]$Right)
    # «0.7.0» > «0.6.3»; нечисловые суффиксы отбрасываем.
    $clean = { param($v) ($v -replace '[^0-9.].*$', '') }
    try {
        return ([version](& $clean $Left)) -gt ([version](& $clean $Right))
    } catch {
        return $false
    }
}

# ── наша база ───────────────────────────────────────────────────────────────
if (-not $Base) {
    $Base = (Get-ChildItem $upstreamRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
}
$baseDir = Join-Path $upstreamRoot $Base
if (-not (Test-Path $baseDir)) { throw ('нет каталога базы: ' + $baseDir) }
Write-Host ('Наша база: апстрим ' + $Base + ' (' + $baseDir + ')') -ForegroundColor White

# ── что есть у апстрима ─────────────────────────────────────────────────────
$oldName = 'dsh-user-mirror'
$newName = '@dsh-plugins/dsh-user-mirror'
$oldVersion = Get-NpmVersion -Package $oldName
$newVersion = Get-NpmVersion -Package $newName
$repoVersion = Get-RepoVersion

Write-Host ''
Write-Host 'Опубликовано в npm:'
if ($oldVersion) { Write-Host ('  ' + $oldName + ' ' + $oldVersion + '  (старое имя, на нём стоит наш перевод)') } else { Write-Host ('  ' + $oldName + ' — нет данных') }
if ($newVersion) { Write-Host ('  ' + $newName + ' ' + $newVersion + '  (новое имя, куда переехал апстрим)') } else { Write-Host ('  ' + $newName + ' — нет данных') }
if ($repoVersion) { Write-Host ('В репозитории апстрима: ' + $repoVersion + '  (может быть ещё не выложена в npm)') }

$latest = $oldVersion
$latestName = $oldName
if ($newVersion -and (-not $latest -or (Compare-Version -Left $newVersion -Right $latest))) { $latest = $newVersion; $latestName = $newName }

$newerInNpm = $false
if ($latest -and (Compare-Version -Left $latest -Right $Base)) { $newerInNpm = $true }
$newerInRepo = $false
if ($repoVersion -and (Compare-Version -Left $repoVersion -Right $Base)) { $newerInRepo = $true }

Write-Host ''
if (-not $newerInNpm -and -not $newerInRepo) {
    Write-Host ('ИТОГ: новее ' + $Base + ' ничего нет — переезжать не на что.') -ForegroundColor Green
    exit 0
}

# ── что именно изменилось ───────────────────────────────────────────────────
if ($newerInNpm) {
    Write-Host ('Новое в npm: ' + $latestName + ' ' + $latest) -ForegroundColor Yellow
    $tmp = Join-Path $env:TEMP ('check-upstream-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        Push-Location $tmp
        & npm pack ($latestName + '@' + $latest) --silent 2>&1 | Out-Null
        $tgz = Get-ChildItem $tmp -Filter *.tgz | Select-Object -First 1
        if (-not $tgz) { throw 'npm pack не вернул архив' }
        & tar -xzf $tgz.FullName -C $tmp 2>&1 | Out-Null
        $src = Join-Path $tmp 'package'
        Pop-Location

        Write-Host ''
        Write-Host ('Сравнение с нашей базой ' + $Base + ':')
        $changed = @()
        foreach ($file in $files) {
            $newPath = Join-Path $src $file
            $oldPath = Join-Path $baseDir $file
            if (-not (Test-Path $newPath)) { Write-Host ('  ' + $file + ': в новой версии нет'); $changed += $file; continue }
            $same = (Get-FileHash $newPath).Hash -eq (Get-FileHash $oldPath).Hash
            $sizeNew = (Get-Item $newPath).Length
            $sizeOld = (Get-Item $oldPath).Length
            if ($same) {
                Write-Host ('  ' + $file.PadRight(20) + ' не изменился (' + $sizeNew + ' б)') -ForegroundColor Green
            } else {
                Write-Host ('  ' + $file.PadRight(20) + ' ИЗМЕНИЛСЯ: ' + $sizeOld + ' -> ' + $sizeNew + ' б') -ForegroundColor Yellow
                $changed += $file
            }
        }

        $clientPath = Join-Path $src 'client.js'
        $oldClientPath = Join-Path $baseDir 'client.js'
        if ((Test-Path $clientPath) -and (Test-Path $oldClientPath)) {
            $newClient = Get-Content $clientPath
            $oldClient = Get-Content $oldClientPath
            $diff = Compare-Object -ReferenceObject $oldClient -DifferenceObject $newClient
            $added = @($diff | Where-Object { $_.SideIndicator -eq '=>' } | ForEach-Object { $_.InputObject })
            $removed = @($diff | Where-Object { $_.SideIndicator -eq '<=' } | ForEach-Object { $_.InputObject })
            $addedCjk = 0
            foreach ($line in $added) { $addedCjk += ([regex]::Matches($line, '[\u4e00-\u9fff]')).Count }
            $totalCjk = ([regex]::Matches((Get-Content $clientPath -Raw), '[\u4e00-\u9fff]')).Count
            Write-Host ''
            Write-Host ('client.js: добавлено строк ' + $added.Count + ', убрано ' + $removed.Count + ', иероглифов в новых строках ' + $addedCjk + ' — вот столько текста и переводить') -ForegroundColor White
            Write-Host ('         (для сравнения: во всём client.js иероглифов ' + $totalCjk + ')')
        }
        $patchPath = Join-Path $src 'cordis.patch.yml'
        if (Test-Path $patchPath) {
            $nameLine = (Get-Content $patchPath | Select-String -Pattern 'name:' | Select-Object -First 1).Line
            if ($nameLine) { Write-Host ('cordis.patch.yml подключает пакет:' + $nameLine) }
        }
        $manifest = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
        Write-Host ('package.json: name=' + $manifest.name + ' version=' + $manifest.version)
        Write-Host ''
        Write-Host ('ИТОГ: переезд — это ' + ($changed -join ', ') + '.') -ForegroundColor Yellow
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host ('В npm новее ' + $Base + ' ничего нет — переезжать не на что.') -ForegroundColor Green
}

if ($newerInRepo) {
    Write-Host ''
    Write-Host ('В репозитории апстрима уже ' + $repoVersion + ', но в npm она ещё не выложена.') -ForegroundColor Yellow
    Write-Host 'В профиль ставить нечего: ждём публикации в npm (решение от 19.09.2026).' -ForegroundColor Yellow
}

exit 1
