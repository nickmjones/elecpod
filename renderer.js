const state = {
  store: { subscriptions: [], folders: [], playlists: [] },
  episodeCache: new Map(),
  view: { kind: 'podcasts' },
  player: { episode: null, source: null },
  searchDebounce: null,
  viewHistory: [],
  refreshing: false,
  incomingFilter: '7d',
  podcastSort: 'newest',
  discoverCache: null,
  blacklistDefaults: [],
  selection: { context: null, indices: new Set(), anchor: null },
  folderEdit: null,
  playlistEdit: null
}

const PODCAST_SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'longest', label: 'Longest first' },
  { id: 'shortest', label: 'Shortest first' },
  { id: 'title-az', label: 'Title A → Z' },
  { id: 'title-za', label: 'Title Z → A' }
]

function durationSeconds (s) {
  if (!s) return 0
  const str = String(s).trim()
  if (/^\d+$/.test(str)) return parseInt(str, 10)
  const parts = str.split(':').map(p => parseInt(p, 10) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function sortEpisodes (episodes, sortId) {
  const indexed = episodes.map((ep, i) => ({ ep, i }))
  const cmpDate = (a, b) => (new Date(a.ep.pubDate || 0)) - (new Date(b.ep.pubDate || 0))
  const cmpTitle = (a, b) => String(a.ep.title || '').localeCompare(String(b.ep.title || ''), undefined, { sensitivity: 'base' })
  const cmpDur = (a, b) => durationSeconds(a.ep.duration) - durationSeconds(b.ep.duration)
  switch (sortId) {
    case 'oldest':   indexed.sort(cmpDate); break
    case 'title-az': indexed.sort(cmpTitle); break
    case 'title-za': indexed.sort((a, b) => -cmpTitle(a, b)); break
    case 'longest':  indexed.sort((a, b) => -cmpDur(a, b)); break
    case 'shortest': indexed.sort(cmpDur); break
    case 'newest':
    default:         indexed.sort((a, b) => -cmpDate(a, b))
  }
  return indexed
}

let currentDrag = null

const INCOMING_FILTERS = [
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '90d', label: 'Last 90 days', ms: 90 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: null }
]

const els = {
  search: document.getElementById('search-input'),
  nav: document.getElementById('sidebar'),
  foldersList: document.getElementById('folders-list'),
  playlistsList: document.getElementById('playlists-list'),
  newFolder: document.getElementById('new-folder-btn'),
  newPlaylist: document.getElementById('new-playlist-btn'),
  refresh: document.getElementById('refresh-btn'),
  view: document.getElementById('view'),
  audio: document.getElementById('audio'),
  npTitle: document.getElementById('np-title'),
  npPodcast: document.getElementById('np-podcast'),
  npArt: document.getElementById('np-art'),
  pcPlay: document.getElementById('pc-play'),
  pcSkipBack: document.getElementById('pc-skip-back'),
  pcSkipFwd: document.getElementById('pc-skip-fwd'),
  pcSeek: document.getElementById('pc-seek'),
  pcCur: document.getElementById('pc-cur'),
  pcDur: document.getElementById('pc-dur'),
  pcMute: document.getElementById('pc-mute'),
  pcVol: document.getElementById('pc-vol'),
  selBar: document.getElementById('selection-bar'),
  selCount: document.querySelector('#selection-bar .sel-count')
}

const uid = () => Math.random().toString(36).slice(2, 10)

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))

function btn (opts = {}) {
  const {
    label = '',
    icon,
    iconFill = false,
    variant = 'default',
    size = 'md',
    iconOnly = !label,
    pill = false,
    active = false,
    disabled = false,
    type = 'button',
    extraClass = '',
    ...attrs
  } = opts
  const classes = ['btn', `btn-${variant}`]
  if (size !== 'md') classes.push(`btn-${size}`)
  if (iconOnly) classes.push('btn-icon')
  if (pill) classes.push('btn-pill')
  if (active) classes.push('btn-active')
  if (extraClass) classes.push(extraClass)
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
    .join(' ')
  const iconHtml = icon
    ? `<span class="mi${iconFill ? ' mi-fill' : ''}">${escapeHtml(icon)}</span>`
    : ''
  const labelHtml = iconOnly || !label ? '' : `<span>${escapeHtml(label)}</span>`
  return `<button type="${type}" class="${classes.join(' ')}"${disabled ? ' disabled' : ''} ${attrStr}>${iconHtml}${labelHtml}</button>`
}

function fmtDate (s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtDuration (s) {
  if (!s) return ''
  if (/^\d+$/.test(String(s))) {
    const n = parseInt(s, 10)
    const h = Math.floor(n / 3600)
    const m = Math.floor((n % 3600) / 60)
    return h ? `${h}h ${m}m` : `${m}m`
  }
  return String(s)
}

async function persist () {
  state.store = await window.api.saveStore(state.store)
  renderSidebar()
}

const ROOT_VIEWS = new Set(['podcasts', 'incoming', 'discover', 'in-progress', 'favorites', 'settings', 'folder', 'playlist'])

function setView (view, { push = true } = {}) {
  if (push && state.view && state.view.kind && state.view.kind !== 'loading' && state.view.kind !== 'error') {
    state.viewHistory.push(state.view)
    if (state.viewHistory.length > 30) state.viewHistory.shift()
  }
  state.view = view
  clearSelection()
  updateSelectionBar()
  renderView()
  renderSidebar()
}

function goBack () {
  if (!state.viewHistory.length) return
  const prev = state.viewHistory.pop()
  setView(prev, { push: false })
}

function backBarHtml () {
  if (ROOT_VIEWS.has(state.view.kind)) return ''
  if (!state.viewHistory.length) return ''
  return `<div class="subview-bar">${btn({ icon: 'arrow_back', label: 'Back', variant: 'ghost', 'data-act': 'back', title: 'Back' })}</div>`
}

// ------- Modals -------

function makeModal (innerHtml, onMount) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `<div class="modal">${innerHtml}</div>`
    const done = (r) => {
      window.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(r)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null) } }
    window.addEventListener('keydown', onKey, true)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null) })
    document.body.appendChild(overlay)
    onMount(overlay, done)
  })
}

function promptText (message, defaultValue = '') {
  return makeModal(`
    <div class="modal-msg"></div>
    <input class="modal-input" type="text" />
    <div class="modal-actions">
      ${btn({ label: 'Cancel', variant: 'default', extraClass: 'modal-cancel' })}
      ${btn({ label: 'OK', variant: 'primary', extraClass: 'modal-ok' })}
    </div>
  `, (o, done) => {
    o.querySelector('.modal-msg').textContent = message
    const input = o.querySelector('.modal-input')
    input.value = defaultValue
    o.querySelector('.modal-cancel').addEventListener('click', () => done(null))
    o.querySelector('.modal-ok').addEventListener('click', () => done(input.value))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(input.value) } })
    setTimeout(() => { input.focus(); input.select() }, 0)
  })
}

function confirmAction (message) {
  return makeModal(`
    <div class="modal-msg"></div>
    <div class="modal-actions">
      ${btn({ label: 'Cancel', variant: 'default', extraClass: 'modal-cancel' })}
      ${btn({ label: 'OK', variant: 'primary', extraClass: 'modal-ok' })}
    </div>
  `, (o, done) => {
    o.querySelector('.modal-msg').textContent = message
    o.querySelector('.modal-cancel').addEventListener('click', () => done(false))
    const ok = o.querySelector('.modal-ok')
    ok.addEventListener('click', () => done(true))
    setTimeout(() => ok.focus(), 0)
  })
}

function pickFromList (title, items, allowNew = null) {
  // items: [{ id, label }]; allowNew: { label, prompt } or null
  return makeModal(`
    <div class="modal-msg"></div>
    <div class="menu-list"></div>
    <div class="modal-actions">
      ${btn({ label: 'Cancel', variant: 'default', extraClass: 'modal-cancel' })}
    </div>
  `, (o, done) => {
    o.querySelector('.modal-msg').textContent = title
    const list = o.querySelector('.menu-list')
    list.innerHTML = [
      ...items.map(i => `<div class="menu-row" data-id="${escapeHtml(i.id)}">${escapeHtml(i.label)}</div>`),
      ...(allowNew ? [`<div class="menu-row divider" data-act="new">${escapeHtml(allowNew.label)}</div>`] : [])
    ].join('') || '<div class="muted-empty">No options</div>'
    list.addEventListener('click', async (e) => {
      const row = e.target.closest('.menu-row')
      if (!row) return
      if (row.dataset.act === 'new') {
        const name = await promptText(allowNew.prompt)
        if (name && name.trim()) done({ newName: name.trim() })
        else done(null)
      } else {
        done({ id: row.dataset.id })
      }
    })
    o.querySelector('.modal-cancel').addEventListener('click', () => done(null))
  })
}

// ------- Skip helpers -------

function isSkipped (audioUrl) {
  return !!audioUrl && (state.store.skippedEpisodes || []).includes(audioUrl)
}

async function toggleSkip (audioUrl) {
  if (!audioUrl) return
  state.store.skippedEpisodes ||= []
  const i = state.store.skippedEpisodes.indexOf(audioUrl)
  if (i >= 0) state.store.skippedEpisodes.splice(i, 1)
  else state.store.skippedEpisodes.push(audioUrl)
  await persist()
}

// ------- Episode row menu -------

function resolveEpisodeAt (context, idx) {
  if (context === 'podcast' && state.view.kind === 'podcast') {
    const v = state.view
    const ep = v.feed.episodes[idx]
    return ep && { ...ep, feedUrl: v.feedUrl, podcastTitle: v.feed.title, podcastImage: v.feed.imageUrl }
  }
  if (context === 'incoming') return allCachedEpisodes()[idx] || null
  return null
}

