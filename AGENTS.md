# AGENTS.md — установка и сопровождение dsh-user-mirror (русская редакция)

Инструкция для ИИ-агента, который ставит этот плагин в DSH, проверяет его или откатывает.
Человеческая инструкция — [README.md](README.md).

## Коротко

```powershell
dsh plugin --profile web add github:Danerus23/dsh-user-mirror-ru
# затем перезапустить профиль web и обновить страницу в браузере с Ctrl+Shift+R
```

## Перед установкой — проверить

| Что | Как проверить | Что должно быть |
|---|---|---|
| Профиль | `dsh plugin --profile web why dsh-user-mirror` | ошибка «not found» — нормально, если плагина нет; главное, что профиль `web` существует (**только web**: нужны сервисы `storageDomain` и `webServer`) |
| pnpm | `pnpm --version` | есть в PATH — `dsh plugin` без него отвечает `pnpm not found on PATH` |
| git | `git --version` | есть, если ставите из git |
| Нет второй копии | `${env:USERPROFILE}\.dsh\profiles\web\node_modules\dsh-user-mirror` | либо пусто, либо это и есть форк. Двух копий (npm + git) быть не должно: они регистрируют одни маршруты и инструменты |

Установка идёт в профиль `web`, поэтому **не запускайте её на живом сервере, который держит
текущую сессию**, если можете этого избежать: проверять удобнее на отдельном `DSH_HOME` и
свободном порту (3081–3099), например:

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-verify"
dsh plugin --profile web add github:Danerus23/dsh-user-mirror-ru
dsh web --port 3097            # отдельный сервер; в браузере http://127.0.0.1:3097
```

## Что считается успехом

1. `dsh plugin --profile web add ...` завершился кодом 0, в выводе pnpm — установка
   `dsh-user-mirror`, а в `~/.dsh/profiles/web/package.json` появилась запись
   `"dsh-user-mirror": "github:Danerus23/dsh-user-mirror-ru"` и имя в `dsh.profile.bundles`.
2. Профиль поднимается без `pending (waiting for services: storageDomain, webServer)`.
3. Живой сервер отдаёт русские подписи категорий:

```powershell
pwsh -File .\tools\check-server.ps1 -Url http://127.0.0.1:3080
# ожидаемо: preferences -> 200, vendor/ai-orb -> 200, GET /forget -> 405,
#           подписи категорий по-русски, «ИТОГ: всё чисто»
```

Маршруты плагина отвечают без авторизации, так что проверка не требует токена сессии.
Если скрипта под рукой нет, достаточно одного запроса:

```powershell
(Invoke-WebRequest http://127.0.0.1:3080/dsh-mirror/preferences -UseBasicParsing).Content
# в kinds должны быть «принцип/компромисс…», а не «原则/取舍…»
```

## Грабли

| Симптом | Причина и что делать |
|---|---|
| Подписи во вкладке «Память» китайские, хотя установка прошла | Порядок проверки: (1) страница из кеша — `Ctrl+Shift+R`; (2) профиль не перезапускался — плагин читается **на старте**; (3) в `node_modules\dsh-user-mirror\client.js` действительно лежит перевод (искать `предпочтения, выученные из цепочки`) |
| Загрузка падает с `pending (waiting for services: storageDomain, webServer)` | Плагин поставлен не в `web`-профиль. Убрать из headless-профиля |
| Вкладки «Память» нет, ошибок нет | Проверьте, что имя пакета есть в `dsh.profile.bundles`. Его дописывает `dsh plugin` при установке; после ручной правки `package.json` — не допишется |
| `dsh plugin add` печатает про `allowBuilds` в `pnpm-workspace.yaml` | Так pnpm блокирует build-скрипты git-зависимостей. У этого пакета **нет** `prepare`/build-скриптов, поэтому сообщение означает, что упало что-то другое: читайте вывод pnpm выше |
| Все инструменты DSH ломаются с `Cannot read properties of undefined (reading 'prepare')` | В профиле оказалась вторая копия `@deepseek-ai/dsh-tools`. Удалить лишнюю (`profiles\web\node_modules\@deepseek-ai`), при необходимости заменить симлинками на копию из `profiles\node_modules\@deepseek-ai` |
| `tools/apply-overlay.ps1` отказывается работать | Базовая версия установленного апстрима не совпадает с версией перевода. Сначала перенести перевод (см. README, «Обновление апстрима») либо запустить с `-Force` |

## Откат

```powershell
dsh plugin --profile web remove dsh-user-mirror   # плагина нет
dsh plugin --profile web add dsh-user-mirror      # вернуться к апстриму из npm
```

Если правили файлы вручную (накат поверх npm-пакета), откат делает сам скрипт:

```powershell
pwsh -File .\tools\apply-overlay.ps1 -Revert
```

Записи памяти лежат в хранилище DSH (домен `dsh_mirror`), не в пакете, — установка и удаление
плагина их не трогают.

## Проверки в самом репозитории (после правок перевода или апстрима)

```powershell
node tools/verify-structure.mjs     # перевод == апстрим по скелету кода; index.js == перевод + правки
node tools/test-matcher.mjs         # 22 поведенческие проверки сопоставителя тем
```

Для запуска тестов из клона нужны зависимости профиля:

```powershell
pwsh -File .\tools\link-deps.ps1    # junction-ы на @deepseek-ai/*, zod, ai-orb
```

Тесты импортируют `index.js`, поэтому junction-ы должны указывать на **те же** копии пакетов,
что использует DSH: две копии `dsh-tools` ломают инструментальный слой целиком.

## Обновление при выходе новой версии апстрима

1. `dsh plugin --profile web add dsh-user-mirror` на отдельном профиле — получить новые файлы
   из npm; сравнить с `upstream/0.6.1/`.
2. Перенести тексты в `index.translation.js` (и `client.js`, если менялись тексты клиента).
3. Проверить якоря правок: `node tools/build-index.mjs index.translation.js index.js` —
   при отсутствии якоря сборка падает с именем правки.
4. Положить новые файлы апстрима в `upstream/<новая версия>/`, поднять `version` в
   `package.json` до `<версия апстрима>-ru.<сборка>`, дополнить `CHANGELOG.md`.
5. Прогнать обе проверки, затем установить форк на отдельный `DSH_HOME` и убедиться живьём,
   что подписи категорий русские.
