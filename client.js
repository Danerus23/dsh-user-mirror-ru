/**
 * Браузерная половина dsh-mirror: добавляет вкладку «память» после «диалог / трасса».
 *
 * Канал данных: host-сторона регистрирует эндпоинт /dsh-mirror/preferences (см. index.js),
 * эта половина запрашивает его, получает список памяти и показывает в реальном времени.
 *
 * Структура:
 *  - slot conversation.view (id=memory, order=20) → идёт после диалога (0) и трассы (10)
 *  - компонент MemoryView рендерит список памяти через React hooks + fetch
 */
window.__ModuleLoader__.load({
  id: 'dsh-user-mirror',
  factory: (require) => {
    const React = require('react')
    const exports = {}
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const CSS = `
      .dsh-mirror-view { padding: 16px; font-size: 13px; line-height: 1.6; height: 100%; overflow: auto; }
      .dsh-mirror-view h3 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
      .dsh-mirror-view .dmr-sub { color: var(--dsw-alias-label-secondary, #888); font-size: 12px; margin-bottom: 12px; }
      .dsh-mirror-item {
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        border-radius: 8px; padding: 8px 12px; margin-bottom: 8px;
        background: var(--dsw-alias-bg-layer-1, #fff);
      }
      .dsh-mirror-item .dmr-text { color: var(--dsw-alias-label-primary, #222); }
      .dsh-mirror-item .dmr-meta { color: var(--dsw-alias-label-tertiary, #aaa); font-size: 11px; margin-top: 4px; display: flex; gap: 10px; }
      .dsh-mirror-empty { color: var(--dsw-alias-label-tertiary, #aaa); text-align: center; padding: 40px 0; }
      .dsh-mirror-refresh {
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
        background: var(--dsw-alias-button-elevated-fill, #fff);
        color: var(--dsw-alias-label-primary, #222);
        border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px;
      }
      .dsh-mirror-refresh:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
      .dsh-mirror-title { display: flex; align-items: center; gap: 8px; }
      .dsh-mirror-how {
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        border-radius: 8px; padding: 10px 12px; margin: 4px 0 12px;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02));
        font-size: 12px; line-height: 1.7;
      }
      .dsh-mirror-how summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #888); }
      .dsh-mirror-how dl { margin: 8px 0 0; }
      .dsh-mirror-how dt { color: var(--dsw-alias-label-primary, #222); font-weight: 600; margin-top: 6px; }
      .dsh-mirror-how dd { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #888); }
      .dsh-mirror-how code {
        background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05));
        padding: 1px 4px; border-radius: 4px; font-size: 11px;
      }
      .dmr-kind {
        flex: none; font-size: 11px; padding: 1px 6px; border-radius: 4px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
        color: var(--dsw-alias-label-secondary, #888);
      }
      .dmr-head { display: flex; align-items: baseline; gap: 6px; }
      .dmr-forget {
        margin-left: auto; flex: none; border: none; background: none; cursor: pointer;
        color: var(--dsw-alias-label-tertiary, #aaa); font-size: 12px; padding: 0 4px;
        border-radius: 4px; line-height: 1.4;
      }
      .dmr-forget:hover { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
      .dmr-forget.is-confirming { color: #ef5350; }
      .dmr-reason {
        color: var(--dsw-alias-label-tertiary, #aaa); font-size: 11px;
        margin-top: 4px; padding-left: 8px;
        border-left: 2px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
      }
      .dsh-mirror-orb { flex: none; display: flex; align-items: center; }
      .dsh-mirror-orb:empty { display: none; }
      .dsh-mirror-orb-fallback { flex: none; font-size: 18px; line-height: 1; }
    `

    /** Одноимённый ESM-вход ai-orb — host-сторона раздаёт его через vendor-маршрут прямо из node_modules. */
    const ORB_MODULE = '/dsh-mirror/vendor/ai-orb/index.js'

    /** Эндпоинт удаления одной записи. */
    const ORB_FORGET_URL = '/dsh-mirror/forget'

    /** Окно индикации «только что записал»: в это время шар показывает done + счётчик. */
    const LEARNED_WINDOW_MS = 60 * 1000

    /** Русские тексты доступности для шара (у ai-orb по умолчанию английские). */
    const ORB_LABELS = {
      idle: 'dsh-mirror · на изготовке',
      thinking: 'dsh-mirror · читает память',
      working: 'dsh-mirror · обновляет',
      done: 'dsh-mirror · только что записал предпочтение',
      error: 'dsh-mirror · ошибка чтения',
    }

    /**
     * Отображение текущего состояния представления в выражение шара.
     * «Работа» и «запись» — две основные линии: ручное обновление = working (кольцо крутится),
     * только что извлечённое host-стороной предпочтение = done + счётчик (сколько записей).
     */
    function orbStateOf(s, now) {
      if (s.error) return ['error', 0]
      if (s.refreshing) return ['working', 0]
      if (s.loading) return ['thinking', 0]
      const learned = s.lastLearned
      if (learned && learned.count > 0 && now - learned.at < LEARNED_WINDOW_MS) {
        return ['done', learned.count]
      }
      return ['idle', 0]
    }

    function injectCSS() {
      const tagId = 'dsh-user-mirror/view.css'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-user-mirror'
      tag.setAttribute('data-plugin-css', tagId)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts
      const day = 24 * 60 * 60 * 1000
      if (diff < 60 * 1000) return 'только что'
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' мин назад'
      if (diff < day) return Math.floor(diff / 3600000) + ' ч назад'
      return Math.floor(diff / day) + ' дн назад'
    }

    /** Компонент вкладки памяти. */
    function MemoryView() {
      const [state, setState] = React.useState({
        loading: true,
        refreshing: false,
        memories: [],
        kinds: null,
        error: null,
        lastLearned: null,
      })
      // шар — украшение: если не загрузился, откатываемся на 🪞 и не даём ему заслонить список памяти
      const [orbReady, setOrbReady] = React.useState(false)
      // id записи, ожидающей подтверждения удаления — в два шага: первое нажатие только подсвечивает, не удаляет
      const [pendingForget, setPendingForget] = React.useState(null)
      const orbHost = React.useRef(null)
      const orb = React.useRef(null)

      const load = React.useCallback((manual) => {
        setState((s) => ({ ...s, loading: !manual, refreshing: !!manual }))
        fetch('/dsh-mirror/preferences')
          .then((r) => r.json())
          .then((d) =>
            setState({
              loading: false,
              refreshing: false,
              memories: d.memories || [],
              kinds: d.kinds || null,
              error: null,
              lastLearned: d.lastLearned || null,
            }),
          )
          .catch((e) =>
            setState({
              loading: false,
              refreshing: false,
              memories: [],
              kinds: null,
              error: String(e),
              lastLearned: null,
            }),
          )
      }, [])

      React.useEffect(() => {
        injectCSS()
        load(false)
      }, [load])

      const forget = React.useCallback(
        (id) => {
          setPendingForget(null)
          fetch(ORB_FORGET_URL + '/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(() => load(true))
            .catch(() => load(true))
        },
        [load],
      )

      // монтируем ai-orb — используется npm-источник, раздаваемый vendor-маршрутом host-стороны, а не скопированный сюда
      React.useEffect(() => {
        let disposed = false
        import(ORB_MODULE)
          .then(({ AgentOrb }) => {
            if (disposed || !orbHost.current) return
            orb.current = new AgentOrb(orbHost.current, {
              size: 26,
              theme: 'violet',
              shape: 'circle',
              follow: false, // шар в 26px не даёт заметного эффекта от слежения, глобальный mousemove не нужен
              labels: ORB_LABELS,
            })
            setOrbReady(true)
          })
          .catch(() => {
            /* если шар не загрузился, запасной вариант — 🪞, список памяти работает как обычно */
          })
        return () => {
          disposed = true
          if (orb.current) {
            orb.current.destroy()
            orb.current = null
          }
        }
      }, [])

      // состояние → выражение шара
      const [orbState, orbUnseen] = orbStateOf(state, Date.now())
      React.useEffect(() => {
        if (orb.current) orb.current.set(orbState, orbUnseen)
      }, [orbState, orbUnseen])

      // done имеет срок: как только окно прошло, нужно самому вернуться в idle, иначе счётчик так и будет висеть
      React.useEffect(() => {
        if (orbState !== 'done' || !state.lastLearned) return
        const left = LEARNED_WINDOW_MS - (Date.now() - state.lastLearned.at)
        if (left <= 0) return
        const t = setTimeout(() => setState((s) => ({ ...s })), left + 100)
        return () => clearTimeout(t)
      }, [orbState, state.lastLearned])

      // Шапка присутствует всегда (не выходит раньше времени из-за состояния загрузки) — иначе во время
      // loading шар ещё не смонтирован, а thinking как раз то, что важнее всего показать.
      const header = React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        React.createElement('div', { className: 'dsh-mirror-title' },
          // этот контейнер обязан иметь пустые children: AgentOrb добавляется императивно
          // через append, и стоит отдать их React — шар снесётся при следующем перерендере.
          React.createElement('div', { className: 'dsh-mirror-orb', ref: orbHost }),
          orbReady ? null : React.createElement('span', { className: 'dsh-mirror-orb-fallback' }, '🪞'),
          React.createElement('div', null,
            React.createElement('h3', null, 'Память'),
            React.createElement('div', { className: 'dmr-sub' },
              'предпочтения, выученные из цепочки think · забываются · новое перезаписывает старое',
            ),
          ),
        ),
        React.createElement(
          'button',
          {
            className: 'dsh-mirror-refresh',
            onClick: () => load(true),
            disabled: state.refreshing,
          },
          state.refreshing ? 'Обновление…' : 'Обновить',
        ),
      )

      // «Когда именно оно записывает и что» — без явного объяснения эта вкладка для человека чёрный ящик
      const kinds = state.kinds || {}
      const how = React.createElement('details', { className: 'dsh-mirror-how' },
        React.createElement('summary', null, 'Когда оно записывает? Что именно? Почему забывает?'),
        React.createElement('dl', null,
          React.createElement('dt', null, 'Когда записывает'),
          React.createElement('dd', null,
            'Модель решает сама. Когда она понимает, что ты выразил основание для суждения, пригодное для повторного использования, она вызывает ',
            React.createElement('code', null, 'mirror_remember'),
            ' — поэтому каждая запись появляется в диалоге: её видно, она не пишется тайком за спиной.'),
          React.createElement('dt', null, 'Что записывает'),
          ...Object.keys(kinds).length
            ? Object.entries(kinds).map(([k, desc]) =>
                React.createElement('dd', { key: k },
                  React.createElement('code', null, k), ' ', desc))
            : [React.createElement('dd', { key: 'na' }, 'принципы / красные линии / рабочий процесс / предпочтения в подаче')],
          React.createElement('dt', null, 'Что не записывает'),
          React.createElement('dd', null,
            'Разовые запросы (это задача, а не принцип), объективные факты (пути, аккаунты, серверы — у них есть свой источник истины, ' +
            'а вторая копия здесь начнёт с ним конфликтовать), а также собственные догадки модели.'),
          React.createElement('dt', null, 'Как обновляет'),
          React.createElement('dd', null,
            'Новая формулировка по той же теме перезаписывает старую, близкие по смыслу записи не добавляются; каждое новое подтверждение даёт силе +1.'),
          React.createElement('dt', null, 'Почему забывает'),
          React.createElement('dd', null,
            'Сила = число подтверждений × временное затухание (период полураспада 30 дней); после заполнения ёмкости вытесняется самая слабая запись. ' +
            'Человеческий мозг не может расти бесконечно, здесь так же — берём только основания для суждения, а не факты, поэтому объём и так ограничен.'),
        ),
      )

      let content
      if (state.loading) {
        content = React.createElement('div', { className: 'dsh-mirror-empty' }, 'Загрузка…')
      } else if (state.error) {
        content = React.createElement('div', { className: 'dsh-mirror-empty' }, 'Ошибка загрузки: ' + state.error)
      } else if (state.memories.length === 0) {
        content = React.createElement('div', { className: 'dsh-mirror-empty' },
          'Памяти пока нет. Когда ты в следующий раз выразишь какой-нибудь принцип или компромисс, модель сразу запишет его через mirror_remember — и ты увидишь в диалоге, что именно записано.')
      } else {
        const confirming = pendingForget
        content = state.memories.map((m) =>
          React.createElement('div', { className: 'dsh-mirror-item', key: m.id },
            React.createElement('div', { className: 'dmr-head' },
              React.createElement('span', { className: 'dmr-kind' }, m.kind || 'principle'),
              React.createElement('span', { className: 'dmr-text' }, m.text),
              React.createElement('button', {
                className: 'dmr-forget' + (confirming === m.id ? ' is-confirming' : ''),
                title: confirming === m.id ? 'Нажми ещё раз, и запись будет убрана' : 'Убрать эту запись',
                onClick: () => (confirming === m.id ? forget(m.id) : setPendingForget(m.id)),
                onBlur: () => confirming === m.id && setPendingForget(null),
              }, confirming === m.id ? 'Убрать?' : '✕'),
            ),
            m.reason
              ? React.createElement('div', { className: 'dmr-reason' }, 'Почему записано: ' + m.reason)
              : null,
            React.createElement('div', { className: 'dmr-meta' },
              React.createElement('span', null, 'сила ' + m.strength),
              React.createElement('span', null, 'подтверждений: ' + m.hits + ' раз'),
              React.createElement('span', null, timeAgo(m.lastSeenAt)),
            ),
          ),
        )
      }

      return React.createElement('div', { className: 'dsh-mirror-view' }, header, how, content)
    }

    exports.name = 'dsh-user-mirror'

    /**
     * cordis fiber inject — объявлять обязательно здесь, иначе обращение к ctx.slots даст
     * `cannot get property "slots" without inject`.
     * Учти: dsh.client.inject в package.json носит информационный характер (метаданные
     * загрузки/предзагрузки, сортировки apply нет) и роли сервисного guard не играет.
     */
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      // slot conversation.view объявляется в ui-conversation, порядок активации не гарантирован,
      // поэтому полагаемся на slots.inject и ждём его появления, а не регистрируем сразу в расчёте на порядок.
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'memory',
            order: 20,
            label: () => 'Память',
          },
          MemoryView,
        ),
      )
    }

    return exports
  },
})