async function openEpisodeMenu (triggerEl) {
  const ctx = triggerEl.dataset.context
  const idx = parseInt(triggerEl.dataset.idx, 10)
  const ep = resolveEpisodeAt(ctx, idx)
  if (!ep) return
  const skipped = isSkipped(ep.audioUrl)
  const items = [
    { id: 'add', label: 'Add to playlist…' },
    { id: 'skip', label: skipped ? 'Unskip episode' : 'Skip this episode' }
  ]
  const rect = triggerEl.getBoundingClientRect()
  const chosen = await window.api.showCardMenu({ items, x: rect.left, y: rect.bottom })
  if (chosen === 'add') {
    await addEpisodeToPlaylistFlow(ep)
  } else if (chosen === 'skip') {
    await toggleSkip(ep.audioUrl)
    renderView()
  }
}

// ------- Card dropdown menu -------

async function openCardMenu (triggerEl, feedUrl) {
  const sub = state.store.subscriptions.find(s => s.feedUrl === feedUrl)
  if (!sub) return

  const items = [{ id: 'unsubscribe', label: 'Unsubscribe' }]
  const rect = triggerEl.getBoundingClientRect()
  const chosen = await window.api.showCardMenu({
    items,
    x: rect.left,
    y: rect.bottom
  })

  if (chosen === 'unsubscribe') {
    if (!(await confirmAction(`Unsubscribe from "${sub.title}"?`))) return
    state.store.subscriptions = state.store.subscriptions.filter(s => s.feedUrl !== feedUrl)
    await persist()
    renderView()
  }
}

// ------- Multiselect -------

function clearSelection () {
  state.selection = { context: null, indices: new Set(), anchor: null }
}

function rowSelectedClass (context, i) {
  return state.selection.context === context && state.selection.indices.has(i) ? ' selected' : ''
}

function updateSelectionBar () {
  const n = state.selection.indices.size
  if (!els.selBar) return
  if (n === 0) {
    els.selBar.setAttribute('data-hidden', 'true')
    els.selBar.setAttribute('aria-hidden', 'true')
    return
  }
  els.selCount.textContent = `${n} selected`
  els.selBar.setAttribute('data-hidden', 'false')
  els.selBar.setAttribute('aria-hidden', 'false')
  const skipBtn = els.selBar.querySelector('[data-act="sel-skip"]')
  if (skipBtn) {
    const urls = resolveSelectionEpisodes().map(e => e.audioUrl).filter(Boolean)
    const allSkipped = urls.length > 0 && urls.every(u => isSkipped(u))
    skipBtn.title = allSkipped ? 'Unskip selected' : 'Skip selected'
  }
}

function measureSelectionBar () {
  if (!els.selBar) return
  const wasHidden = els.selBar.getAttribute('data-hidden') === 'true'
  if (wasHidden) {
    els.selBar.style.visibility = 'hidden'
    els.selBar.setAttribute('data-hidden', 'false')
  }
  const h = els.selBar.offsetHeight
  if (wasHidden) {
    els.selBar.setAttribute('data-hidden', 'true')
    els.selBar.style.visibility = ''
  }
  if (h > 0) document.documentElement.style.setProperty('--sel-bar-h', `${h + 24}px`)
}

function handleEpisodeSelectClick (rowEl, e) {
  if (e.target.closest('button') || e.target.closest('a')) return
  const ctx = rowEl.dataset.context
  const idx = parseInt(rowEl.dataset.idx, 10)
  if (!ctx || isNaN(idx)) return
  const isRange = e.shiftKey && state.selection.context === ctx && state.selection.anchor != null
  const isToggle = e.metaKey || e.ctrlKey
  if (!isRange && !isToggle) {
    openEpisodePage(rowEl)
    return
  }
  e.preventDefault()
  if (window.getSelection) try { window.getSelection().removeAllRanges() } catch {}
  if (isRange) {
    const a = state.selection.anchor
    const [lo, hi] = a < idx ? [a, idx] : [idx, a]
    const next = new Set(state.selection.indices)
    for (let i = lo; i <= hi; i++) next.add(i)
    state.selection.indices = next
  } else {
    if (state.selection.context !== ctx) {
      state.selection = { context: ctx, indices: new Set([idx]), anchor: idx }
    } else {
      if (state.selection.indices.has(idx)) state.selection.indices.delete(idx)
      else state.selection.indices.add(idx)
      state.selection.anchor = idx
    }
  }
  renderView()
  updateSelectionBar()
}

function resolveSelectionEpisodes () {
  const { context, indices } = state.selection
  const arr = [...indices].sort((a, b) => a - b)
  if (context === 'podcast' && state.view.kind === 'podcast') {
    const v = state.view
    return arr.map(i => {
      const ep = v.feed.episodes[i]
      return ep && { ...ep, feedUrl: v.feedUrl, podcastTitle: v.feed.title, podcastImage: v.feed.imageUrl }
    }).filter(Boolean)
  }
  if (context === 'incoming') {
    const all = allCachedEpisodes()
    return arr.map(i => all[i]).filter(Boolean)
  }
  if (context === 'favorites') {
    const sorted = (state.store.favorites || []).slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0))
    return arr.map(i => sorted[i]).filter(Boolean)
  }
  if (context === 'in-progress') {
    const sorted = (state.store.inProgress || []).slice().sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    return arr.map(i => sorted[i]).filter(Boolean)
  }
  return []
}

async function bulkAddToPlaylist (episodes) {
  if (!episodes.length) return
  const choice = await pickFromList(
    `Add ${episodes.length} episode${episodes.length === 1 ? '' : 's'} to playlist`,
    state.store.playlists.map(p => ({ id: p.id, label: p.name })),
    { label: '+ New playlist…', prompt: 'New playlist name' }
  )
  if (!choice) return
  let pl
  if (choice.newName) {
    pl = { id: uid(), name: choice.newName, items: [] }
    state.store.playlists.push(pl)
  } else {
    pl = state.store.playlists.find(p => p.id === choice.id)
  }
  if (!pl) return
  for (const ep of episodes) {
    if (!pl.items.some(x => x.audioUrl === ep.audioUrl)) {
      pl.items.push({
        audioUrl: ep.audioUrl,
        title: ep.title,
        pubDate: ep.pubDate,
        duration: ep.duration,
        guid: ep.guid,
        feedUrl: ep.feedUrl,
        podcastTitle: ep.podcastTitle,
        podcastImage: ep.podcastImage
      })
    }
  }
  await persist()
  clearSelection()
  updateSelectionBar()
  renderView()
}

// ------- Sidebar -------

function renderSidebar () {
  const v = state.view
  // Top-level nav-item active states
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === v.kind)
  })

  els.foldersList.innerHTML = state.store.folders.map(f => {
    if (state.folderEdit && state.folderEdit.id === f.id) {
      return `
    <div class="nav-row" data-folder="${f.id}" data-editing="true">
      <span class="mi row-icon">folder</span>
      <input class="row-edit" type="text" value="${escapeHtml(f.name)}" />
    </div>
      `
    }
    return `
    <div class="nav-row${v.kind === 'folder' && v.folderId === f.id ? ' active' : ''}" data-folder="${f.id}">
      <span class="mi row-icon">folder</span>
      <span class="row-label">${escapeHtml(f.name)}</span>
    </div>
    `
  }).join('') || '<div class="muted-empty">No folders</div>'

  els.playlistsList.innerHTML = state.store.playlists.map(p => {
    if (state.playlistEdit && state.playlistEdit.id === p.id) {
      return `
    <div class="nav-row" data-playlist="${p.id}" data-editing="true">
      <span class="mi row-icon">playlist_play</span>
      <input class="row-edit" type="text" value="${escapeHtml(p.name)}" />
    </div>
      `
    }
    return `
    <div class="nav-row${v.kind === 'playlist' && v.playlistId === p.id ? ' active' : ''}" data-playlist="${p.id}">
      <span class="mi row-icon">playlist_play</span>
      <span class="row-label">${escapeHtml(p.name)}</span>
      <span class="row-pill" title="${p.items.length} episode${p.items.length === 1 ? '' : 's'}">${p.items.length}</span>
    </div>
    `
  }).join('') || '<div class="muted-empty">No playlists</div>'
}

function focusFolderEditInput () {
  const input = els.foldersList.querySelector('.row-edit')
  if (input) { input.focus(); input.select() }
}

function startNewFolder () {
  const f = { id: uid(), name: '' }
  state.store.folders.push(f)
  state.folderEdit = { id: f.id, originalName: '' }
  renderSidebar()
  focusFolderEditInput()
}

function startRenameFolder (id) {
  const f = state.store.folders.find(x => x.id === id)
  if (!f) return
  state.folderEdit = { id, originalName: f.name }
  renderSidebar()
  focusFolderEditInput()
}

async function commitFolderEdit (value) {
  if (!state.folderEdit) return
  const { id, originalName } = state.folderEdit
  const name = value.trim()
  state.folderEdit = null
  const f = state.store.folders.find(x => x.id === id)
  if (!f) return
  if (!name) {
    if (!originalName) {
      state.store.folders = state.store.folders.filter(x => x.id !== id)
      await persist()
    } else {
      renderSidebar()
    }
    return
  }
  if (name === originalName) { renderSidebar(); return }
  f.name = name
  await persist()
}

async function cancelFolderEdit () {
  if (!state.folderEdit) return
  const { id, originalName } = state.folderEdit
  state.folderEdit = null
  if (!originalName) {
    state.store.folders = state.store.folders.filter(x => x.id !== id)
    await persist()
  } else {
    renderSidebar()
  }
}

function focusPlaylistEditInput () {
  const input = els.playlistsList.querySelector('.row-edit')
  if (input) { input.focus(); input.select() }
}

function startNewPlaylist () {
  const p = { id: uid(), name: '', items: [] }
  state.store.playlists.push(p)
  state.playlistEdit = { id: p.id, originalName: '' }
  renderSidebar()
  focusPlaylistEditInput()
}

function startRenamePlaylist (id) {
  const p = state.store.playlists.find(x => x.id === id)
  if (!p) return
  state.playlistEdit = { id, originalName: p.name }
  renderSidebar()
  focusPlaylistEditInput()
}

