/**
 * dsh-mirror — плагин изучения предпочтений: чем дольше работаешь с ИИ, тем лучше он тебя понимает.
 *
 * Модель памяти: структурированная и умеющая забывать.
 *  - у каждой записи есть «сила» = число подтверждений × временное затухание (кривая забывания)
 *  - предел ёмкости: при заполнении вытесняется самая слабая запись
 *  - семантически похожая новая запись перезаписывает старую (новое понимание вытесняет старое)
 *  - внедрение идёт по бюджету токенов, а не по числу записей
 *
 * Обязанности:
 *  - подписка на события session, перехват цепочки thinking модели (reasoning-delta)
 *  - извлечение из цепочки think «понимания моделью предпочтений пользователя» (сопоставление по правилам)
 *  - сохранение предпочтений через domain-возможность ctx.storage (таблица: preferences)
 *  - регистрация system-prompt section: внедрение по силе + бюджету токенов
 *  - два инструмента mirror_remember / mirror_forget: записать и убрать
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
// normalize взят под псевдонимом: в этом модуле уже есть normalize для нормализации текста предпочтений
import { dirname, join, normalize as normalizePath, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Стабильное имя плагина. */
export const name = 'dsh-mirror'

/**
 * Каталог-источник ai-orb — указывает прямо на сам npm-пакет в node_modules.
 *
 * client.js написан вручную, без сборки, и отдаётся как есть; `require()` умеет
 * доставать только модули host-стороны, а npm-пакет — нет. Поэтому ESM-исходники
 * ai-orb раздаются как статические ресурсы того же источника, а client забирает
 * их через `import('/dsh-mirror/vendor/ai-orb/index.js')` — внутренний
 * `import './style.js'` естественно разрешается под тем же префиксом.
 * Выгода в отсутствии копии: обновление ai-orb требует лишь обновить зависимость,
 * без синхронизации какого-либо скопированного кода.
 */
const ORB_SRC = join(dirname(createRequire(import.meta.url).resolve('ai-orb/package.json')), 'src')

/**
 * Префикс vendor-маршрута — в конце **нельзя** ставить косую черту.
 * Сопоставление prefix в webserver — `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * собственный хвостовой слэш превратится в сопоставление двойного слэша и всегда даст 404.
 */
const VENDOR_PREFIX = '/dsh-mirror/vendor/ai-orb'

/** Префикс маршрута удаления одной записи (тоже без хвостового слэша). */
const FORGET_PREFIX = '/dsh-mirror/forget'

/** Нужные сервисы: домен хранилища / системный промпт / регистрация инструментов / HTTP-носитель (для запросов данных на стороне client). */
export const inject = ['storageDomain', 'systemPrompt', 'tools', 'webServer']

/** Конфигурация плагина. */
export const Config = z.object({
  /** Предел ёмкости памяти (число записей). При заполнении вытесняется самая слабая. */
  maxPreferences: z.number().default(20),
  /** Период полураспада (дни). Сколько времени без нового подтверждения — и сила падает вдвое. */
  halfLifeDays: z.number().default(30),
  /** Бюджет токенов для внедрения в системный промпт (приблизительно: 2 символа ≈ 1 токен). */
  maxTokens: z.number().default(500),
  /** Позиция сортировки для system-prompt section (чем меньше, тем раньше). */
  sectionOrder: z.number().default(160),
})

/**
 * Категории памяти — намеренно только четыре, и намеренно **без** «фактов».
 *
 * У фактов (пути, аккаунты, серверы, домены…) уже есть cs как источник истины;
 * хранить здесь вторую копию — значит завести второй источник истины. Это зеркало
 * хранит только то, чего в cs нет: **как ты думаешь и как выбираешь**.
 *
 * Это же и решение задачи «человеческий мозг не может расти бесконечно» —
 * оснований для суждения заведомо конечное число (десятки), а факты бесконечны.
 * Берём только первое — и ёмкость держится не на вытеснении.
 */
export const KINDS = {
  principle: 'принцип/компромисс — что предпочесть и как выбирать в какой ситуации',
  redline: 'красная линия — чего делать нельзя ни в коем случае',
  workflow: 'рабочий процесс — порядок работы и привычки взаимодействия',
  taste: 'вкус/подача — формулировки, стиль, подача',
}

