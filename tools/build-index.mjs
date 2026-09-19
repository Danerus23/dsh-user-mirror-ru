#!/usr/bin/env node
/**
 * Функциональные правки поверх русского перевода dsh-user-mirror.
 *
 * Зачем отдельный скрипт, а не просто отредактированный index.js: чистый перевод
 * остаётся в index.translation.js и сверяется с апстримом по скелету кода
 * (tools/verify-structure.mjs), а рабочий index.js собирается из него этим скриптом.
 * Так видно, что именно добавлено сверх перевода, и та же сборка повторяется
 * после обновления апстрима.
 *
 * Правки:
 *   1. Все мутации таблицы памяти ждут своего завершения. В апстриме `table.put`
 *      и `table.delete` не awaited, а `table.size` читается сразу: отсюда врал счётчик
 *      «всего/осталось записей», вытеснение по пределу ёмкости не срабатывало на только
 *      что добавленной записи, и запись на диск не дожидалась ответа. Исправлено в
 *      `mirror_remember` (сделана async), `mirror_forget` и HTTP-обработчике `/forget`.
 *   2. Канал сопоставления тем для русского текста: апстрим ищет только `[a-z0-9]`,
 *      поэтому у русских записей не работал ни один канал, кроме дословного
 *      совпадения. Добавлены кириллица в сущности, русские стоп-слова, срезание
 *      ведущего «пользователь» и канал по русским основам — по первым 5 символам
 *      слова («русски» / «русские» / «русском», «картинки» / «картинок»).
 *
 * Использование:
 *   node tools/build-index.mjs index.translation.js index.js   # собрать рабочий файл
 *   node tools/build-index.mjs --check index.js index.translation.js
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Русские служебные слова и частые глаголы: тему не различают, а ложные совпадения дают. */
export const RU_STOP = [
  // предлоги
  'в', 'во', 'на', 'за', 'из', 'от', 'до', 'по', 'под', 'над', 'при', 'про', 'для', 'без',
  'к', 'ко', 'с', 'со', 'о', 'об', 'обо', 'у', 'около', 'между', 'через', 'после', 'перед',
  'вместо', 'кроме', 'ради', 'среди', 'сквозь', 'внутри', 'вне',
  // союзы и частицы
  'и', 'а', 'но', 'да', 'или', 'либо', 'же', 'ли', 'бы', 'не', 'ни', 'то', 'как', 'что',
  'чтобы', 'если', 'когда', 'чем', 'так', 'тоже', 'также', 'только', 'ещё', 'уже', 'вот',
  'ведь', 'даже', 'лишь', 'разве', 'нет', 'ну',
  // местоимения и определители
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'мне', 'меня', 'тебя', 'его', 'её',
  'их', 'нас', 'вас', 'это', 'этот', 'эта', 'эти', 'тот', 'та', 'те', 'такой', 'такая',
  'такие', 'свой', 'своя', 'свои', 'мой', 'моя', 'мои', 'наш', 'наша', 'наши', 'ваш',
  'ваша', 'ваши', 'себя', 'весь', 'вся', 'всё', 'все', 'сам', 'сама', 'само', 'сами',
  // частые глаголы, предикативы и наречия
  'быть', 'есть', 'был', 'была', 'было', 'были', 'будет', 'будут', 'буду', 'иметь',
  'имеет', 'можно', 'нельзя', 'нужно', 'надо', 'должен', 'должна', 'должны', 'хочу',
  'хочет', 'хотим', 'хотите', 'хотят', 'предпочитаю', 'предпочитает', 'предпочитать',
  'люблю', 'любит', 'нравится', 'использую', 'использует', 'использовать', 'используй',
  'делаю', 'делает', 'делать', 'делай', 'пишу', 'пишет', 'писать', 'пиши', 'говорю',
  'говорит', 'говорить', 'говори', 'отвечаю', 'отвечает', 'отвечать', 'отвечай',
  'работаю', 'работает', 'работать', 'работай', 'всегда', 'никогда', 'часто', 'редко',
  'обычно', 'просто', 'лучше', 'больше', 'меньше', 'очень', 'совсем', 'более', 'менее',
  'теперь', 'потом', 'сначала', 'затем', 'снова', 'опять', 'пожалуйста', 'пользователь',
]

const join = (...parts) => parts.join('\n')

/**
 * Описание правок: каждая ищет ровно один якорь в переводе и заменяет его.
 * @returns список правок в порядке применения.
 */