async function commitPlaylistEdit (value) {
  if (!state.playlistEdit) return
  const { id, originalName } = state.playlistEdit
  const name = value.trim()
  state.playlistEdit = null
  const p = state.store.playlists.find(x => x.id === id)
  if (!p) return
  if (!name) {
    if (!originalName) {
      state.store.playlists = state.store.playlists.filter(x => x.id !== id)
      await persist()
    } else {
      renderSidebar()
    }
    return
  }
  const wasNew = !originalName
  if (name === originalName) { renderSidebar(); return }
  p.name = name
  await persist()
  if (wasNew) setView({ kind: 'playlist', playlistId: id })
}

async function cancelPlaylistEdit () {
  if (!state.playlistEdit) return
  const { id, originalName } = state.playlistEdit
  state.playlistEdit = null
  if (!originalName) {
    state.store.playlists = state.store.playlists.filter(x => x.id !== id)
    await persist()
  } else {
    renderSidebar()
  }
}

// ------- Views -------

function renderView () {
  const v = state.view
  switch (v.kind) {
    case 'podcasts': return renderPodcastsGallery(state.store.subscriptions, 'Podcasts')
    case 'folder': {
      const f = state.store.folders.find(x => x.id === v.folderId)
      if (!f) { setView({ kind: 'podcasts' }); return }
      return renderPodcastsGallery(state.store.subscriptions.filter(s => s.folderId === f.id), f.name)
    }
    case 'incoming': return renderIncoming()
    case 'discover': return renderDiscover()
    case 'in-progress': return renderInProgress()
    case 'favorites': return renderFavorites()
    case 'settings': return renderSettings()
    case 'playlist': return renderPlaylistView(v.playlistId)
    case 'podcast': return renderPodcast(v)
    case 'podcast-loading': return renderPodcastSkeleton(v)
    case 'episode': return renderEpisode(v)
    case 'search': return renderSearch(v.term, v.results)
    case 'loading': els.view.innerHTML = `<div class="loading">Loading…</div>`; return
    case 'error': els.view.innerHTML = `${backBarHtml()}<div class="empty-state">Error: ${escapeHtml(v.message)}</div>`; return
    default: els.view.innerHTML = `<div class="empty-state">Pick something.</div>`
  }
}

function lastUpdated (feedUrl) {
  const cached = state.episodeCache.get(feedUrl)
  if (!cached || !cached.episodes?.length) return ''
  let max = 0
  for (const ep of cached.episodes) {
    const t = ep.pubDate ? new Date(ep.pubDate).getTime() : 0
    if (t > max) max = t
  }
  return max ? fmtDate(max) : ''
}

function renderPodcastsGallery (subs, title) {
  if (!subs.length) {
    els.view.innerHTML = `
      <div class="view-header"><h1>${escapeHtml(title)}</h1></div>
      <div class="empty-state">Nothing here yet. Search or paste a feed URL.</div>
    `
    return
  }
  els.view.innerHTML = `
    <div class="view-header"><h1>${escapeHtml(title)}</h1></div>
    <div class="gallery">
      ${subs.map(s => {
        const updated = lastUpdated(s.feedUrl)
        return `
        <div class="gallery-card" draggable="true" data-drag="sub" data-feed="${escapeHtml(s.feedUrl)}">
          ${btn({ icon: 'more_horiz', iconOnly: true, variant: 'ghost', title: 'More', extraClass: 'card-kebab', 'data-act': 'card-menu', 'data-feed': s.feedUrl })}
          <img src="${escapeHtml(s.imageUrl || '')}" alt="" />
          <div class="title">${escapeHtml(s.title)}</div>
          ${updated ? `<div class="updated">Updated ${escapeHtml(updated)}</div>` : ''}
        </div>
        `
      }).join('')}
    </div>
  `
}

function allCachedEpisodes (filterId = state.incomingFilter) {
  const filter = INCOMING_FILTERS.find(f => f.id === filterId) || INCOMING_FILTERS[1]
  const cutoff = filter.ms ? Date.now() - filter.ms : null
  const out = []
  for (const sub of state.store.subscriptions) {
    const cached = state.episodeCache.get(sub.feedUrl)
    if (!cached) continue
    for (const ep of cached.episodes) {
      const t = ep.pubDate ? new Date(ep.pubDate).getTime() : 0
      if (cutoff && t < cutoff) continue
      if (isSkipped(ep.audioUrl)) continue
      out.push({
        ...ep,
        feedUrl: sub.feedUrl,
        podcastTitle: cached.title || sub.title,
        podcastImage: cached.imageUrl || sub.imageUrl
      })
    }
  }
  out.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
  return filter.ms ? out : out.slice(0, 500)
}

function renderIncoming () {
  const episodes = allCachedEpisodes()
  const status = state.refreshing
    ? 'Refreshing…'
    : (episodes.length ? `${episodes.length} episodes` : 'Nothing in this window.')
  const options = INCOMING_FILTERS.map(f =>
    `<option value="${f.id}"${f.id === state.incomingFilter ? ' selected' : ''}>${escapeHtml(f.label)}</option>`
  ).join('')
  els.view.innerHTML = `
    <div class="view-header">
      <h1>Incoming</h1>
      <div class="actions">
        <select id="incoming-filter">${options}</select>
        <span class="status-label">${escapeHtml(status)}</span>
        ${btn({ label: 'Refresh', variant: 'default', 'data-act': 'refresh-all' })}
      </div>
    </div>
    <div class="episodes">
      ${episodes.map((e, i) => incomingRow(e, i)).join('')}
    </div>
  `
  const sel = document.getElementById('incoming-filter')
  sel.addEventListener('change', () => {
    state.incomingFilter = sel.value
    renderIncoming()
  })
}

function incomingRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  return `
    <div class="episode${rowSelectedClass('incoming', i)}" draggable="true" data-drag="ep" data-context="incoming" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play-incoming" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="ep-podcast">${escapeHtml(e.podcastTitle || '')}</div>
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)}${e.duration ? ' · ' + escapeHtml(fmtDuration(e.duration)) : ''}</div>
        <div class="desc">${escapeHtml(e.description)}</div>
      </div>
      ${e.audioUrl ? favBtnHtml(e.audioUrl) : ''}
      ${btn({ icon: 'more_vert', iconOnly: true, variant: 'ghost', size: 'sm', title: 'More', 'data-act': 'ep-menu', 'data-context': 'incoming', 'data-idx': i })}
    </div>
  `
}