/** Схема записи памяти. */
const preferenceSchema = zod.object({
  id: zod.string(),
  text: zod.string(),
  /** Одна из четырёх категорий, см. KINDS. */
  kind: zod.string(),
  /** Почему это записано — запись без причины нельзя проследить, а значит нельзя и доверять. */
  reason: zod.string(),
  hits: zod.number(),
  lastSeenAt: zod.number(),
  source: zod.string(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
})

/**
 * Объявление домена памяти.
 * v3: добавлены kind / reason — от «угаданного предпочтения» к «основанию для суждения, у которого есть причина».
 */
const MirrorDomain = defineDomain({
  name: 'dsh_mirror',
  version: 3,
  tables: {
    preferences: domainTable(preferenceSchema),
  },
})

/** Нормализация: убрать префикс «пользователь», пробелы и пунктуацию — для сопоставления при семантической перезаписи. */
export function normalize(text) {
  return text
    .replace(/^\u7528\u6237/, '')
    .replace(/[\s\u3002\uff01\uff1f\uff1b;\uff0c,\u3001\uff1a\u300c\u300d\u300e\u300f"'`]/g, '')
    .toLowerCase()
}

/** Сила по кривой забывания = число подтверждений × временное затухание. */
export function strengthOf(p, now, halfLifeMs) {
  const age = Math.max(0, now - (p.lastSeenAt ?? p.updatedAt))
  const decay = Math.exp(-age / halfLifeMs)
  return p.hits * decay
}

/** Стоп-слова: встречаются слишком повсеместно и не различают «это одна тема или нет». */
const STOP = new Set([
  '\u504f\u597d', '\u559c\u6b22', '\u4e60\u60ef', '\u5e0c\u671b', '\u8981\u6c42', '\u503e\u5411', '\u4ecb\u610f', '\u6ce8\u91cd', '\u5728\u610f', '\u8ba8\u538c', '\u4e0d\u559c\u6b22',
  '\u5f3a\u8c03', '\u575a\u6301', '\u7ea6\u5b9a', '\u8ba4\u4e3a', '\u89c9\u5f97', '\u8bf4\u8fc7', '\u63d0\u5230', '\u975e\u5e38', '\u6bd4\u8f83', '\u66f4', '\u4e00\u76f4', '\u901a\u5e38',
  '\u4e00\u822c', '\u660e\u663e', '\u7279\u522b', '\u4f3c\u4e4e', '\u597d\u50cf', '\u5e94\u8be5', '\u53ef\u80fd', '\u5f88', '\u771f\u7684', '\u5176\u5b9e', '\u5e76\u4e0d',
  '\u7684', '\u662f', '\u5728', '\u7528', '\u548c', '\u800c', '\u4f46', '\u5c31', '\u90fd', '\u4e5f', '\u4e0d', '\u6ca1', '\u6709', '\u4e86', '\u7740',
  '\u6211', '\u4f60', '\u4ed6', '\u5979', '\u5b83', '\u6211\u4eec', '\u4f60\u4eec', '\u4ed6\u4eec', '\u8fd9\u4e2a', '\u90a3\u4e2a', '\u8fd9\u79cd', '\u90a3\u79cd',
  '\u4e0d\u8981', '\u4e00\u5f8b', '\u4e0d\u518d', '\u8fd9\u91cc', '\u90a3\u91cc', '\u4ec0\u4e48', '\u600e\u4e48', '\u53ef\u4ee5', '\u9700\u8981', '\u5fc5\u987b',
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'not', 'no', 'yes', 'use', 'using', 'prefer', 'prefers', 'like', 'likes',
])

/**
 * Извлечение англоязычных/цифровых сущностей (r2, picx, typescript, main…).
 *
 * Главное: режем по **исходному** тексту, а не по результату normalize — он
 * удаляет пунктуацию, и «R2\uff0cpicx» склеится в один `r2picx`: две сущности станут
 * одним словом, и та же тема больше не распознается. Пунктуация и иероглифы сами
 * служат естественной границей слова.
 */
export function extractEntities(text) {
  const t = text.replace(/^\u7528\u6237/, '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9]+/g) || []) {
    if (w.length >= 2 && !STOP.has(w)) out.add(w)
  }
  return out
}

/**
 * Извлечение китайских биграмм. В китайском нет пробелов, и bigram — самый дешёвый
 * и при этом достаточный способ нарезки: подключать токенизатор ради ответа на
 * вопрос «это одна и та же тема?» — типичная случайная сложность.
 */
export function extractGrams(text) {
  const t = text.replace(/^\u7528\u6237/, '')
  const out = new Set()
  for (const seg of t.replace(/[^\u4e00-\u9fa5]+/g, ' ').trim().split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2)
      if (!STOP.has(bg)) out.add(bg)
    }
  }
  return out
}

/** Ключевые слова темы = англоязычные сущности + китайские биграммы. */
export function extractKeywords(text) {
  return new Set([...extractEntities(text), ...extractGrams(text)])
}

/** Коэффициент Жаккара для двух множеств ключевых слов. */
export function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  return inter / (setA.size + setB.size - inter)
}

