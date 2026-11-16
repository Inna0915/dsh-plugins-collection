window.__ModuleLoader__.load({
  id: 'dsh-novel-reader',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const kind = 'novel-reader'
    const tabId = 'dsh-novel-reader/reading'
    const libraryApi = 'api/novel-reader/library'
    const startPages = {
      起点: 'https://www.qidian.com/',
      番茄: 'https://fanqienovel.com/'
    }
    const chapterPaths = {
      'www.qidian.com': /^\/chapter\/[\w-]+\/[\w-]+\/?$/,
      'read.qidian.com': /^\/chapter\/[\w-]+\/[\w-]+\/?$/,
      'm.qidian.com': /^\/book\/\d+\/\d+(?:\.html|\/)?$/,
      'fanqienovel.com': /^\/reader\/\d+\/?$/,
      'www.fanqienovel.com': /^\/reader\/\d+\/?$/,
      'm.fanqienovel.com': /^\/reader\/\d+\/?$/
    }
    const styles = '.dsh-novel{display:grid;gap:12px;align-content:start;padding:16px;height:100%;overflow:auto;box-sizing:border-box;font-size:13px}.dsh-novel h2,.dsh-novel h3,.dsh-novel p{margin:0}.dsh-novel h2{font-size:18px}.dsh-novel h3{font-size:14px}.dsh-novel small{opacity:.75}.dsh-novel .novel-row{display:flex;flex-wrap:wrap;gap:6px}.dsh-novel label{display:grid;gap:4px}.dsh-novel input,.dsh-novel textarea,.dsh-novel button{border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:6px 8px}.dsh-novel input,.dsh-novel textarea{width:100%;box-sizing:border-box}.dsh-novel textarea{resize:vertical}.dsh-novel button{cursor:pointer}.dsh-novel button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.dsh-novel button:disabled{opacity:.55;cursor:default}.dsh-novel article{display:grid;gap:5px;overflow-wrap:anywhere;border-top:1px solid color-mix(in srgb,currentColor 16%,transparent);padding-top:8px}.dsh-novel article p{white-space:pre-wrap}'

    function chapterUrl(input) {
      const url = URL.parse(input.trim())
      if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return ''
      return Object.hasOwn(chapterPaths, url.hostname) && chapterPaths[url.hostname].test(url.pathname)
        ? url.origin + url.pathname
        : ''
    }

    function chapterTitle(title) {
      const qidian = /^(.*?)\s*_\s*《([^》]+)》/u.exec(title)
      if (qidian) return { book: qidian[2].trim(), chapter: qidian[1].trim() }
      const cleaned = title.split(/[_｜|]\s*(?:起点中文网|起点读书|番茄小说)/u)[0]
        .replace(/(?:在线)?(?:免费)?阅读(?:章节)?$/u, '').trim()
      const chapter = /第\s*[\d零〇一二两三四五六七八九十百千万]+\s*[章节回卷].*$/u.exec(cleaned)
      if (!chapter) return { book: '', chapter: cleaned }
      return {
        book: cleaned.slice(0, chapter.index).replace(/[《》]/gu, '').replace(/[\s–—-]+$/u, '').trim(),
        chapter: chapter[0]
      }
    }

    function chapterGuests(ctx, sessionId) {
      const ids = new Set(ctx.sidebarRight.openTabs.getSnapshot()
        .filter(tab => tab.sessionId === sessionId && tab.kind === 'browser')
        .map(tab => tab.tabId))
      const matches = []
      for (const view of document.querySelectorAll('webview[data-sidebar-browser-frame="webview"]')) {
        const id = view.closest('[data-sidebar-right-tab]')?.dataset.sidebarRightTab
        if (!ids.has(id)) continue
        try {
          const url = chapterUrl(view.getURL())
          if (url) matches.push({ id, view, url, visible: view.getClientRects().length > 0 })
        } catch {
          // A browser tab can still be attaching or restoring.
        }
      }
      return matches
    }

    function currentGuest(ctx, sessionId, enteredUrl) {
      const matches = chapterGuests(ctx, sessionId)
      const visible = matches.filter(match => match.visible)
      if (visible.length === 1) return visible[0]
      const byUrl = matches.find(match => match.url === enteredUrl)
      if (byUrl) return byUrl
      if (matches.length === 1) return matches[0]
      throw new Error(matches.length
        ? '有多个章节标签，请让目标章节可见，或粘贴它的链接再试'
        : '请先在本会话的侧栏浏览器打开官方章节，也可以直接粘贴章节链接')
    }

    async function requestLibrary(body, signal) {
      const response = await fetch(libraryApi, body ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      } : { signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取或保存阅读记录失败')
      return data
    }

    function addQuestion(ctx, sessionId, source, excerpt, question) {
      const binding = ctx.uiSession.adapter.current.getSnapshot()
      const actions = binding.props.inputActions
      if (binding.key !== sessionId || !actions) throw new Error('请切回此阅读面板所属的会话')
      const span = actions.captureInsertion()
      const prompt = [
        question || '请结合以下摘录解释这段内容，避免后续剧情剧透。',
        ['来源', source.book, source.chapter].filter(Boolean).join(' · '),
        source.url,
        excerpt ? '\n' + excerpt.split('\n').map(line => '> ' + line).join('\n') : ''
      ].filter(Boolean).join('\n')
      if (!actions.insertText('\n\n' + prompt + '\n', { ...span, start: span.end })) {
        throw new Error('会话输入框暂不可编辑')
      }
      actions.persistDraft()
    }

    function exportMarkdown(notes) {
      const sections = notes.map(note => [
        '## ' + [note.book, note.chapter].filter(Boolean).join(' · ').replace(/[\r\n]+/gu, ' '),
        '<' + note.url + '>',
        note.excerpt && note.excerpt.split('\n').map(line => '> ' + line).join('\n'),
        note.note
      ].filter(Boolean).join('\n\n'))
      const file = new Blob(['# 阅读笔记\n\n' + sections.join('\n\n') + '\n'], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = '阅读笔记.md'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function BookIcon() {
      return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M12 6c-3-2.5-6-2.5-9-1v14c3-1.5 6-1.5 9 1 3-2.5 6-2.5 9-1V5c-3-1.5-6-1.5-9 1Zm0 0v14' }))
    }

    function apply(ctx) {
      const openReader = () => ctx.sidebarRight.openTab(kind)

      function ReadingPane({ sessionId, useTabInfo }) {
        const { tab } = useTabInfo()
        const [library, setLibrary] = useState({ bookmarks: [], notes: [] })
        const [url, setUrl] = useState('')
        const [book, setBook] = useState('')
        const [chapter, setChapter] = useState('')
        const [excerpt, setExcerpt] = useState('')
        const [text, setText] = useState('')
        const [busy, setBusy] = useState(false)
        const [message, setMessage] = useState('')

        function openBrowser(url) {
          const existing = chapterGuests(ctx, sessionId).find(guest => guest.url === url)
          if (existing) ctx.sidebarRight.focus(existing.id)
          else ctx.sidebarRight.openTab('browser', { params: { url } })
        }

        useEffect(() => {
          if (!tab.visible) return
          const controller = new AbortController()
          requestLibrary(null, controller.signal).then(
            data => { if (!controller.signal.aborted) setLibrary(data) },
            error => { if (!controller.signal.aborted) setMessage(error.message) }
          )
          return () => controller.abort()
        }, [tab.visible])

        function source() {
          const clean = chapterUrl(url)
          if (!clean) throw new Error('请输入起点或番茄的官方章节链接')
          return { url: clean, book: book.trim(), chapter: chapter.trim() }
        }

        async function capture() {
          const target = currentGuest(ctx, sessionId, chapterUrl(url))
          const { book: title, chapter: name } = chapterTitle(target.view.getTitle())
          setUrl(target.url)
          setBook(title)
          setChapter(name)
          if (target.url !== chapterUrl(url)) setExcerpt('')
          try {
            // Run only on an explicit click, and read only the browser's current selection.
            const selection = await target.view.executeJavaScript(
              'location.origin + location.pathname === ' + JSON.stringify(target.url) +
              ' ? String(window.getSelection() ?? "").trim().slice(0, 600) : ""'
            )
            if (typeof selection === 'string' && selection && !/[\uE000-\uF8FF]/u.test(selection)) {
              setExcerpt(selection)
              setMessage('已带入章节和选段，请核对后使用')
              return
            }
          } catch {
            // The official browser or site may disallow programmatic selection.
          }
          setMessage('已带入章节。可以在原网页选中正文后再试，或把摘录粘贴到下方')
        }

        async function run(action) {
          setBusy(true)
          setMessage('')
          try {
            await action()
          } catch (error) {
            setMessage(error.message)
          } finally {
            setBusy(false)
          }
        }

        async function save(kind) {
          const current = source()
          if (!current.book) throw new Error('请补充书名')
          if (kind === 'note' && !excerpt.trim() && !text.trim()) throw new Error('请输入笔记或粘贴摘录')
          setLibrary(await requestLibrary({ ...current, kind, excerpt, note: text }))
          if (kind === 'note') setText('')
          setMessage(kind === 'note' ? '笔记已保存' : '已记录本章的续读位置')
        }

        function reopen(entry) {
          const url = chapterUrl(entry.url)
          if (!url) throw new Error('保存的章节链接无效')
          openBrowser(url)
        }

        const button = (label, action) => h('button', { type: 'button', disabled: busy, onClick: () => void run(action) }, label)
        const row = (...items) => h('div', { className: 'novel-row' }, ...items)
        const field = (label, value, set, options) => h('label', null, label,
          h(options.rows ? 'textarea' : 'input', { ...options, value, onChange: event => set(event.target.value) }))

        return h('section', { className: 'dsh-novel', 'aria-label': '小说阅读' },
          h('style', null, styles),
          h('h2', null, '小说阅读'),
          row(button('起点官网', () => openBrowser(startPages.起点)), button('番茄官网', () => openBrowser(startPages.番茄))),
          h('small', null, '在官网登录与阅读。打开章节后回到这里引用或保存。'),
          row(button('引用当前章', capture), button('打开下方链接', () => openBrowser(source().url))),
          field('官方章节链接', url, setUrl, { placeholder: 'https://…', maxLength: 2048 }),
          field('书名', book, setBook, { placeholder: '从网页带入，也可以手动填写', maxLength: 120 }),
          field('章节', chapter, setChapter, { maxLength: 180 }),
          field('摘录', excerpt, setExcerpt, { placeholder: '可选，也可以粘贴选段', maxLength: 600, rows: 2 }),
          field('问题或笔记', text, setText, { placeholder: '写下你的问题或想法', maxLength: 4000, rows: 3 }),
          row(
            button('填入提问草稿', () => {
              if (!text.trim() && !excerpt.trim()) throw new Error('请输入问题或粘贴摘录')
              addQuestion(ctx, sessionId, source(), excerpt.trim(), text.trim())
              setMessage('已填入当前会话草稿')
            }),
            button('记为续读', () => save('bookmark')),
            button('保存笔记', () => save('note'))
          ),
          h('p', { role: 'status' }, message),
          h('h3', null, '继续阅读'),
          ...library.bookmarks.map(entry => h('article', { key: entry.id },
            h('strong', null, entry.book),
            row(button('续读 ' + (entry.chapter || entry.site), () => reopen(entry)))
          )),
          h('h3', null, '本地笔记'),
          library.notes.length > 0 && row(button('导出 Markdown', () => exportMarkdown(library.notes))),
          ...library.notes.map(entry => h('article', { key: entry.id },
            h('strong', null, [entry.book, entry.chapter].filter(Boolean).join(' · ')),
            entry.excerpt && h('p', null, entry.excerpt),
            entry.note && h('p', null, entry.note),
            row(button('打开出处', () => reopen(entry)))
          ))
        )
      }

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: tabId,
        kind,
        title: () => '小说阅读',
        keepMounted: true,
        guide: [{ id: kind, order: 36, title: () => '小说阅读', description: () => '起点、番茄与阅读笔记', icon: BookIcon }]
      }), 'novel-reader: tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ReadingPane)
      ), 'novel-reader: body')
      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: tabId, order: 36 }, () =>
          h('button', {
            type: 'button', title: '小说阅读', 'aria-label': '小说阅读', onClick: openReader,
            style: { display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'inherit', padding: 6, cursor: 'pointer' }
          }, h(BookIcon))
        )
      ), 'novel-reader: conversation entry')
    }

    return { inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiSession'], apply }
  }
})