function renderPodcastSkeleton (v) {
  const hint = v.hint || {}
  const sub = state.store.subscriptions.find(s => s.feedUrl === v.feedUrl)
  const title = hint.title || sub?.title || ''
  const imageUrl = hint.imageUrl || sub?.imageUrl || ''
  els.view.innerHTML = `
    ${backBarHtml()}
    <div class="podcast-header">
      ${imageUrl
        ? `<img src="${escapeHtml(imageUrl)}" alt="" />`
        : `<div class="skel skel-art"></div>`}
      <div class="meta">
        ${title
          ? `<h1>${escapeHtml(title)}</h1>`
          : `<div class="skel skel-title"></div>`}
        <div class="skel skel-line"></div>
        <div class="skel skel-line skel-line-short"></div>
        <div class="actions"><div class="skel skel-btn"></div></div>
      </div>
    </div>
    <div class="episodes">
      ${Array.from({ length: 5 }, () => `
        <div class="episode skel-episode">
          <div class="skel skel-circle"></div>
          <div class="episode-info">
            <div class="skel skel-line skel-line-short"></div>
            <div class="skel skel-line"></div>
            <div class="skel skel-line skel-line-tiny"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

function renderPodcast (v) {
  const { feedUrl, feed } = v
  const sub = state.store.subscriptions.find(s => s.feedUrl === feedUrl)
  const subscribed = !!sub

  const subscribeBtn = subscribed
    ? btn({ label: 'Unsubscribe', variant: 'default', 'data-act': 'unsubscribe' })
    : btn({ label: 'Subscribe', variant: 'primary', 'data-act': 'subscribe' })

  const sortOptions = PODCAST_SORTS.map(s =>
    `<option value="${s.id}"${s.id === state.podcastSort ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
  ).join('')

  const sorted = sortEpisodes(feed.episodes, state.podcastSort)

  els.view.innerHTML = `
    ${backBarHtml()}
    <div class="podcast-header">
      <img src="${escapeHtml(feed.imageUrl || sub?.imageUrl || '')}" alt="" />
      <div class="meta">
        <h1>${escapeHtml(feed.title || sub?.title || '')}</h1>
        <p>${escapeHtml((feed.description || '').slice(0, 400))}</p>
        <div class="actions">
          ${subscribeBtn}
          <select id="podcast-sort" title="Sort episodes">${sortOptions}</select>
        </div>
      </div>
    </div>
    <div class="episodes">
      ${sorted.map(({ ep, i }) => episodeRow(ep, i)).join('')}
    </div>
  `
  const sel = document.getElementById('podcast-sort')
  if (sel) sel.addEventListener('change', () => {
    state.podcastSort = sel.value
    renderView()
  })
}

function episodeRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  const skipped = isSkipped(e.audioUrl)
  return `
    <div class="episode${rowSelectedClass('podcast', i)}${skipped ? ' skipped' : ''}" draggable="true" data-drag="ep" data-context="podcast" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="title">${escapeHtml(e.title || 'Untitled')}${skipped ? ' <span class="skip-tag">skipped</span>' : ''}</div>
        <div class="meta">${fmtDate(e.pubDate)}${e.duration ? ' · ' + escapeHtml(fmtDuration(e.duration)) : ''}</div>
        <div class="desc">${escapeHtml(e.description)}</div>
      </div>
      ${e.audioUrl ? favBtnHtml(e.audioUrl) : ''}
      ${btn({ icon: 'more_vert', iconOnly: true, variant: 'ghost', size: 'sm', title: 'More', 'data-act': 'ep-menu', 'data-context': 'podcast', 'data-idx': i })}
    </div>
  `
}

function renderPlaylistView (playlistId) {
  const pl = state.store.playlists.find(p => p.id === playlistId)
  if (!pl) { setView({ kind: 'podcasts' }); return }
  const currentIdx = state.player.source?.kind === 'playlist' && state.player.source.playlistId === pl.id
    ? state.player.source.index : -1
  els.view.innerHTML = `
    <div class="view-header">
      <h1>${escapeHtml(pl.name)}</h1>
      <div class="actions">
        ${pl.items.length ? btn({ icon: 'play_arrow', iconFill: true, label: 'Play all', variant: 'primary', 'data-act': 'play-playlist' }) : ''}
      </div>
    </div>
    ${pl.items.length === 0
      ? `<div class="empty-state">Empty. Add episodes via the + button next to any episode.</div>`
      : `<div class="playlist">${pl.items.map((it, i) => playlistRow(it, i, i === currentIdx, pl.id)).join('')}</div>`}
  `
}

function playlistRow (item, i, playing, playlistId) {
  return `
    <div class="playlist-item${playing ? ' playing' : ''}" draggable="true" data-drag="pl-item" data-playlist-id="${playlistId}" data-idx="${i}">
      <span class="idx">${i + 1}</span>
      <img src="${escapeHtml(item.podcastImage || '')}" alt="" />
      <div class="info">
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="pod">${escapeHtml(item.podcastTitle || '')}</div>
      </div>
      <div class="ctrls">
        ${btn({ icon: 'play_arrow', iconFill: true, iconOnly: true, variant: 'ghost', size: 'sm', title: 'Play', 'data-act': 'pl-play', 'data-idx': i })}
        ${btn({ icon: 'arrow_upward', iconOnly: true, variant: 'ghost', size: 'sm', title: 'Move up', 'data-act': 'pl-up', 'data-idx': i })}
        ${btn({ icon: 'arrow_downward', iconOnly: true, variant: 'ghost', size: 'sm', title: 'Move down', 'data-act': 'pl-down', 'data-idx': i })}
        ${btn({ icon: 'close', iconOnly: true, variant: 'ghost', size: 'sm', title: 'Remove', 'data-act': 'pl-remove', 'data-idx': i })}
      </div>
    </div>
  `
}

async function renderDiscover () {
  if (!state.discoverCache) {
    els.view.innerHTML = `<div class="loading">Loading top podcasts…</div>`
    try {
      state.discoverCache = await window.api.discover()
    } catch (err) {
      els.view.innerHTML = `<div class="empty-state">Could not load Discover: ${escapeHtml(err.message)}</div>`
      return
    }
  }
  const subbed = new Set(state.store.subscriptions.map(s => s.feedUrl))
  const results = state.discoverCache.filter(p => !subbed.has(p.feedUrl))
  els.view.innerHTML = `
    <div class="view-header">
      <h1>Discover</h1>
      <div class="actions">
        <span class="status-label">Top podcasts in US, minus your subs</span>
        ${btn({ label: 'Refresh', variant: 'default', 'data-act': 'refresh-discover' })}
      </div>
    </div>
    <div class="gallery">
      ${results.map(r => searchCardHtml(r, subbed)).join('')}
    </div>
  `
}

function searchCardHtml (r, subbed) {
  const isSubbed = subbed.has(r.feedUrl)
  return `
    <div class="gallery-card" data-feed="${escapeHtml(r.feedUrl)}">
      ${btn({
        icon: isSubbed ? 'check' : 'add',
        iconOnly: true,
        variant: isSubbed ? 'primary' : 'default',
        title: isSubbed ? 'Unsubscribe' : 'Subscribe',
        extraClass: `subscribe-btn${isSubbed ? ' subscribed' : ''}`,
        'data-act': 'toggle-sub',
        'data-feed': r.feedUrl,
        'data-title': r.title,
        'data-img': r.imageUrl || ''
      })}
      <img src="${escapeHtml(r.imageUrl || '')}" alt="" />
      <div class="title">${escapeHtml(r.title)}</div>
      ${r.artist ? `<div class="artist">${escapeHtml(r.artist)}</div>` : ''}
    </div>
  `
}

// ------- Favorites -------

function isFavorited (audioUrl) {
  return (state.store.favorites || []).some(x => x.audioUrl === audioUrl)
}

async function addFavorite (ep) {
  state.store.favorites ||= []
  if (isFavorited(ep.audioUrl)) return
  state.store.favorites.push({
    audioUrl: ep.audioUrl,
    title: ep.title,
    pubDate: ep.pubDate,
    duration: ep.duration,
    guid: ep.guid,
    feedUrl: ep.feedUrl,
    podcastTitle: ep.podcastTitle,
    podcastImage: ep.podcastImage,
    favoritedAt: Date.now()
  })
  await persist()
}

async function removeFavorite (audioUrl) {
  if (!state.store.favorites) return
  const before = state.store.favorites.length
  state.store.favorites = state.store.favorites.filter(x => x.audioUrl !== audioUrl)
  if (state.store.favorites.length !== before) await persist()
}

async function toggleFavorite (ep) {
  if (isFavorited(ep.audioUrl)) await removeFavorite(ep.audioUrl)
  else await addFavorite(ep)
  if (state.view.kind === 'favorites') renderView()
  else {
    const favBtn = document.querySelector(`button[data-fav-url="${CSS.escape(ep.audioUrl)}"]`)
    if (favBtn) {
      const fav = isFavorited(ep.audioUrl)
      favBtn.classList.toggle('btn-active', fav)
      favBtn.title = fav ? 'Unfavorite' : 'Favorite'
      const mi = favBtn.querySelector('.mi')
      if (mi) mi.classList.toggle('mi-fill', fav)
    }
  }
}

function resolveEpisodeByUrl (audioUrl) {
  if (!audioUrl) return null
  const v = state.view
  if (v.kind === 'podcast') {
    const ep = v.feed.episodes.find(x => x.audioUrl === audioUrl)
    if (ep) return { ...ep, feedUrl: v.feedUrl, podcastTitle: v.feed.title, podcastImage: v.feed.imageUrl }
  }
  if (v.kind === 'incoming') {
    const ep = allCachedEpisodes().find(x => x.audioUrl === audioUrl)
    if (ep) return ep
  }
  const fav = (state.store.favorites || []).find(x => x.audioUrl === audioUrl)
  if (fav) return fav
  const ip = (state.store.inProgress || []).find(x => x.audioUrl === audioUrl)
  if (ip) return ip
  for (const pl of state.store.playlists) {
    const item = pl.items.find(x => x.audioUrl === audioUrl)
    if (item) return item
  }
  for (const [feedUrl, feed] of state.episodeCache) {
    const ep = feed.episodes.find(x => x.audioUrl === audioUrl)
    if (ep) return { ...ep, feedUrl, podcastTitle: feed.title, podcastImage: feed.imageUrl }
  }
  return null
}

function favBtnHtml (audioUrl) {
  const fav = isFavorited(audioUrl)
  return btn({
    icon: 'star',
    iconFill: fav,
    iconOnly: true,
    variant: 'fav',
    size: 'sm',
    active: fav,
    title: fav ? 'Unfavorite' : 'Favorite',
    'data-act': 'toggle-fav',
    'data-fav-url': audioUrl
  })
}

function renderFavorites () {
  const items = (state.store.favorites || [])
    .slice()
    .sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0))
  if (!items.length) {
    els.view.innerHTML = `
      <div class="view-header"><h1>Favorites</h1></div>
      <div class="empty-state">No favorites yet. Tap the star next to any episode to add it here.</div>
    `
    return
  }
  els.view.innerHTML = `
    <div class="view-header"><h1>Favorites</h1></div>
    <div class="episodes">
      ${items.map((e, i) => favoriteRow(e, i)).join('')}
    </div>
  `
}

function favoriteRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  return `
    <div class="episode${rowSelectedClass('favorites', i)}" data-context="favorites" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play-favorite" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="ep-podcast">${escapeHtml(e.podcastTitle || '')}</div>
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)}${e.duration ? ' · ' + escapeHtml(fmtDuration(e.duration)) : ''}</div>
      </div>
      ${favBtnHtml(e.audioUrl)}
    </div>
  `
}

function renderInProgress () {
  const items = (state.store.inProgress || [])
    .slice()
    .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
  if (!items.length) {
    els.view.innerHTML = `
      <div class="view-header"><h1>In Progress</h1></div>
      <div class="empty-state">Nothing in progress. Start playing an episode and pause it — it'll show up here.</div>
    `
    return
  }
  els.view.innerHTML = `
    <div class="view-header"><h1>In Progress</h1></div>
    <div class="episodes">
      ${items.map((e, i) => inProgressRow(e, i)).join('')}
    </div>
  `
  els.view.querySelectorAll('.progress-fill[data-pct]').forEach(el => {
    el.style.width = `${el.dataset.pct}%`
  })
}

function inProgressRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  const pct = e.durationSec > 0 ? Math.max(0, Math.min(100, (e.currentTime / e.durationSec) * 100)) : 0
  const remain = Math.max(0, (e.durationSec || 0) - (e.currentTime || 0))
  return `
    <div class="episode${rowSelectedClass('in-progress', i)}" data-context="in-progress" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play-in-progress" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="ep-podcast">${escapeHtml(e.podcastTitle || '')}</div>
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)} · ${fmtClock(e.currentTime)} / ${fmtClock(e.durationSec)} · ${fmtClock(remain)} left</div>
        <div class="progress-bar"><div class="progress-fill" data-pct="${pct.toFixed(1)}"></div></div>
      </div>
      ${favBtnHtml(e.audioUrl)}
      ${btn({ icon: 'close', iconOnly: true, variant: 'ghost', size: 'sm', title: 'Remove', 'data-act': 'remove-in-progress', 'data-idx': i })}
    </div>
  `
}

const AUTO_ADVANCE_MODES = [
  { id: 'newer', label: 'Play next-newer episode (chronological)' },
  { id: 'older', label: 'Play next-older episode (reverse chronological)' },
  { id: 'sort',  label: "Follow the podcast view's current sort" },
  { id: 'off',   label: 'Stop after the episode ends' }
]

function renderSettings () {
  const user = state.store.discoverBlacklist || []
  const defaults = state.blacklistDefaults
  const advanceMode = state.store.settings?.podcastAutoAdvance || 'newer'
  const advanceOptions = AUTO_ADVANCE_MODES.map(m =>
    `<option value="${m.id}"${m.id === advanceMode ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('')
  els.view.innerHTML = `
    <div class="view-header"><h1>Settings</h1></div>
    <section class="settings-section">
      <h2>Playback</h2>
      <label class="settings-row">
        <span class="settings-label">When a podcast episode ends</span>
        <select id="auto-advance-select">${advanceOptions}</select>
      </label>
      <p class="settings-help">Applies when you start playback from a podcast's episode list. Playlists always advance to the next item.</p>
    </section>
    <section class="settings-section">
      <h2>Discover blacklist</h2>
      <p class="settings-help">Podcasts whose title or author contains any of these keywords (case-insensitive) are hidden from Discover.</p>
      <h3>Built-in</h3>
      <div class="blacklist-tags">
        ${defaults.length
          ? defaults.map(t => `<span class="tag tag-locked">${escapeHtml(t)}</span>`).join('')
          : '<div class="muted-empty">None</div>'}
      </div>
      <h3>Your keywords</h3>
      <div class="blacklist-tags">
        ${user.length
          ? user.map((t, i) => `<span class="tag">${escapeHtml(t)}${btn({ icon: 'close', iconOnly: true, variant: 'ghost', size: 'sm', title: 'Remove', 'data-act': 'bl-remove', 'data-idx': i })}</span>`).join('')
          : '<div class="muted-empty">No custom keywords yet.</div>'}
      </div>
      <form class="blacklist-form" id="bl-form">
        <input type="text" id="bl-input" placeholder="Add keyword (e.g. crypto)" />
        ${btn({ label: 'Add', variant: 'primary', type: 'submit' })}
      </form>
    </section>
  `
  const advSel = document.getElementById('auto-advance-select')
  advSel.addEventListener('change', async () => {
    state.store.settings ||= {}
    state.store.settings.podcastAutoAdvance = advSel.value
    await persist()
  })
  const form = document.getElementById('bl-form')
  const input = document.getElementById('bl-input')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const term = input.value.trim().toLowerCase()
    if (!term) return
    state.store.discoverBlacklist ||= []
    if (!state.store.discoverBlacklist.includes(term)) {
      state.store.discoverBlacklist.push(term)
      state.discoverCache = null
      await persist()
    }
    renderSettings()
  })
}