/** С какого перекрытия китайских биграмм считать тему одной. Множество bigram само по себе большое, порог нельзя переносить с пословного 0.5. */
const GRAM_THRESHOLD = 0.3

/**
 * Поиск уже существующей записи по той же теме — для перезаписи.
 *
 * Два независимых критерия, потому что сила сигнала у двух типов текста очень разная:
 *  · англоязычные сущности (r2 / picx / typescript / main) в техническом контексте почти
 *    равны метке темы: двух общих попаданий уже достаточно, чтобы признать тему одной;
 *  · выражения только на китайском опираются лишь на перекрытие bigram, порог считается отдельно.
 * При сведении в один jaccard сущности размылись бы массой bigram — именно так и терялись
 * «картинки всегда на R2, больше не добавлять их в picx» и «картинки идут через R2, picx новых не принимает».
 */
export function findSimilar(table, text) {
  const n = normalize(text)
  if (n.length < 4) return null
  const ent = extractEntities(text)
  const grams = extractGrams(text)

  for (const [key, p] of table.entries()) {
    const pn = normalize(p.text)
    if (pn === n) return [key, p]
    if (pn.length >= 6 && (pn.includes(n) || n.includes(pn))) return [key, p]

    // канал сущностей
    const pEnt = extractEntities(p.text)
    if (ent.size > 0 && pEnt.size > 0) {
      let shared = 0
      for (const x of ent) if (pEnt.has(x)) shared++
      // две общие сущности = одна тема; при одной — нужно, чтобы совпали все сущности одной из сторон. Здесь намеренный крен в сторону объединения: у записей есть предел, лучше перезаписать близкой по смыслу, чем держать две повторяющиеся.
      if (shared >= 2 || (shared === 1 && (ent.size === 1 || pEnt.size === 1))) return [key, p]
    }

    // канал китайского
    if (grams.size > 0 && jaccard(grams, extractGrams(p.text)) >= GRAM_THRESHOLD) return [key, p]
  }
  return null
}

/** Приблизительное число токенов (смешанный китайско-английский — примерно 2 символа / токен). */
function estTokens(text) {
  return Math.ceil(text.length / 2)
}

/** Сортировка по силе и отбор записей в пределах бюджета токенов. */
export function selectMemories(table, maxTokens, now, halfLifeMs) {
  const entries = [...table.entries()]
    .map(([key, p]) => [key, p, strengthOf(p, now, halfLifeMs)])
    .filter(([, , s]) => s > 0.01) // полностью забытые не берём
    .sort((a, b) => b[2] - a[2])
  const out = []
  let used = 0
  for (const [key, p, strength] of entries) {
    const t = estTokens(p.text)
    if (used + t > maxTokens) break
    out.push([key, p, strength])
    used += t
  }
  return out
}

/**
 * Отрисовка блока памяти, внедряемого в системный промпт.
 *
 * Формулировки каркаса должны быть предельно скупыми — бюджет оставлен самой памяти.
 * Нет записей — не внедряем ни одного символа: «когда записывать» уже написано в
 * определении инструмента mirror_remember, а оно и так постоянно в контексте;
 * повторять это здесь — второй источник истины.
 */
export function renderPreferences(table, maxTokens, now, halfLifeMs) {
  const selected = selectMemories(table, maxTokens, now, halfLifeMs)
  if (selected.length === 0) return ''
  const lines = selected.map(
    ([, p, strength], i) => `${i + 1}. [${p.kind ?? 'principle'}] ${p.text} (сила ${strength.toFixed(1)})`,
  )
  return `О том, как думает этот человек (забывается, перезаписывается новым пониманием):\n\n${lines.join('\n')}`
}

