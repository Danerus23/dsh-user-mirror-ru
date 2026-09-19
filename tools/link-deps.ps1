<#
.SYNOPSIS
    Ставит в рабочую папку junction-ы на зависимости профиля.

.DESCRIPTION
    Нужен только для офлайн-тестов: `tools/test-matcher.mjs` импортирует index.js
    из рабочей папки, а тот тянет `@deepseek-ai/*`, `zod` и `ai-orb`, которые лежат
    в node_modules профиля. Junction-ы дают Node ту же единственную копию пакетов,
    что и в бою (это важно: две копии dsh-tools ломают DSH).

    Каталог node_modules в рабочей папке — вспомогательный, в профиль он не копируется.

.EXAMPLE
    pwsh -File .\tools\link-deps.ps1
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileModules = Join-Path $dshHome "profiles\$Profile\node_modules"
$installModules = Join-Path $dshHome 'profiles\node_modules'

if (-not (Test-Path $profileModules)) { throw "Не найден node_modules профиля: $profileModules" }

$modulesDir = Join-Path $root 'node_modules'
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null

# Пакеты области @deepseek-ai лежат в общем fallback-каталоге профилей,
# ai-orb — в node_modules самого профиля.
$targets = @(
    @{ name = '@deepseek-ai'; source = (Join-Path $installModules '@deepseek-ai') },
    @{ name = 'zod';           source = (Join-Path $installModules 'zod') },
    @{ name = 'ai-orb';        source = (Join-Path $profileModules 'ai-orb') }
)

foreach ($target in $targets) {
    $link = Join-Path $modulesDir $target.name
    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -ne 'Junction') {
            Write-Warning "$link уже существует и это не junction — пропускаю"
            continue
        }
        Write-Host "уже есть: $($target.name)"
        continue
    }
    if (-not (Test-Path $target.source)) {
        Write-Warning "нет источника для $($target.name): $($target.source)"
        continue
    }
    New-Item -ItemType Junction -Path $link -Target $target.source | Out-Null
    Write-Host "связан: $($target.name) -> $($target.source)"
}

Write-Host "`nГотово. Проверка: node tools/test-matcher.mjs"