export function fixes() {
  return [
    {
      id: 'normalize(): срезать ведущее «пользователь»',
      find: join(
        '  return text',
        "    .replace(/^\\u7528\\u6237/, '')",
      ),
      replace: join(
        '  return text',
        "    .replace(/^\\u7528\\u6237/, '')",
        "    .replace(/^\\s*пользовател\\w*\\s*/i, '')",
      ),
    },
    {
      id: 'STOP: русские служебные слова и частые глаголы',
      find: join(
        "  'was', 'were', 'not', 'no', 'yes', 'use', 'using', 'prefer', 'prefers', 'like', 'likes',",
        '])',
      ),
      replace: join(
        "  'was', 'were', 'not', 'no', 'yes', 'use', 'using', 'prefer', 'prefers', 'like', 'likes',",
        '  // Русские служебные слова и частые глаголы: без них канал слов склеивал бы',
        '  // разные записи по общим «для», «что», «использовать».',
        ...RU_STOP.map((word) => `  '${word}',`),
        '])',
      ),
    },
    {
      id: 'extractEntities(): кириллица + срезание «пользователь»',
      find: join(
        "  const t = text.replace(/^\\u7528\\u6237/, '').toLowerCase()",
        '  const out = new Set()',
        '  for (const w of t.match(/[a-z0-9]+/g) || []) {',
      ),
      replace: join(
        "  const t = text.replace(/^\\u7528\\u6237/, '').replace(/^\\s*пользовател\\w*\\s*/i, '').toLowerCase()",
        '  const out = new Set()',
        '  for (const w of t.match(/[a-z0-9\\u0430-\\u044f\\u0451]+/g) || []) {',
      ),
    },
    {
      id: 'extractStems(): новый канал по русским основам',
      find: join(
        '      if (!STOP.has(bg)) out.add(bg)',
        '    }',
        '  }',
        '  return out',
        '}',
      ),
      replace: join(
        '      if (!STOP.has(bg)) out.add(bg)',
        '    }',
        '  }',
        '  return out',
        '}',
        '',
        '/**',
        ' * Извлечение русских основ: первые 5 символов слова.',
        ' *',
        ' * Зачем: апстрим сравнивает только латинские сущности и китайские биграммы, поэтому',
        ' * у русских записей не работал ни один канал, кроме дословного совпадения. Здесь',
        ' * «русски» / «русские» / «русском» и «картинки» / «картинок» сходятся к одной основе.',
        ' *',
        ' * Именно префикс, а не срезание окончаний по списку: список давал несогласованные',
        ' * основы для одного корня («русски» → «русс» по окончанию «ки», «русские» → «русск»',
        ' * по «ие»), из-за чего тема переставала опознаваться. Пять символов, а не четыре:',
        ' * на четырёх «предпочитать» и «предлагать» дали бы ложную склейку, а ложная склейка',
        ' * тут дороже дубля — она стирает чужую запись.',
        ' */',
        'export function extractStems(text) {',
        "  const t = text.replace(/^\\u7528\\u6237/, '').replace(/^\\s*пользовател\\w*\\s*/i, '').toLowerCase()",
        '  const out = new Set()',
        '  for (const w of t.match(/[\\u0430-\\u044f\\u0451]+/g) || []) {',
        '    if (w.length < 5 || STOP.has(w)) continue',
        '    out.add(w.slice(0, 5))',
        '  }',
        '  return out',
        '}',
      ),
    },
    {
      id: 'findSimilar(): считать основы',
      find: join(
        '  const ent = extractEntities(text)',
        '  const grams = extractGrams(text)',
      ),
      replace: join(
        '  const ent = extractEntities(text)',
        '  const grams = extractGrams(text)',
        '  const stems = extractStems(text)',
      ),
    },
    {
      id: 'findSimilar(): канал русских основ',
      find: join(
        '    // канал китайского',
        '    if (grams.size > 0 && jaccard(grams, extractGrams(p.text)) >= GRAM_THRESHOLD) return [key, p]',
      ),
      replace: join(
        '    // канал китайского',
        '    if (grams.size > 0 && jaccard(grams, extractGrams(p.text)) >= GRAM_THRESHOLD) return [key, p]',
        '',
        '    // канал русских основ: та же тема другими формами слов',
        '    if (stems.size > 0) {',
        '      const pStems = extractStems(p.text)',
        '      if (pStems.size > 0) {',
        '        let sharedStems = 0',
        '        for (const s of stems) if (pStems.has(s)) sharedStems++',
        '        if (sharedStems >= 2 || (sharedStems === 1 && (stems.size === 1 || pStems.size === 1))) {',
        '          return [key, p]',
        '        }',
        '      }',
        '    }',
      ),
    },
    {
      id: 'mirror_forget: дождаться удаления',
      find: join(
        '        const [key, p] = hit',
        '        table.delete(key)',
      ),
      replace: join(
        '        const [key, p] = hit',
        '        await table.delete(key)',
      ),
    },
    {
      id: 'HTTP /dsh-mirror/forget: дождаться удаления',
      find: '          table.delete(hit[0])',
      replace: '          await table.delete(hit[0])',
    },
    {
      id: 'remember(): сделать асинхронной и дождаться записей',
      find: '  const remember = ({ text, kind, reason }) => {',
      replace: '  const remember = async ({ text, kind, reason }) => {',
    },
    {
      id: 'remember(): дождаться перезаписи по той же теме',
      find: '      table.put(key, {',
      replace: '      await table.put(key, {',
    },
    {
      id: 'remember(): дождаться записи новой памяти',
      find: '    table.put(id, {',
      replace: '    await table.put(id, {',
    },
    {
      id: 'remember(): дождаться вытеснения по пределу ёмкости',
      find: '      if (weakest) table.delete(weakest[0])',
      replace: '      if (weakest) await table.delete(weakest[0])',
    },
    {
      id: 'инструмент mirror_remember: дождаться remember()',
      find: '        const outcome = remember({ text, kind: args.kind, reason: String(args.reason || \'\').trim() })',
      replace: '        const outcome = await remember({ text, kind: args.kind, reason: String(args.reason || \'\').trim() })',
    },
  ]
}

