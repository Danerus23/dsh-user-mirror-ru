#!/usr/bin/env node
/**
 * Проверка русского перевода и функциональных правок dsh-user-mirror.
 *
 * Схема файлов:
 *   index.translation.js — чистый перевод (эталон для сверки с апстримом);
 *   index.js             — рабочий файл: перевод + правки из tools/build-index.mjs;
 *   client.js, cordis.patch.yml — чистый перевод;
 *   upstream/<версия>/   — нетронутые файлы апстрима из npm.
 *
 * Что проверяется:
 *   1. «скелет кода» index.translation.js совпадает с upstream/<версия>/index.js: удалены
 *      комментарии, строки заменены плейсхолдером, пробелы схлопнуты — значит
 *      перевод тронул только тексты;
 *   2. то же для client.js и cordis.patch.yml;
 *   3. index.js побайтово равен applyFixes(index.translation.js) — значит сверх
 *      перевода в нём ровно задокументированные правки и ничего больше;
 *   4. нигде не осталось иероглифов, кодировка как в оригинале, контракты API целы.
 *
 * Запуск:  node tools/verify-structure.mjs
 * Код возврата 0 — всё чисто, 1 — есть расхождения.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFixes, fixes } from './build-index.mjs'

/** Каталог скриптов; корень репозитория — на уровень выше. */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Версия апстрима, с которой сверяется перевод (каталог внутри upstream/). */
const UPSTREAM = '0.6.1'

/** Пары «оригинал → файл, который должен совпасть с ним по скелету». */
const PAIRS = [
  [`upstream/${UPSTREAM}/index.js`, 'index.translation.js'],
  [`upstream/${UPSTREAM}/client.js`, 'client.js'],
  [`upstream/${UPSTREAM}/cordis.patch.yml`, 'cordis.patch.yml'],
]

/**
 * Привести исходник к скелету: убрать комментарии, обезличить строки,
 * схлопнуть пробелы. Различия в переносах строк и отступах игнорируются.
 */
function skeleton(source, isYaml) {
  let out = ''
  let i = 0
  const n = source.length
  const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c)
  let lastSignificant = ''

  if (isYaml) {
    for (const line of source.split('\n')) {
      const cut = line.indexOf('#')
      out += (cut === -1 ? line : line.slice(0, cut)) + '\n'
    }
    return out.replace(/\s+/g, ' ').trim()
  }

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i++; break }
        i++
      }
      out += '"S"'
      lastSignificant = '"'
      continue
    }
    if (c === '/' && !isIdentChar(lastSignificant) && !')]}'.includes(lastSignificant)) {
      // Регулярное выражение (эвристика: перед '/' стоит не значение).
      i++
      let inClass = false
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) { i++; break }
        else if (source[i] === '\n') break
        i++
      }
      while (i < n && /[a-z]/.test(source[i])) i++
      out += '/R/'
      lastSignificant = '/'
      continue
    }
    if (c === '\n') { out += ' '; i++; continue }
    if (!/\s/.test(c)) lastSignificant = c
    out += c
    i++
  }
  return out.replace(/\s+/g, ' ').trim()
}

const cjkCount = (text) => (text.match(/[\u4e00-\u9fff]/g) ?? []).length
const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
const hasCrlf = (buf) => buf.includes(13)

let failed = false

console.log('Чистый перевод против апстрима:')
for (const [originalRel, translatedRel] of PAIRS) {
  const isYaml = originalRel.endsWith('.yml')
  const originalBuf = readFileSync(join(root, originalRel))
  const translatedBuf = readFileSync(join(root, translatedRel))
  const original = originalBuf.toString('utf8')
  const translated = translatedBuf.toString('utf8')

  const sameSkeleton = skeleton(original, isYaml) === skeleton(translated, isYaml)
  const leftCjk = cjkCount(translated)
  const encodingSame = hasBom(originalBuf) === hasBom(translatedBuf) && hasCrlf(originalBuf) === hasCrlf(translatedBuf)
  const linesA = original.split('\n').length
  const linesB = translated.split('\n').length

  if (!sameSkeleton || leftCjk > 0 || !encodingSame) failed = true

  console.log(`${sameSkeleton && leftCjk === 0 && encodingSame ? '  OK  ' : '  FAIL'} ${translatedRel}`)
  console.log(`        скелет кода (без строк и комментариев): ${sameSkeleton ? 'совпадает' : 'ОТЛИЧАЕТСЯ'}`)
  console.log(`        иероглифов: ${leftCjk}, кодировка как в оригинале: ${encodingSame ? 'да' : 'НЕТ'}, строк: ${linesA} -> ${linesB}`)
}

// Рабочий файл == перевод + задокументированные правки.
const translation = readFileSync(join(root, 'index.translation.js'), 'utf8')
const working = readFileSync(join(root, 'index.js'), 'utf8')
let rebuilt = null
let rebuildError = null
try {
  rebuilt = applyFixes(translation).source
} catch (error) {
  rebuildError = error.message
}
const rebuildOk = rebuildError === null && rebuilt === working
if (!rebuildOk) failed = true

console.log('\nРабочий файл против перевода:')
console.log(`${rebuildOk ? '  OK  ' : '  FAIL'} index.js == index.translation.js + правки`)
if (!rebuildOk) {
  console.log(`        ${rebuildError ?? 'содержимое не совпало с результатом сборки'}`)
} else {
  for (const fix of fixes()) console.log(`        + ${fix.id}`)
}
console.log(`        строк: ${translation.split('\n').length} -> ${working.split('\n').length}`)

// Контракты: имена инструментов, слот, маршруты, сервисы.
const client = readFileSync(join(root, 'client.js'), 'utf8')
const CONTRACTS = [
  ['index.js', working, "export const inject = ['storageDomain', 'systemPrompt', 'tools', 'webServer']"],
  ['index.js', working, "'mirror_remember'"],
  ['index.js', working, "'mirror_forget'"],
  ['index.js', working, "'/dsh-mirror/preferences'"],
  ['index.js', working, "'/dsh-mirror/forget"],
  ['index.js', working, "'/dsh-mirror/vendor/ai-orb'"],
  ['index.js', working, 'ctx.webServer.register'],
  ['index.js', working, 'ctx.tools.register'],
  ['index.js', working, 'ctx.systemPrompt.section'],
  ['index.js', working, 'ctx.storageDomain.open'],
  ['client.js', client, "exports.inject = ['slots']"],
  ['client.js', client, "slots.inject('conversation.view'"],
]
console.log('\nКонтракты API:')
for (const [file, text, needle] of CONTRACTS) {
  const ok = text.includes(needle)
  if (!ok) failed = true
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${file}: ${needle}`)
}

console.log(failed ? '\nИТОГ: есть расхождения' : '\nИТОГ: всё чисто')
process.exit(failed ? 1 : 0)