function renderSearch (term, results) {
  if (!results.length) {
    els.view.innerHTML = `<div class="empty-state">No results for "${escapeHtml(term)}".</div>`
    return
  }
  const subbed = new Set(state.store.subscriptions.map(s => s.feedUrl))
  els.view.innerHTML = `
    ${backBarHtml()}
    <div class="view-header"><h1>Search: ${escapeHtml(term)}</h1></div>
    <div class="gallery">
      ${results.map(r => searchCardHtml(r, subbed)).join('')}
    </div>
  `
}

// ------- Episode page -------

function resolveEpisodeForPage (context, idx) {
  if (context === 'podcast' && state.view.kind === 'podcast') {
    const v = state.view
    const ep = v.feed.episodes[idx]
    return ep ? { feedUrl: v.feedUrl, guid: ep.guid } : null
  }
  if (context === 'incoming') {
    const ep = allCachedEpisodes()[idx]
    return ep ? { feedUrl: ep.feedUrl, guid: ep.guid } : null
  }
  if (context === 'favorites') {
    const sorted = (state.store.favorites || []).slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0))
    const ep = sorted[idx]
    return ep ? { feedUrl: ep.feedUrl, guid: ep.guid } : null
  }
  if (context === 'in-progress') {
    const sorted = (state.store.inProgress || []).slice().sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    const ep = sorted[idx]
    return ep ? { feedUrl: ep.feedUrl, guid: ep.guid } : null
  }
  return null
}

function openEpisodePage (rowEl) {
  const ctx = rowEl.dataset.context
  const idx = parseInt(rowEl.dataset.idx, 10)
  const ref = resolveEpisodeForPage(ctx, idx)
  if (!ref || !ref.feedUrl || !ref.guid) return
  setView({ kind: 'episode', feedUrl: ref.feedUrl, guid: ref.guid })
}

async function renderEpisode (v) {
  let feed = state.episodeCache.get(v.feedUrl)
  if (!feed) {
    els.view.innerHTML = `${backBarHtml()}<div class="loading">Loading episode…</div>`
    try {
      feed = await window.api.fetchFeed(v.feedUrl)
      state.episodeCache.set(feed.feedUrl, { fetchedAt: Date.now(), ...feed })
    } catch (err) {
      els.view.innerHTML = `${backBarHtml()}<div class="empty-state">Couldn't load episode: ${escapeHtml(err.message)}</div>`
      return
    }
    if (state.view.kind !== 'episode' || state.view.guid !== v.guid) return
  }
  const ep = feed.episodes.find(e => e.guid === v.guid)
  if (!ep) {
    els.view.innerHTML = `${backBarHtml()}<div class="empty-state">Episode not found in feed.</div>`
    return
  }

  const sub = state.store.subscriptions.find(s => s.feedUrl === v.feedUrl)
  const artwork = ep.imageUrl || feed.imageUrl || sub?.imageUrl || ''
  const podTitle = feed.title || sub?.title || ''
  const skipped = isSkipped(ep.audioUrl)
  const playing = state.player.episode?.audioUrl === ep.audioUrl && !els.audio.paused

  const tagBits = []
  if (ep.season) tagBits.push(`S${escapeHtml(String(ep.season))}`)
  if (ep.episodeNum) tagBits.push(`E${escapeHtml(String(ep.episodeNum))}`)
  const tag = tagBits.join(' ')

  const metaParts = [
    fmtDate(ep.pubDate),
    ep.duration ? fmtDuration(ep.duration) : '',
    ep.author ? escapeHtml(ep.author) : ''
  ].filter(Boolean).join(' · ')

  els.view.innerHTML = `
    ${backBarHtml()}
    <article class="episode-page${skipped ? ' skipped' : ''}">
      <header class="episode-page-header">
        ${artwork ? `<img class="episode-art" src="${escapeHtml(artwork)}" alt="" />` : '<div class="episode-art episode-art-empty"></div>'}
        <div class="ep-meta">
          <div class="ep-podcast-link" data-act="ep-open-feed">${escapeHtml(podTitle)}</div>
          <h1>${escapeHtml(ep.title || 'Untitled')}${tag ? ` <span class="ep-tag">${tag}</span>` : ''}</h1>
          ${ep.subtitle ? `<p class="ep-subtitle">${escapeHtml(ep.subtitle)}</p>` : ''}
          <div class="ep-meta-row">${metaParts}${skipped ? ' <span class="skip-tag">skipped</span>' : ''}</div>
          <div class="ep-actions">
            ${btn({ icon: playing ? 'pause' : 'play_arrow', iconFill: true, label: playing ? 'Pause' : 'Play', variant: 'primary', size: 'lg', pill: true, 'data-act': 'ep-page-play' })}
            ${favBtnHtml(ep.audioUrl)}
            ${btn({ icon: 'more_vert', iconOnly: true, variant: 'ghost', title: 'More', 'data-act': 'ep-page-menu' })}
            ${ep.link ? `<a class="ep-external" href="${escapeHtml(ep.link)}" data-act="ep-external">Show notes page <span class="mi">open_in_new</span></a>` : ''}
          </div>
        </div>
      </header>
      <section class="show-notes" id="show-notes"></section>
    </article>
  `

  renderShowNotes(document.getElementById('show-notes'), ep)
}

const SHOW_NOTES_BLOCK_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM',
  'META', 'LINK', 'BASE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'BUTTON'
])

function sanitizeShowNotes (root) {
  const toRemove = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode
  while (node) {
    if (SHOW_NOTES_BLOCK_TAGS.has(node.tagName)) {
      toRemove.push(node)
    } else {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase()
        const val = (attr.value || '').toLowerCase().trim()
        if (name.startsWith('on')) node.removeAttribute(attr.name)
        else if ((name === 'href' || name === 'src') && val.startsWith('javascript:')) {
          node.removeAttribute(attr.name)
        }
      }
    }
    node = walker.nextNode()
  }
  toRemove.forEach(n => n.remove())
}

function renderShowNotes (container, ep) {
  if (!container) return
  const html = (ep.content || '').trim()
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    sanitizeShowNotes(doc.body)
    container.innerHTML = doc.body.innerHTML
    container.addEventListener('click', onShowNotesClick)
    return
  }
  const fallback = (ep.summary || ep.description || '').trim()
  if (!fallback) {
    container.innerHTML = '<p class="muted-empty">No show notes for this episode.</p>'
    return
  }
  container.textContent = fallback
}

function onShowNotesClick (e) {
  const a = e.target.closest('a[href]')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href) return
  e.preventDefault()
  if (/^https?:/i.test(href)) window.api.openExternal(href)
}

// ------- Feed actions -------

async function openFeed (feedUrl, hint = {}) {
  setView({ kind: 'podcast-loading', feedUrl, hint })
  try {
    const feed = await window.api.fetchFeed(feedUrl)
    state.episodeCache.set(feed.feedUrl, { fetchedAt: Date.now(), ...feed })
    setView({ kind: 'podcast', feedUrl: feed.feedUrl, feed }, { push: false })
  } catch (err) {
    setView({ kind: 'error', message: err.message || 'Failed to load feed' }, { push: false })
  }
}

async function refreshAll () {
  const urls = state.store.subscriptions.map(s => s.feedUrl)
  if (!urls.length) return
  state.refreshing = true
  if (state.view.kind === 'incoming') renderView()
  try {
    const results = await window.api.refreshFeeds(urls)
    for (const [url, res] of Object.entries(results)) {
      if (res.ok) state.episodeCache.set(url, { fetchedAt: Date.now(), ...res.feed })
    }
  } finally {
    state.refreshing = false
    if (state.view.kind === 'incoming' || state.view.kind === 'podcasts' || state.view.kind === 'folder') renderView()
  }
}

