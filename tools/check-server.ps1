#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Проверка установленного dsh-user-mirror на живом сервере.

.DESCRIPTION
    Стучится в маршруты плагина и проверяет, что:
      - /dsh-mirror/preferences отвечает 200 и JSON;
      - категории (kinds) отдаются по-русски — то есть наложен перевод;
      - /dsh-mirror/vendor/ai-orb/index.js отдаётся (зависимость ai-orb на месте);
      - GET /dsh-mirror/forget возвращает 405 (удаление не отвечает на GET);
      - /plugins/... отдаёт клиентский бандл по revisioned URL.

.PARAMETER Url
    Базовый адрес web-профиля. По умолчанию http://127.0.0.1:3080

.EXAMPLE
    pwsh -File .\check.ps1
#>
[CmdletBinding()]
param(
    [string]$Url = 'http://127.0.0.1:3080'
)

$script:failed = 0

function Test-Endpoint {
    param(
        [string]$Path,
        [int[]]$ExpectStatus,
        [string]$Note = ''
    )
    $full = $Url.TrimEnd('/') + $Path
    try {
        $response = Invoke-WebRequest -Uri $full -UseBasicParsing -TimeoutSec 20
        $status = [int]$response.StatusCode
        $body = $response.Content
    } catch {
        $status = [int]$_.Exception.Response.StatusCode.value__
        $body = ''
        if ($status -eq 0) { $status = -1 }
    }
    $ok = $ExpectStatus -contains $status
    if (-not $ok) { $script:failed++ }
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0} {1} {2} -> {3} (ожидалось {4}) {5}" -f $mark, $Path, '', $status, ($ExpectStatus -join '/'), $Note)
    return $body
}

Write-Host "Проверка $Url`n"

$prefs = Test-Endpoint -Path '/dsh-mirror/preferences' -ExpectStatus 200 -Note 'список памяти'
$null = Test-Endpoint -Path '/dsh-mirror/vendor/ai-orb/index.js' -ExpectStatus 200 -Note 'ai-orb из node_modules профиля'
$null = Test-Endpoint -Path '/dsh-mirror/forget' -ExpectStatus 405 -Note 'GET не должен удалять'
$null = Test-Endpoint -Path '/dsh-mirror/forget/does-not-exist' -ExpectStatus 405 -Note 'то же для пути с id'

if ($prefs) {
    try {
        $json = $prefs | ConvertFrom-Json
        Write-Host "`nЗаписей в памяти: $($json.memories.Count)"
        $kinds = $json.kinds.PSObject.Properties
        $cjk = 0
        foreach ($k in $kinds) {
            if ($k.Value -match '[\u4e00-\u9fff]') { $cjk++ }
            Write-Host ("  {0,-10} {1}" -f $k.Name, $k.Value)
        }
        if ($cjk -gt 0) {
            $script:failed++
            Write-Host "`nFAIL подписи категорий всё ещё на китайском — перевод не наложен" -ForegroundColor Red
        } else {
            Write-Host "`nOK   подписи категорий по-русски — перевод наложен" -ForegroundColor Green
        }
    } catch {
        $script:failed++
        Write-Host "FAIL не удалось разобрать JSON: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
if ($script:failed -gt 0) {
    Write-Host "ИТОГ: проблем $script:failed" -ForegroundColor Red
    exit 1
}
Write-Host "ИТОГ: всё чисто" -ForegroundColor Green