/**
 * Применение плагина: открыть домен хранилища, зарегистрировать section системного промпта, подписаться на цепочку think, зарегистрировать инструменты.
 * @param ctx - Контекст Cordis.
 * @param config - Конфигурация плагина.
 */
export function apply(ctx, config) {
  const halfLifeMs = config.halfLifeDays * 24 * 60 * 60 * 1000
  let table = null

  /**
   * Последняя активность «что-то записал» — нужна только для индикации шара на стороне client.
   * Само извлечение идёт синхронно внутри turn/end, настолько быстро, что момент «сейчас
   * записываю» не поймать: поэтому запоминается «только что записал, сколько записей».
   */
  let lastLearned = { at: 0, count: 0 }

  /*
   * Жизненный цикл домена хранилища обязан целиком находиться внутри effect — так
   * обходятся сразу три ловушки:
   *
   * 1. Если open вызвать на верхнем уровне apply, то при повторном запуске effect
   *    (перезагрузка плагина) вернётся тот же promise, а domain уже закрыт прошлым
   *    cleanup — и с этого момента недоступен навсегда.
   * 2. cleanup закрывает domain, но не очищает table, и table становится висячей
   *    ссылкой: следующий `table.size` / `table.put` попадёт в уже закрытую нижнюю БД,
   *    внутренний db равен undefined и рождается
   *    `Cannot read properties of undefined (reading 'prepare')` — причём внутри
   *    turn/end, что выглядит как «сбой текущего прогона», а в логах ничего нет.
   * 3. Если выгрузить плагин, пока open не завершён, дескриптор утечёт в promise.
   */
  ctx.effect(() => {
    let disposed = false
    let handle = null
    const opening = ctx.storageDomain.open(MirrorDomain)

    opening
      .then((domain) => {
        // resolve пришёл уже после выгрузки: этот дескриптор никто не использует, закрываем сразу, без утечки
        if (disposed) {
          domain.close()
          return
        }
        handle = domain
        table = domain.table('preferences')
        ctx.logger?.info(`dsh-mirror: хранилище памяти готово (ёмкость ${config.maxPreferences} записей, период полураспада ${config.halfLifeDays} дн.)`)
      })
      .catch((err) => {
        ctx.logger?.error(`dsh-mirror: не удалось открыть домен хранилища: ${err?.message ?? err}`)
      })

    return () => {
      disposed = true
      // сначала рвём ссылку, потом закрываем: после закрытия эту таблицу трогать нельзя никому
      table = null
      if (handle) {
        handle.close()
        handle = null
      }
    }
  })

  /**
   * Записать одну память: перезаписать похожую старую, при заполнении вытеснить самую слабую.
   * @returns 'updated' (перезаписано старое понимание по той же теме) или 'created' (новая запись)
   */
  const remember = ({ text, kind, reason }) => {
    const now = Date.now()
    const similar = findSimilar(table, text)
    if (similar) {
      const [key, p] = similar
      // новое понимание перезаписывает старое: сохраняем прежний id, обновляем содержимое/подтверждения/время
      table.put(key, {
        ...p,
        text,
        kind,
        reason,
        hits: p.hits + 1,
        lastSeenAt: now,
        updatedAt: now,
      })
      return 'updated'
    }
    const id = `pref-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    table.put(id, {
      id,
      text,
      kind,
      reason,
      hits: 1,
      lastSeenAt: now,
      source: 'tool',
      createdAt: now,
      updatedAt: now,
    })
    // предел ёмкости: вытесняем самую слабую
    if (table.size > config.maxPreferences) {
      const weakest = [...table.entries()]
        .map(([k, p]) => [k, strengthOf(p, now, halfLifeMs)])
        .sort((a, b) => a[1] - b[1])[0]
      if (weakest) table.delete(weakest[0])
    }
    return 'created'
  }

// system-prompt section: сказать модели, когда записывать и как записывать (order в самом начале: сначала задача, потом показ уже накопленной памяти)
	ctx.systemPrompt.section({
	  name: 'mirror:duty',
	  order: config.sectionOrder - 1,
	  text: () => {
	    if (!table) return ''
	    const lines = [
	      'Когда ты замечаешь, что пользователь выразил основание для суждения, пригодное для повторного использования, вызови mirror_remember, чтобы записать:',
	      '',
	      '  principle (принцип/компромисс) — какой вариант предпочесть и как выбирать',
	      '  redline (красная линия) — чего делать нельзя ни в коем случае',
	      '  workflow (рабочий процесс) — порядок работы, привычки взаимодействия',
	      '  taste (вкус/подача) — формулировки, стиль, подача',
	      '',
	      'Не записывать: разовые запросы, объективные факты (у путей, аккаунтов и серверов есть свой источник истины), твои собственные догадки.',
	      'Если по той же теме появилась новая формулировка — просто запиши ещё раз, старая будет перезаписана. Записал — и всё, не докладывай отдельно «я записал».',
	    ]
	    return lines.join('\n')
	  },
	})

	// system-prompt section: внедрение уже накопленной памяти (функция, вычисляется при каждой сборке)
	ctx.systemPrompt.section({
	  name: 'mirror:preferences',
	  order: config.sectionOrder,
	  text: () => {
	    if (!table) return ''
	    const rendered = renderPreferences(table, config.maxTokens, Date.now(), halfLifeMs)
	    if (!rendered) return '(mirror: памяти пока нет. Когда пользователь выразит пригодные для повторного использования принцип/красную линию/рабочий процесс/предпочтение в подаче, вызови mirror_remember, чтобы записать.)'
	    return rendered
	  },
	})


  // HTTP-эндпоинт: список предпочтений для стороны client (вкладка памяти)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-mirror/preferences',
        handler: async (req, res) => {
          try {
            const now = Date.now()
            const selected = table
              ? selectMemories(table, Infinity, now, halfLifeMs)
              : []
            const body = JSON.stringify({
              memories: selected.map(([, p, s]) => ({
                id: p.id,
                text: p.text,
                kind: p.kind ?? 'principle',
                reason: p.reason ?? '',
                strength: Math.round(s * 100) / 100,
                hits: p.hits,
                lastSeenAt: p.lastSeenAt,
              })),
              // чтобы UI мог дословно объяснить человеку «что записывается и как классифицируется», не дублируя текст в двух местах
              kinds: KINDS,
              // для индикации шара: что только что записано и сколько записей
              lastLearned,
            })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(body)
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        },
      }),
    'dsh-mirror: /preferences route',
  )

  // vendor-маршрут: отдать клиенту ESM-исходники ai-orb как статические ресурсы того же источника
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: VENDOR_PREFIX,
        handler: async (req, res) => {
          // Пропускаем только .js из каталога ORB_SRC. После нормализации проверяем префикс,
          // чтобы отсечь обход через ../ — это открытый браузеру эндпоинт чтения файлов.
          const rel = (req.url || '').split('?')[0].slice(VENDOR_PREFIX.length)
          const file = normalizePath(join(ORB_SRC, rel))
          if (!file.startsWith(ORB_SRC + sep) || !file.endsWith('.js')) {
            res.writeHead(403, { 'content-type': 'text/plain' })
            res.end('forbidden')
            return
          }
          try {
            const body = await readFile(file, 'utf8')
            res.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'no-cache',
            })
            res.end(body)
          } catch {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('not found')
          }
        },
      }),
    'dsh-mirror: ai-orb vendor route',
  )

  // Инструмент: активно записать одно основание для суждения. Решать, кто должен это делать, отдано тому же, кто и должен — это работа мозга, а не регулярки.
  ctx.tools.register(
    defineTool({
      name: 'mirror_remember',
      description:
        'Записать одно основание для суждения, пригодное для повторного использования во всех последующих сессиях. Ёмкость ограничена, лучше меньше, да лучше.\n' +
        'Не записывать: разовые запросы (это задача), объективные факты (у путей, аккаунтов и серверов есть свой источник истины), твои собственные догадки.\n' +
        'Если по той же теме появилась новая формулировка — просто запиши ещё раз, система перезапишет старую.',
      // Внимание: parameters — это отображение «имя параметра → schema», обязательность задаётся встроенным required: true.
      // Если записать стандартную JSON Schema (обёртку с type: 'object' + properties), она будет воспринята
      // как параметр с именем type и выдаст `parameters.type must be a value schema object`.
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: 'Само основание, одной фразой, словами собеседника.',
        },
        // enum уже перечисляет все четыре категории, расписывать каждую построчно — повторение: имя категории говорит само за себя
        kind: { type: 'string', required: true, enum: Object.keys(KINDS) },
        reason: {
          type: 'string',
          required: true,
          description: 'На каком основании решено, что это пригодно для повторного использования (в какой ситуации сказано).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outcome: { type: 'string', required: true },
            total: { type: 'integer', required: true },
          },
        },
        render: (args, value) => [
          {
            type: 'text',
            text:
              (value.outcome === 'updated' ? '🪞 Обновлена одна запись памяти (перезаписано старое понимание по той же теме):' : '🪞 Записана новая память:') +
              `\n${args.text}\n(${args.kind} · всего записей: ${value.total})`,
          },
        ],
      },
      async execute(args) {
        if (!table) throw new Error('mirror_remember: хранилище памяти ещё не готово')
        if (!Object.hasOwn(KINDS, args.kind)) {
          throw new Error(`mirror_remember: kind может быть только ${Object.keys(KINDS).join(' / ')}`)
        }
        const text = String(args.text || '').trim()
        if (text.length < 4) throw new Error('mirror_remember: text слишком короткий, если не можешь сказать ясно — не записывай')
        const outcome = remember({ text, kind: args.kind, reason: String(args.reason || '').trim() })
        lastLearned = { at: Date.now(), count: 1 }
        ctx.logger?.info(`dsh-mirror: ${outcome} [${args.kind}] ${text}`)
        return { outcome, total: table.size }
      },
    }),
  )

  /*
   * Инструмент: убрать ошибочно записанную память.
   *
   * Изначально здесь был инструмент запроса mirror_preferences, но память и так внедряется
   * в system prompt, а второй инструмент запроса — это второй путь чтения, зря занимающий
   * постоянные токены. По-настоящему не хватало «удалить»: если можно только писать,
   * ошибочная запись либо ждёт полмесяца затухания, либо перезаписи новой формулировкой
   * по той же теме (а при замене китайских синонимов это ещё и не обнаружится), и всё
   * это время она загрязняет системный промпт на каждом ходу.
   */
  ctx.tools.register(
    defineTool({
      name: 'mirror_forget',
      description:
        'Убрать ошибочно записанную память (записанную как разовый запрос, как объективный факт или опровергнутую самим человеком).\n' +
        'В text достаточно передать суть той записи, которую нужно убрать: сопоставление идёт по теме, точный исходный текст не нужен.',
      parameters: {
        text: { type: 'string', required: true, description: 'Суть записи, которую нужно убрать.' },
        reason: { type: 'string', required: true, description: 'Почему её нужно убрать.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outcome: { type: 'string', required: true },
            forgot: { type: 'string', required: true },
            total: { type: 'integer', required: true },
          },
        },
        render: (_args, value) =>
          value.outcome === 'not_found'
            ? [{ type: 'text', text: '🪞 Подходящая запись не найдена, ничего не изменено.' }]
            : [{ type: 'text', text: `🪞 Убрано: ${value.forgot}\n(осталось записей: ${value.total})` }],
      },
      async execute(args) {
        if (!table) throw new Error('mirror_forget: хранилище памяти ещё не готово')
        const text = String(args.text || '').trim()
        if (text.length < 4) throw new Error('mirror_forget: text слишком короткий, невозможно найти')
        const hit = findSimilar(table, text)
        if (!hit) return { outcome: 'not_found', forgot: '', total: table.size }
        const [key, p] = hit
        table.delete(key)
        ctx.logger?.info(`dsh-mirror: forgot [${p.kind}] ${p.text} — ${args.reason}`)
        return { outcome: 'forgot', forgot: p.text, total: table.size }
      },
    }),
  )

  // HTTP: для кнопки удаления на вкладке «память». /dsh-mirror/forget/<id>
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: FORGET_PREFIX,
        handler: async (req, res) => {
          // Принимаем только DELETE/POST: GET будет предзагружен браузером или переигран при переходах по истории, а ошибочное удаление уже не вернуть
          if (req.method !== 'DELETE' && req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const id = decodeURIComponent((req.url || '').split('?')[0].slice(FORGET_PREFIX.length + 1))
          if (!table || !id) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'missing id or storage not ready' }))
            return
          }
          const hit = [...table.entries()].find(([, p]) => p.id === id)
          if (!hit) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
          }
          table.delete(hit[0])
          ctx.logger?.info(`dsh-mirror: forgot via UI [${hit[1].kind}] ${hit[1].text}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, total: table.size }))
        },
      }),
    'dsh-mirror: /forget route',
  )
}

export default { name, inject, Config, apply }