// ------- Playback -------

function playEpisode (episode, source = null) {
  state.player.episode = episode
  state.player.source = source
  const saved = findProgress(episode.audioUrl)
  const resumeAt = episode._resumeAt ?? (saved ? saved.currentTime : null)
  if (resumeAt && resumeAt > 0) {
    const onLoad = () => {
      els.audio.currentTime = resumeAt
      els.audio.removeEventListener('loadedmetadata', onLoad)
    }
    els.audio.addEventListener('loadedmetadata', onLoad)
  }
  els.audio.src = episode.audioUrl
  els.audio.play().catch(() => {})
  updateMediaSession(episode)
  els.npTitle.textContent = episode.podcastTitle || 'Untitled'
  els.npPodcast.textContent = episode.title || ''
  const npArtImg = els.npArt.querySelector('img')
  if (episode.podcastImage) npArtImg.src = episode.podcastImage
  else npArtImg.removeAttribute('src')
  els.pcPlay.disabled = false
  els.pcSkipBack.disabled = false
  els.pcSkipFwd.disabled = false
  els.pcSeek.disabled = false
  renderView()
}

// ------- Custom player controls -------

function fmtClock (s) {
  if (!isFinite(s) || s < 0) return '0:00'
  const n = Math.floor(s)
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const sec = String(n % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function setPlayBtn () {
  let s = 'play'
  if (state.player.loading) s = 'loading'
  else if (!els.audio.paused && !els.audio.ended && els.audio.currentSrc) s = 'pause'
  els.pcPlay.dataset.state = s
  els.pcPlay.title = s === 'pause' ? 'Pause' : (s === 'loading' ? 'Loading…' : 'Play')
}

function setMuteBtn () {
  const muted = els.audio.muted || els.audio.volume === 0
  els.pcMute.innerHTML = `<span class="mi">${muted ? 'volume_off' : 'volume_up'}</span>`
}

els.pcPlay.addEventListener('click', () => {
  if (!els.audio.currentSrc) return
  if (els.audio.paused) els.audio.play().catch(() => {})
  else els.audio.pause()
})
els.pcSkipBack.addEventListener('click', () => {
  if (!els.audio.currentSrc) return
  els.audio.currentTime = Math.max(0, els.audio.currentTime - 30)
})
els.pcSkipFwd.addEventListener('click', () => {
  if (!els.audio.currentSrc) return
  const d = isFinite(els.audio.duration) ? els.audio.duration : Infinity
  els.audio.currentTime = Math.min(d, els.audio.currentTime + 30)
})

let seeking = false
els.pcSeek.addEventListener('input', () => {
  seeking = true
  if (isFinite(els.audio.duration)) {
    els.pcCur.textContent = fmtClock((els.pcSeek.value / 1000) * els.audio.duration)
  }
})
els.pcSeek.addEventListener('change', () => {
  if (isFinite(els.audio.duration)) {
    els.audio.currentTime = (els.pcSeek.value / 1000) * els.audio.duration
  }
  seeking = false
})

els.pcMute.addEventListener('click', () => {
  els.audio.muted = !els.audio.muted
  setMuteBtn()
})
els.pcVol.addEventListener('input', () => {
  els.audio.volume = parseFloat(els.pcVol.value)
  if (els.audio.volume > 0) els.audio.muted = false
  setMuteBtn()
})

els.audio.addEventListener('play', () => {
  setPlayBtn()
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
})
els.audio.addEventListener('pause', () => {
  setPlayBtn()
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
})
els.audio.addEventListener('loadedmetadata', () => {
  els.pcDur.textContent = fmtClock(els.audio.duration)
})
els.audio.addEventListener('timeupdate', () => {
  if (seeking) return
  els.pcCur.textContent = fmtClock(els.audio.currentTime)
  if (isFinite(els.audio.duration) && els.audio.duration > 0) {
    els.pcSeek.value = String(Math.round((els.audio.currentTime / els.audio.duration) * 1000))
  }
})
els.audio.addEventListener('volumechange', setMuteBtn)

function setPlayLoading (loading) {
  state.player.loading = loading
  setPlayBtn()
  document.querySelectorAll('.play-btn.playing').forEach(b => {
    b.classList.toggle('loading', loading)
    const mi = b.querySelector('.mi')
    if (mi) mi.textContent = loading ? 'progress_activity' : 'play_arrow'
  })
}

els.audio.addEventListener('loadstart', () => setPlayLoading(true))
els.audio.addEventListener('waiting', () => setPlayLoading(true))
els.audio.addEventListener('canplay', () => setPlayLoading(false))
els.audio.addEventListener('playing', () => setPlayLoading(false))
els.audio.addEventListener('error', () => setPlayLoading(false))

// ------- In-progress tracking -------

let lastProgressSave = 0

async function saveStoreSilently () {
  state.store = await window.api.saveStore(state.store)
}

function findProgress (audioUrl) {
  return (state.store.inProgress || []).find(x => x.audioUrl === audioUrl)
}

function removeProgress (audioUrl, { rerender = true } = {}) {
  if (!state.store.inProgress) return
  const before = state.store.inProgress.length
  state.store.inProgress = state.store.inProgress.filter(x => x.audioUrl !== audioUrl)
  if (state.store.inProgress.length !== before) {
    saveStoreSilently()
    if (rerender && state.view.kind === 'in-progress') renderView()
  }
}

function recordProgress ({ immediate = false } = {}) {
  const ep = state.player.episode
  if (!ep || !ep.audioUrl) return
  const now = Date.now()
  if (!immediate && now - lastProgressSave < 5000) return
  lastProgressSave = now
  const cur = els.audio.currentTime
  const dur = els.audio.duration
  if (!isFinite(dur) || dur <= 0) return
  if (cur < 5 || cur > dur - 30) {
    removeProgress(ep.audioUrl)
    return
  }
  state.store.inProgress ||= []
  const rec = {
    audioUrl: ep.audioUrl,
    title: ep.title,
    pubDate: ep.pubDate,
    duration: ep.duration,
    guid: ep.guid,
    feedUrl: ep.feedUrl,
    podcastTitle: ep.podcastTitle,
    podcastImage: ep.podcastImage,
    currentTime: cur,
    durationSec: dur,
    lastPlayedAt: now
  }
  const idx = state.store.inProgress.findIndex(x => x.audioUrl === ep.audioUrl)
  if (idx >= 0) state.store.inProgress[idx] = rec
  else state.store.inProgress.push(rec)
  saveStoreSilently()
  if (state.view.kind === 'in-progress') renderView()
}

els.audio.addEventListener('timeupdate', () => recordProgress())
els.audio.addEventListener('pause', () => recordProgress({ immediate: true }))
els.audio.addEventListener('ended', () => {
  if (state.player.episode) removeProgress(state.player.episode.audioUrl)
})
window.addEventListener('beforeunload', () => recordProgress({ immediate: true }))

els.audio.addEventListener('ended', () => {
  const src = state.player.source
  if (!src) return
  if (src.kind === 'playlist') {
    const pl = state.store.playlists.find(p => p.id === src.playlistId)
    if (!pl) return
    const next = src.index + 1
    if (next >= pl.items.length) {
      state.player.source = null
      return
    }
    playEpisode(pl.items[next], { kind: 'playlist', playlistId: pl.id, index: next })
    return
  }
  if (src.kind === 'podcast') {
    const mode = state.store.settings?.podcastAutoAdvance || 'newer'
    if (mode === 'off') { state.player.source = null; return }
    const feed = state.episodeCache.get(src.feedUrl)
    const cur = state.player.episode
    if (!feed || !cur) { state.player.source = null; return }
    const next = findNextPodcastEpisode(feed, cur, mode)
    if (!next) { state.player.source = null; return }
    playEpisode({
      ...next,
      feedUrl: src.feedUrl,
      podcastTitle: feed.title,
      podcastImage: feed.imageUrl
    }, { kind: 'podcast', feedUrl: src.feedUrl })
  }
})

function findNextPodcastEpisode (feed, cur, mode) {
  const playable = feed.episodes.filter(e => e.audioUrl && !isSkipped(e.audioUrl))
  if (mode === 'sort') {
    const sorted = sortEpisodes(playable, state.podcastSort)
    const i = sorted.findIndex(({ ep }) => ep.audioUrl === cur.audioUrl)
    if (i < 0 || i + 1 >= sorted.length) return null
    return sorted[i + 1].ep
  }
  const curT = new Date(cur.pubDate || 0).getTime()
  if (mode === 'older') {
    return playable
      .filter(e => new Date(e.pubDate || 0).getTime() < curT)
      .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))[0] || null
  }
  return playable
    .filter(e => new Date(e.pubDate || 0).getTime() > curT)
    .sort((a, b) => new Date(a.pubDate || 0) - new Date(b.pubDate || 0))[0] || null
}

// ------- Add to playlist -------

async function addEpisodeToPlaylistFlow (item) {
  const choice = await pickFromList(
    `Add "${item.title}" to playlist`,
    state.store.playlists.map(p => ({ id: p.id, label: p.name })),
    { label: '+ New playlist…', prompt: 'New playlist name' }
  )
  if (!choice) return
  let pl
  if (choice.newName) {
    pl = { id: uid(), name: choice.newName, items: [] }
    state.store.playlists.push(pl)
  } else {
    pl = state.store.playlists.find(p => p.id === choice.id)
  }
  if (!pl) return
  if (!pl.items.some(x => x.audioUrl === item.audioUrl)) {
    pl.items.push({
      audioUrl: item.audioUrl,
      title: item.title,
      pubDate: item.pubDate,
      duration: item.duration,
      guid: item.guid,
      feedUrl: item.feedUrl,
      podcastTitle: item.podcastTitle,
      podcastImage: item.podcastImage
    })
  }
  await persist()
}


// ------- Event wiring -------

const isUrlish = s => /^https?:\/\//i.test(s)