/**
 * Применить правки к исходнику.
 * @param source - содержимое index.translation.js.
 * @returns исходник с правками и отчёт по каждой правке.
 * @throws когда якорь не найден или встречается не один раз.
 */
export function applyFixes(source) {
  let out = source
  const report = []
  for (const fix of fixes()) {
    const count = out.split(fix.find).length - 1
    if (count !== 1) {
      throw new Error(`правка «${fix.id}»: якорь найден ${count} раз(а), ожидался ровно 1`)
    }
    out = out.replace(fix.find, fix.replace)
    report.push({ id: fix.id })
  }
  const required = [
    'export function extractStems',
    '[a-z0-9\\u0430-\\u044f\\u0451]',
    'const remember = async ({ text, kind, reason }) => {',
    'await table.put(key, {',
    'await table.put(id, {',
    'await table.delete(weakest[0])',
    'await table.delete(key)',
    'await table.delete(hit[0])',
  ]
  for (const marker of required) {
    if (!out.includes(marker)) throw new Error(`после применения правок не найден маркер ${JSON.stringify(marker)}`)
  }
  return { source: out, report }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, ...rest] = process.argv.slice(2)
  try {
    if (flag === '--check') {
      const target = readFileSync(rest[0], 'utf8')
      const markers = {
        'extractStems': target.includes('export function extractStems'),
        'await remember(...)': target.includes('const outcome = await remember('),
        'await table.put(key, ...)': target.includes('await table.put(key, {'),
        'await table.put(id, ...)': target.includes('await table.put(id, {'),
        'await table.delete(weakest[0])': target.includes('await table.delete(weakest[0])'),
        'await table.delete(key)': target.includes('await table.delete(key)'),
        'await table.delete(hit[0])': target.includes('await table.delete(hit[0])'),
        'кириллица в сущностях': target.includes('[a-z0-9\\u0430-\\u044f\\u0451]'),
        'русские стоп-слова': target.includes("'пользователь',"),
      }
      let ok = true
      for (const [name, present] of Object.entries(markers)) {
        if (!present) ok = false
        console.log(`${present ? 'OK  ' : 'FAIL'} ${name}`)
      }
      if (rest[1] !== undefined) {
        const rebuilt = applyFixes(readFileSync(rest[1], 'utf8')).source
        const same = rebuilt === target
        if (!same) ok = false
        console.log(`${same ? 'OK  ' : 'FAIL'} файл == перевод + правки`)
      }
      process.exit(ok ? 0 : 1)
    }
    const [first, second] = [flag, rest[0]]
    const { source, report } = applyFixes(readFileSync(first, 'utf8'))
    writeFileSync(second, source)
    console.log(`собрано: ${second}`)
    for (const r of report) console.log(`  + ${r.id}`)
  } catch (error) {
    console.error(`ошибка: ${error.message}`)
    process.exit(1)
  }
}
