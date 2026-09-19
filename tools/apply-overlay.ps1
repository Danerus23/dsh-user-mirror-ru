<#
.SYNOPSIS
    Накладывает русскую локализацию поверх npm-версии плагина dsh-user-mirror.

.DESCRIPTION
    Запасной способ (основной — установка форка из git, см. README): копирует
    переведённые index.js / client.js / cordis.patch.yml в каталог уже
    установленного плагина внутри профиля DSH, предварительно сделав резервную
    копию оригиналов рядом со скриптом (backups\<версия>-<метка времени>\).

    package.json при этом не трогается: профиль продолжает зависеть от npm-пакета,
    поэтому `dsh plugin update` работает как обычно — но обновление затрёт накат,
    и скрипт нужно запустить снова. Установка из git этим недостатком не страдает.

.PARAMETER Profile
    Имя профиля DSH. По умолчанию web (единственный профиль, где плагин работает:
    ему нужны сервисы storageDomain и webServer).

.PARAMETER Revert
    Восстановить самую свежую резервную копию вместо наката перевода.

.PARAMETER Force
    Не останавливаться, если базовая версия установленного плагина отличается от
    версии, для которой сделан перевод.

.EXAMPLE
    pwsh -File .\tools\apply-overlay.ps1
    pwsh -File .\tools\apply-overlay.ps1 -Revert
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$Revert,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Скрипт лежит в tools\, а файлы перевода — в корне репозитория.
$root = Split-Path $PSScriptRoot -Parent
$files = @('index.js', 'client.js', 'cordis.patch.yml')

function Get-DshHome {
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Get-BaseVersion {
    # «0.6.1-ru.1» → «0.6.1»: форк нумеруется как <версия апстрима>-ru.<сборка>.
    param([string]$Version)
    return ($Version -split '-')[0]
}

function Assert-EsmSyntax {
    param([string]$Path)
    $check = Join-Path $env:TEMP ("dsh-mirror-check-" + [guid]::NewGuid().ToString('N') + ".mjs")
    try {
        Copy-Item $Path $check -Force
        $out = & node --check $check 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Синтаксис $([IO.Path]::GetFileName($Path)) не проходит node --check:`n$out" }
    } finally {
        Remove-Item $check -Force -ErrorAction SilentlyContinue
    }
}

$dshHome = Get-DshHome
$target = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-user-mirror"

if (-not (Test-Path $target)) {
    throw @"
Плагин не найден: $target
Этот способ работает только со старым пакетом апстрима (dsh-user-mirror) — нашим тёзкой.
Сначала установите его: dsh plugin --profile $Profile add dsh-user-mirror
Если у вас новый пакет апстрима (@dsh-plugins/dsh-user-mirror), способ не подходит —
ставьте форк из git: dsh plugin --profile $Profile add github:Danerus23/dsh-user-mirror-ru
"@
}

$backupRoot = Join-Path $root 'backups'

if ($Revert) {
    $latest = Get-ChildItem $backupRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { throw "Резервных копий нет: $backupRoot" }
    foreach ($f in $files) {
        $src = Join-Path $latest.FullName $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $target $f) -Force; Write-Host "восстановлен $f" }
    }
    Write-Host "`nГотово: откат к $($latest.Name). Перезапустите профиль $Profile и обновите страницу (Ctrl+Shift+R)."
    return
}

$installedVersion = (Get-Content (Join-Path $target 'package.json') -Raw | ConvertFrom-Json).version
$ourVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$installedBase = Get-BaseVersion $installedVersion
$ourBase = Get-BaseVersion $ourVersion

if ($installedBase -ne $ourBase -and -not $Force) {
    throw @"
Установлен апстрим $installedVersion, а перевод сделан для $ourBase (наш пакет $ourVersion).
Сначала перенесите перевод на новую версию апстрима (см. README, раздел «Обновление апстрима»),
либо запустите с -Force, если готовы наложить как есть.
"@
}

# Рабочий index.js всегда собирается из перевода правками, чтобы артефакт не разъехался.
Write-Host "Сборка index.js из перевода + правок..."
& node (Join-Path $root 'tools\build-index.mjs') (Join-Path $root 'index.translation.js') (Join-Path $root 'index.js')
if ($LASTEXITCODE -ne 0) { throw "Сборка index.js не удалась (см. вывод выше)" }

foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) { throw "Нет файла перевода: $src" }
    if ($f -ne 'cordis.patch.yml') { Assert-EsmSyntax -Path $src }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot "$installedVersion-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($f in $files) { Copy-Item (Join-Path $target $f) (Join-Path $backupDir $f) -Force }

foreach ($f in $files) { Copy-Item (Join-Path $root $f) (Join-Path $target $f) -Force }

Write-Host "Поведенческие тесты на установленной копии..."
& node (Join-Path $root 'tools\test-matcher.mjs') (Join-Path $target 'index.js')
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Тесты не прошли — возвращаю резервную копию"
    foreach ($f in $files) { Copy-Item (Join-Path $backupDir $f) (Join-Path $target $f) -Force }
    throw "Наложение отменено: тесты поведения не прошли"
}

Write-Host "Наложены русский перевод и правки на $target"
Write-Host "Резервная копия оригиналов: $backupDir"
Write-Host "`nДальше:"
Write-Host "  1) перезапустите профиль $Profile (плагин читается на старте);"
Write-Host "  2) обновите страницу с Ctrl+Shift+R."