async function ingestFeedUrl (url) {
  setView({ kind: 'loading' })
  try {
    const feed = await window.api.fetchFeed(url)
    const canonical = feed.feedUrl || url
    state.episodeCache.set(canonical, { fetchedAt: Date.now(), ...feed })
    if (!state.store.subscriptions.some(s => s.feedUrl === canonical)) {
      state.store.subscriptions.push({
        feedUrl: canonical,
        title: feed.title || canonical,
        imageUrl: feed.imageUrl,
        folderId: null
      })
      await persist()
    }
    els.search.value = ''
    setView({ kind: 'podcast', feedUrl: canonical, feed })
  } catch (err) {
    setView({ kind: 'error', message: `Could not load feed: ${err.message}` })
  }
}

els.search.addEventListener('input', e => {
  const term = e.target.value.trim()
  clearTimeout(state.searchDebounce)
  if (!term) {
    setView({ kind: 'podcasts' })
    return
  }
  if (isUrlish(term)) return
  state.searchDebounce = setTimeout(async () => {
    setView({ kind: 'loading' })
    try {
      const results = await window.api.search(term)
      setView({ kind: 'search', term, results })
    } catch (err) {
      setView({ kind: 'error', message: err.message })
    }
  }, 350)
})

els.search.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  const term = e.target.value.trim()
  if (!isUrlish(term)) return
  clearTimeout(state.searchDebounce)
  ingestFeedUrl(term)
})

els.nav.addEventListener('click', async (e) => {
  const navItem = e.target.closest('.nav-item')
  if (navItem && !e.target.closest('button')) {
    state.viewHistory = []
    setView({ kind: navItem.dataset.view }, { push: false })
    return
  }
  if (e.target === els.refresh) {
    e.stopPropagation()
    await refreshAll()
    return
  }
  const folderRow = e.target.closest('[data-folder]')
  if (folderRow) {
    state.viewHistory = []
    setView({ kind: 'folder', folderId: folderRow.dataset.folder }, { push: false })
    return
  }
  const playlistRow = e.target.closest('[data-playlist]')
  if (playlistRow) {
    state.viewHistory = []
    setView({ kind: 'playlist', playlistId: playlistRow.dataset.playlist }, { push: false })
  }
})

els.nav.addEventListener('contextmenu', async e => {
  const folderRow = e.target.closest('[data-folder]')
  const playlistRow = !folderRow && e.target.closest('[data-playlist]')
  if (!folderRow && !playlistRow) return
  e.preventDefault()
  const items = [
    { id: 'rename', label: 'Rename' },
    { id: 'delete', label: 'Delete' }
  ]
  const chosen = await window.api.showCardMenu({ items, x: e.clientX, y: e.clientY })
  if (!chosen) return
  if (folderRow) {
    const id = folderRow.dataset.folder
    if (chosen === 'rename') startRenameFolder(id)
    else if (chosen === 'delete') {
      if (await confirmAction('Delete folder? Subscriptions will move to uncategorized.')) {
        state.store.folders = state.store.folders.filter(x => x.id !== id)
        for (const s of state.store.subscriptions) if (s.folderId === id) s.folderId = null
        if (state.view.kind === 'folder' && state.view.folderId === id) setView({ kind: 'podcasts' })
        else await persist()
      }
    }
  } else {
    const id = playlistRow.dataset.playlist
    if (chosen === 'rename') startRenamePlaylist(id)
    else if (chosen === 'delete') {
      if (await confirmAction('Delete playlist?')) {
        state.store.playlists = state.store.playlists.filter(x => x.id !== id)
        if (state.view.kind === 'playlist' && state.view.playlistId === id) setView({ kind: 'podcasts' })
        else await persist()
      }
    }
  }
})

els.newFolder.addEventListener('click', () => {
  startNewFolder()
})

els.foldersList.addEventListener('click', e => {
  if (e.target.closest('[data-editing="true"]')) e.stopPropagation()
})

els.foldersList.addEventListener('keydown', e => {
  const input = e.target.closest('.row-edit')
  if (!input) return
  if (e.key === 'Enter') { e.preventDefault(); commitFolderEdit(input.value) }
  else if (e.key === 'Escape') { e.preventDefault(); cancelFolderEdit() }
})

els.foldersList.addEventListener('blur', e => {
  const input = e.target.closest('.row-edit')
  if (!input || !state.folderEdit) return
  commitFolderEdit(input.value)
}, true)

els.newPlaylist.addEventListener('click', () => {
  startNewPlaylist()
})

els.playlistsList.addEventListener('click', e => {
  if (e.target.closest('[data-editing="true"]')) e.stopPropagation()
})

els.playlistsList.addEventListener('keydown', e => {
  const input = e.target.closest('.row-edit')
  if (!input) return
  if (e.key === 'Enter') { e.preventDefault(); commitPlaylistEdit(input.value) }
  else if (e.key === 'Escape') { e.preventDefault(); cancelPlaylistEdit() }
})

els.playlistsList.addEventListener('blur', e => {
  const input = e.target.closest('.row-edit')
  if (!input || !state.playlistEdit) return
  commitPlaylistEdit(input.value)
}, true)

els.view.addEventListener('click', async e => {
  const card = e.target.closest('.gallery-card')
  const actBtn = e.target.closest('[data-act]')
  const v = state.view

  if (actBtn) {
    const act = actBtn.dataset.act
    if (act === 'back') { goBack(); return }
    if (act === 'card-menu') {
      e.stopPropagation()
      openCardMenu(actBtn, actBtn.dataset.feed)
      return
    }
    if (act === 'ep-menu') {
      e.stopPropagation()
      await openEpisodeMenu(actBtn)
      return
    }
    if (act === 'ep-external') {
      e.preventDefault()
      const href = actBtn.getAttribute('href')
      if (href) window.api.openExternal(href)
      return
    }
    if (act === 'ep-open-feed' && v.kind === 'episode') {
      openFeed(v.feedUrl)
      return
    }
    if (act === 'ep-page-play' && v.kind === 'episode') {
      const feed = state.episodeCache.get(v.feedUrl)
      const ep = feed?.episodes.find(x => x.guid === v.guid)
      if (!ep) return
      const samePlaying = state.player.episode?.audioUrl === ep.audioUrl
      if (samePlaying) {
        if (els.audio.paused) els.audio.play().catch(() => {})
        else els.audio.pause()
        renderView()
      } else {
        playEpisode({
          ...ep,
          feedUrl: v.feedUrl,
          podcastTitle: feed.title,
          podcastImage: feed.imageUrl
        }, { kind: 'podcast', feedUrl: v.feedUrl })
      }
      return
    }
    if (act === 'ep-page-menu' && v.kind === 'episode') {
      const feed = state.episodeCache.get(v.feedUrl)
      const ep = feed?.episodes.find(x => x.guid === v.guid)
      if (!ep) return
      const skipped = isSkipped(ep.audioUrl)
      const items = [
        { id: 'add', label: 'Add to playlist…' },
        { id: 'skip', label: skipped ? 'Unskip episode' : 'Skip this episode' }
      ]
      const rect = actBtn.getBoundingClientRect()
      const chosen = await window.api.showCardMenu({ items, x: rect.left, y: rect.bottom })
      const full = { ...ep, feedUrl: v.feedUrl, podcastTitle: feed.title, podcastImage: feed.imageUrl }
      if (chosen === 'add') await addEpisodeToPlaylistFlow(full)
      else if (chosen === 'skip') { await toggleSkip(ep.audioUrl); renderView() }
      return
    }
    if (act === 'refresh-all') { await refreshAll(); return }
    if (act === 'toggle-fav') {
      e.stopPropagation()
      const url = actBtn.dataset.favUrl
      const ep = resolveEpisodeByUrl(url)
      if (ep) await toggleFavorite(ep)
      return
    }
    if (act === 'play-favorite' && v.kind === 'favorites') {
      const sorted = (state.store.favorites || []).slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0))
      const ep = sorted[parseInt(actBtn.dataset.idx, 10)]
      if (ep) playEpisode(ep)
      return
    }
    if (act === 'bl-remove') {
      const idx = parseInt(actBtn.dataset.idx, 10)
      state.store.discoverBlacklist.splice(idx, 1)
      state.discoverCache = null
      await persist()
      renderSettings()
      return
    }
    if (act === 'refresh-discover') {
      e.stopPropagation()
      state.discoverCache = null
      renderDiscover()
      return
    }
    if (act === 'toggle-sub') {
      e.stopPropagation()
      const feedUrl = actBtn.dataset.feed
      const idx = state.store.subscriptions.findIndex(s => s.feedUrl === feedUrl)
      if (idx >= 0) {
        state.store.subscriptions.splice(idx, 1)
      } else {
        state.store.subscriptions.push({
          feedUrl,
          title: actBtn.dataset.title || feedUrl,
          imageUrl: actBtn.dataset.img || '',
          folderId: null
        })
      }
      await persist()
      renderView()
      return
    }
    if (act === 'subscribe' && v.kind === 'podcast') {
      state.store.subscriptions.push({
        feedUrl: v.feedUrl,
        title: v.feed.title,
        imageUrl: v.feed.imageUrl,
        folderId: null
      })
      state.episodeCache.set(v.feedUrl, { fetchedAt: Date.now(), ...v.feed })
      await persist()
      renderView()
      return
    }
    if (act === 'unsubscribe' && v.kind === 'podcast') {
      state.store.subscriptions = state.store.subscriptions.filter(s => s.feedUrl !== v.feedUrl)
      await persist()
      renderView()
      return
    }
    if (act === 'play' && v.kind === 'podcast') {
      const ep = v.feed.episodes[parseInt(actBtn.dataset.idx, 10)]
      playEpisode({
        ...ep,
        feedUrl: v.feedUrl,
        podcastTitle: v.feed.title,
        podcastImage: v.feed.imageUrl
      }, { kind: 'podcast', feedUrl: v.feedUrl })
      return
    }
    if (act === 'play-in-progress' && v.kind === 'in-progress') {
      const sorted = (state.store.inProgress || []).slice().sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
      const ep = sorted[parseInt(actBtn.dataset.idx, 10)]
      if (ep) playEpisode(ep)
      return
    }
    if (act === 'remove-in-progress' && v.kind === 'in-progress') {
      const sorted = (state.store.inProgress || []).slice().sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
      const ep = sorted[parseInt(actBtn.dataset.idx, 10)]
      if (ep) removeProgress(ep.audioUrl)
      return
    }
    if (act === 'play-incoming' && v.kind === 'incoming') {
      const ep = allCachedEpisodes()[parseInt(actBtn.dataset.idx, 10)]
      if (ep) playEpisode(ep)
      return
    }
    if (v.kind === 'playlist') {
      const pl = state.store.playlists.find(p => p.id === v.playlistId)
      if (!pl) return
      const idx = parseInt(actBtn.dataset.idx, 10)
      if (act === 'play-playlist') {
        if (pl.items.length) playEpisode(pl.items[0], { kind: 'playlist', playlistId: pl.id, index: 0 })
      } else if (act === 'pl-play') {
        playEpisode(pl.items[idx], { kind: 'playlist', playlistId: pl.id, index: idx })
      } else if (act === 'pl-up' && idx > 0) {
        ;[pl.items[idx - 1], pl.items[idx]] = [pl.items[idx], pl.items[idx - 1]]
        await persist(); renderView()
      } else if (act === 'pl-down' && idx < pl.items.length - 1) {
        ;[pl.items[idx], pl.items[idx + 1]] = [pl.items[idx + 1], pl.items[idx]]
        await persist(); renderView()
      } else if (act === 'pl-remove') {
        pl.items.splice(idx, 1)
        await persist(); renderView()
      }
      return
    }
  }

  if (card) {
    const hint = {
      title: card.querySelector('.title')?.textContent || '',
      imageUrl: card.querySelector('img')?.getAttribute('src') || ''
    }
    openFeed(card.dataset.feed, hint)
    return
  }

  const epRow = e.target.closest('.episode[data-context][data-idx]')
  if (epRow) handleEpisodeSelectClick(epRow, e)
})

