#!/usr/bin/env node
/**
 * Поведенческие тесты сопоставителя тем dsh-user-mirror (хост-половина).
 *
 * Проверяют ровно то, ради чего делались правки: русские записи должны склеиваться
 * по теме, но не склеиваться по общим служебным словам. Плюс статически проверяется,
 * что `table.delete()` теперь awaited.
 *
 * Запуск:
 *   node tools/test-matcher.mjs                 # против ../index.js (рабочий файл)
 *   node tools/test-matcher.mjs <путь к index.js>
 *
 * Чтобы импортировать файл из рабочей папки, рядом нужен node_modules с зависимостями
 * профиля (см. tools/link-deps.ps1) — либо запускайте против копии, установленной
 * в профиль, там резолв работает сам.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const targetPath = resolve(process.argv[2] ?? resolve(here, '..', 'index.js'))
const translationPath = resolve(here, '..', 'index.translation.js')

const now = Date.now()
/** Таблица-заглушка в форме, которую ждёт findSimilar. */
const fakeTable = (text, kind = 'principle') => ({
  entries: () => [['pref-test', { id: 'pref-test', text, kind, hits: 1, lastSeenAt: now, updatedAt: now }]],
})

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

const mod = await import(pathToFileURL(targetPath).href)
console.log(`тестируем: ${targetPath}\n`)

// ── normalize ────────────────────────────────────────────────────────────────
const normalized = mod.normalize('Пользователь предпочитает краткость')
check('normalize() срезает ведущее «пользователь»', !normalized.includes('пользовател'), normalized)

// ── сущности ─────────────────────────────────────────────────────────────────
const entities = mod.extractEntities('для отчётов использовать формат pdf')
check('кириллица попадает в сущности', entities.has('отчётов') && entities.has('формат'), [...entities].join(','))
check('русские стоп-слова исключены', !entities.has('для') && !entities.has('использовать'), [...entities].join(','))
check('латиница и цифры по-прежнему работают', mod.extractEntities('картинки в R2 и picx').has('r2'), 'r2')

// ── основы ───────────────────────────────────────────────────────────────────
if (typeof mod.extractStems === 'function') {
  const a = mod.extractStems('ответы по-русски')
  const b = mod.extractStems('ответы на русском')
  const shared = [...a].filter((x) => b.has(x))
  check('основы сходятся у «русски»/«русском»', shared.length > 0, `a=${[...a]} b=${[...b]}`)

  // Регрессия на живой баг: срезание окончаний по списку давало разные основы для
  // одного корня («русски» → русс по «ки», «русские» → русск по «ие»), и тема
  // не опознавалась, хотя должна была.
  const forms = ['русски', 'русские', 'русском', 'русского']
  const keys = forms.map((w) => [...mod.extractStems(w)])
  const consistent = keys.every((k) => k.length > 0 && k[0] === keys[0][0])
  check('одна основа у «русски»/«русские»/«русском»/«русского»', consistent, keys.map((k) => k.join('+')).join(' | '))

  const c = mod.extractStems('картинки в хранилище')
  const d = mod.extractStems('картинок в хранилище')
  check('основы сходятся у «картинки»/«картинок»', [...c].some((x) => d.has(x)), `c=${[...c]} d=${[...d]}`)

  const e = mod.extractStems('предпочитать краткость')
  const f = mod.extractStems('предлагать краткость')
  check('«предпочитать»/«предлагать» НЕ склеиваются', ![...e].some((x) => f.has(x) && x !== 'кратк'), `e=${[...e]} f=${[...f]}`)
} else {
  check('extractStems() присутствует', false, 'правки не применены')
}

// ── findSimilar ──────────────────────────────────────────────────────────────
check(
  'дубль по сущностям склеивается (r2 + picx)',
  mod.findSimilar(fakeTable('картинки всегда хранить в R2, в picx не добавлять'), 'картинки храним в R2, picx новых не принимает') !== null,
)
check(
  'разные темы НЕ склеиваются через общие служебные слова',
  mod.findSimilar(fakeTable('для отчётов использовать формат pdf'), 'для графиков использовать формат svg') === null,
  'склеилось — проверьте русские стоп-слова',
)
check(
  'перефразировка по основам склеивается',
  mod.findSimilar(fakeTable('русские ответы, английские термины оставлять'), 'отвечать по-русски, термины на английском не переводить') !== null,
)
// Тот самый случай, который не склеился в бою (разные окончания одного корня).
check(
  'регрессия: живая пара «【проверка】отвечать по-русски…» ↔ «русские ответы…»',
  mod.findSimilar(fakeTable('【проверка】отвечать по-русски, технические термины оставлять как есть'), 'русские ответы, английские термины не переводить') !== null,
)
check(
  'разные темы по основам НЕ склеиваются',
  mod.findSimilar(fakeTable('документацию писать по-русски'), 'коммиты делать маленькими') === null,
)
check(
  'дословный повтор склеивается',
  mod.findSimilar(fakeTable('пиши кратко и по делу'), 'Пиши кратко и по делу!') !== null,
)

// ── статика: все мутации таблицы awaited ─────────────────────────────────────
const source = readFileSync(targetPath, 'utf8')
check('remember() асинхронная', source.includes('const remember = async ({ text, kind, reason }) => {'))
check('ждёт запись новой памяти', source.includes('await table.put(id, {'))
check('ждёт перезапись по той же теме', source.includes('await table.put(key, {'))
check('ждёт вытеснение по пределу ёмкости', source.includes('await table.delete(weakest[0])'))
check('инструмент ждёт remember()', source.includes('const outcome = await remember('))
check('mirror_forget ждёт table.delete', source.includes('await table.delete(key)'))
check('HTTP /forget ждёт table.delete', source.includes('await table.delete(hit[0])'))

// ── до/после: на чистом переводе перефразировка не находилась ────────────────
try {
  const before = await import(pathToFileURL(translationPath).href)
  const wasFound = before.findSimilar(fakeTable('русские ответы, английские термины оставлять'), 'отвечать по-русски, термины на английском не переводить') !== null
  console.log(`\nсправочно: на чистом переводе эта перефразировка находилась: ${wasFound ? 'да' : 'нет'}`)
} catch {
  console.log('\nсправочно: index.translation.js не импортировался — сравнение до/после пропущено')
}

console.log(failed === 0 ? '\nИТОГ: все проверки пройдены' : `\nИТОГ: провалено ${failed}`)
process.exit(failed === 0 ? 0 : 1)