// ------- Drag & Drop -------

function buildEpisodeFromDragSrc (el) {
  const ctx = el.dataset.context
  const idx = parseInt(el.dataset.idx, 10)
  if (ctx === 'podcast' && state.view.kind === 'podcast') {
    const v = state.view
    const ep = v.feed.episodes[idx]
    if (!ep) return null
    return { ...ep, feedUrl: v.feedUrl, podcastTitle: v.feed.title, podcastImage: v.feed.imageUrl }
  }
  if (ctx === 'incoming') {
    return allCachedEpisodes()[idx] || null
  }
  return null
}

function findDropTarget (el, kind) {
  if (kind === 'sub') return el.closest('.nav-row[data-folder]')
  if (kind === 'ep') return el.closest('.nav-row[data-playlist]')
  if (kind === 'pl-item') return el.closest('.playlist-item[data-drag="pl-item"]')
  return null
}

document.addEventListener('dragstart', (e) => {
  const src = e.target.closest('[data-drag]')
  if (!src) { currentDrag = null; return }
  const kind = src.dataset.drag
  if (kind === 'sub') {
    currentDrag = { kind, feedUrl: src.dataset.feed }
  } else if (kind === 'ep') {
    const ep = buildEpisodeFromDragSrc(src)
    if (!ep) { currentDrag = null; return }
    currentDrag = { kind, episode: ep }
  } else if (kind === 'pl-item') {
    currentDrag = { kind, playlistId: src.dataset.playlistId, idx: parseInt(src.dataset.idx, 10) }
  } else {
    currentDrag = null
    return
  }
  e.dataTransfer.setData('text/plain', kind)
  e.dataTransfer.effectAllowed = kind === 'ep' ? 'copy' : 'move'
  src.classList.add('dragging')
})

document.addEventListener('dragend', (e) => {
  const src = e.target.closest('[data-drag]')
  if (src) src.classList.remove('dragging')
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'))
  currentDrag = null
})

document.addEventListener('dragover', (e) => {
  if (!currentDrag) return
  const tgt = findDropTarget(e.target, currentDrag.kind)
  if (!tgt) return
  if (currentDrag.kind === 'pl-item' &&
      tgt.dataset.playlistId !== currentDrag.playlistId) return
  e.preventDefault()
  e.dataTransfer.dropEffect = currentDrag.kind === 'ep' ? 'copy' : 'move'
  document.querySelectorAll('.drag-over').forEach(el => {
    if (el !== tgt) el.classList.remove('drag-over')
  })
  tgt.classList.add('drag-over')
})

document.addEventListener('dragleave', (e) => {
  const tgt = e.target.closest('.drag-over')
  if (tgt && !tgt.contains(e.relatedTarget)) tgt.classList.remove('drag-over')
})

document.addEventListener('drop', async (e) => {
  if (!currentDrag) return
  const tgt = findDropTarget(e.target, currentDrag.kind)
  if (!tgt) return
  e.preventDefault()
  tgt.classList.remove('drag-over')

  if (currentDrag.kind === 'sub') {
    const folderId = tgt.dataset.folder
    const sub = state.store.subscriptions.find(s => s.feedUrl === currentDrag.feedUrl)
    if (sub) {
      sub.folderId = folderId
      await persist()
      renderView()
    }
  } else if (currentDrag.kind === 'ep') {
    const pl = state.store.playlists.find(p => p.id === tgt.dataset.playlist)
    if (pl && currentDrag.episode) {
      const ep = currentDrag.episode
      if (!pl.items.some(x => x.audioUrl === ep.audioUrl)) {
        pl.items.push({
          audioUrl: ep.audioUrl,
          title: ep.title,
          pubDate: ep.pubDate,
          duration: ep.duration,
          guid: ep.guid,
          feedUrl: ep.feedUrl,
          podcastTitle: ep.podcastTitle,
          podcastImage: ep.podcastImage
        })
        await persist()
        flashSidebarRow(tgt)
      }
    }
  } else if (currentDrag.kind === 'pl-item') {
    if (tgt.dataset.playlistId !== currentDrag.playlistId) return
    const pl = state.store.playlists.find(p => p.id === currentDrag.playlistId)
    if (!pl) return
    const fromIdx = currentDrag.idx
    const toIdx = parseInt(tgt.dataset.idx, 10)
    if (fromIdx === toIdx) return
    const [moved] = pl.items.splice(fromIdx, 1)
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx
    pl.items.splice(insertAt, 0, moved)
    await persist()
    renderView()
  }
  currentDrag = null
})

function flashSidebarRow (row) {
  row.classList.add('flash')
  setTimeout(() => row.classList.remove('flash'), 350)
}

// ------- Boot -------

document.body.classList.add(`platform-${window.platform || 'unknown'}`)

function isTypingTarget (el) {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return !!el.isContentEditable
}

function togglePlayPause () {
  if (!els.audio.currentSrc) return
  if (els.audio.paused) els.audio.play().catch(() => {})
  else els.audio.pause()
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '[') {
    e.preventDefault()
    goBack()
    return
  }
  if ((e.code === 'Space' || e.key === ' ') && !isTypingTarget(e.target)) {
    if (!els.audio.currentSrc) return
    e.preventDefault()
    togglePlayPause()
    return
  }
  if (e.key === 'MediaPlayPause') { e.preventDefault(); togglePlayPause(); return }
  if (e.key === 'MediaStop') { e.preventDefault(); els.audio.pause(); return }
  if (e.key === 'MediaTrackNext') {
    e.preventDefault()
    if (els.audio.currentSrc) els.audio.currentTime = els.audio.currentTime + 30
    return
  }
  if (e.key === 'MediaTrackPrevious') {
    e.preventDefault()
    if (els.audio.currentSrc) els.audio.currentTime = Math.max(0, els.audio.currentTime - 30)
  }
})

function updateMediaSession (episode) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: episode.title || 'Untitled',
      artist: episode.podcastTitle || '',
      artwork: episode.podcastImage ? [{ src: episode.podcastImage, sizes: '512x512' }] : []
    })
  } catch {}
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler) } catch {}
  }
  set('play', () => els.audio.play().catch(() => {}))
  set('pause', () => els.audio.pause())
  set('stop', () => els.audio.pause())
  set('seekbackward', (d) => {
    const off = (d && d.seekOffset) || 30
    els.audio.currentTime = Math.max(0, els.audio.currentTime - off)
  })
  set('seekforward', (d) => {
    const off = (d && d.seekOffset) || 30
    els.audio.currentTime = els.audio.currentTime + off
  })
  set('seekto', (d) => {
    if (d && typeof d.seekTime === 'number') els.audio.currentTime = d.seekTime
  })
}

els.selBar.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  if (act === 'sel-clear') {
    clearSelection()
    updateSelectionBar()
    renderView()
  } else if (act === 'sel-add-playlist') {
    await bulkAddToPlaylist(resolveSelectionEpisodes())
  } else if (act === 'sel-skip') {
    await bulkSkip(resolveSelectionEpisodes())
  }
})

async function bulkSkip (episodes) {
  const urls = episodes.map(e => e.audioUrl).filter(Boolean)
  if (!urls.length) return
  const allSkipped = urls.every(u => isSkipped(u))
  state.store.skippedEpisodes ||= []
  if (allSkipped) {
    state.store.skippedEpisodes = state.store.skippedEpisodes.filter(u => !urls.includes(u))
  } else {
    for (const u of urls) {
      if (!state.store.skippedEpisodes.includes(u)) state.store.skippedEpisodes.push(u)
    }
  }
  await persist()
  clearSelection()
  updateSelectionBar()
  renderView()
}

;(async () => {
  state.store = await window.api.getStore()
  try { state.blacklistDefaults = await window.api.getBlacklistDefaults() } catch {}
  renderSidebar()
  renderView()
  measureSelectionBar()
  window.addEventListener('resize', measureSelectionBar)
  refreshAll()
  setInterval(refreshAll, 30 * 60 * 1000)
})()
