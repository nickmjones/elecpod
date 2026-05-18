const state = {
  store: { subscriptions: [], folders: [], playlists: [] },
  episodeCache: new Map(),
  view: { kind: 'podcasts' },
  player: { episode: null, source: null },
  searchDebounce: null,
  refreshing: false,
  incomingFilter: '7d',
  discoverCache: null,
  blacklistDefaults: []
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
  addUrl: document.getElementById('add-url-btn'),
  refresh: document.getElementById('refresh-btn'),
  view: document.getElementById('view'),
  audio: document.getElementById('audio'),
  npTitle: document.getElementById('np-title'),
  npPodcast: document.getElementById('np-podcast'),
  pcPlay: document.getElementById('pc-play'),
  pcSkipBack: document.getElementById('pc-skip-back'),
  pcSkipFwd: document.getElementById('pc-skip-fwd'),
  pcSeek: document.getElementById('pc-seek'),
  pcCur: document.getElementById('pc-cur'),
  pcDur: document.getElementById('pc-dur'),
  pcRate: document.getElementById('pc-rate'),
  pcMute: document.getElementById('pc-mute'),
  pcVol: document.getElementById('pc-vol')
}

const uid = () => Math.random().toString(36).slice(2, 10)

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))

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

function setView (view) {
  state.view = view
  renderView()
  renderSidebar()
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
      <button class="modal-cancel">Cancel</button>
      <button class="modal-ok primary">OK</button>
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
      <button class="modal-cancel">Cancel</button>
      <button class="modal-ok primary">OK</button>
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
      <button class="modal-cancel">Cancel</button>
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

// ------- Sidebar -------

function renderSidebar () {
  const v = state.view
  // Top-level nav-item active states
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === v.kind)
  })

  els.foldersList.innerHTML = state.store.folders.map(f => `
    <div class="nav-row${v.kind === 'folder' && v.folderId === f.id ? ' active' : ''}" data-folder="${f.id}">
      <span class="row-label">${escapeHtml(f.name)}</span>
      <span class="row-actions">
        <button data-act="rename-folder" data-id="${f.id}" title="Rename"><span class="mi">edit</span></button>
        <button data-act="delete-folder" data-id="${f.id}" title="Delete"><span class="mi">close</span></button>
      </span>
    </div>
  `).join('') || '<div class="muted-empty">No folders</div>'

  els.playlistsList.innerHTML = state.store.playlists.map(p => `
    <div class="nav-row${v.kind === 'playlist' && v.playlistId === p.id ? ' active' : ''}" data-playlist="${p.id}">
      <span class="row-label">${escapeHtml(p.name)} <span style="color:#666;font-size:11px">(${p.items.length})</span></span>
      <span class="row-actions">
        <button data-act="rename-playlist" data-id="${p.id}" title="Rename"><span class="mi">edit</span></button>
        <button data-act="delete-playlist" data-id="${p.id}" title="Delete"><span class="mi">close</span></button>
      </span>
    </div>
  `).join('') || '<div class="muted-empty">No playlists</div>'
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
    case 'settings': return renderSettings()
    case 'playlist': return renderPlaylistView(v.playlistId)
    case 'podcast': return renderPodcast(v)
    case 'search': return renderSearch(v.term, v.results)
    case 'loading': els.view.innerHTML = `<div class="loading">Loading…</div>`; return
    case 'error': els.view.innerHTML = `<div class="empty-state">Error: ${escapeHtml(v.message)}</div>`; return
    default: els.view.innerHTML = `<div class="empty-state">Pick something.</div>`
  }
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
      ${subs.map(s => `
        <div class="gallery-card" draggable="true" data-drag="sub" data-feed="${escapeHtml(s.feedUrl)}">
          <button class="folder-pick" data-act="pick-folder" data-feed="${escapeHtml(s.feedUrl)}" title="Move to folder"><span class="mi">more_horiz</span></button>
          <img src="${escapeHtml(s.imageUrl || '')}" alt="" />
          <div class="title">${escapeHtml(s.title)}</div>
        </div>
      `).join('')}
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
        <button data-act="refresh-all">Refresh</button>
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
    <div class="episode" draggable="true" data-drag="ep" data-context="incoming" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play-incoming" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="ep-podcast">${escapeHtml(e.podcastTitle || '')}</div>
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)}${e.duration ? ' · ' + escapeHtml(fmtDuration(e.duration)) : ''}</div>
        <div class="desc">${escapeHtml(e.description)}</div>
      </div>
      <button class="add-btn" data-act="add-incoming" data-idx="${i}" title="Add to playlist"><span class="mi">add</span></button>
    </div>
  `
}

function renderPodcast (v) {
  const { feedUrl, feed } = v
  const sub = state.store.subscriptions.find(s => s.feedUrl === feedUrl)
  const subscribed = !!sub

  const subscribeBtn = subscribed
    ? `<button data-act="unsubscribe">Unsubscribe</button>`
    : `<button class="primary" data-act="subscribe">Subscribe</button>`

  els.view.innerHTML = `
    <div class="podcast-header">
      <img src="${escapeHtml(feed.imageUrl || sub?.imageUrl || '')}" alt="" />
      <div class="meta">
        <h1>${escapeHtml(feed.title || sub?.title || '')}</h1>
        <p>${escapeHtml((feed.description || '').slice(0, 400))}</p>
        <div class="actions">${subscribeBtn}</div>
      </div>
    </div>
    <div class="episodes">
      ${feed.episodes.map((e, i) => episodeRow(e, i)).join('')}
    </div>
  `
}

function episodeRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  return `
    <div class="episode" draggable="true" data-drag="ep" data-context="podcast" data-idx="${i}">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)}${e.duration ? ' · ' + escapeHtml(fmtDuration(e.duration)) : ''}</div>
        <div class="desc">${escapeHtml(e.description)}</div>
      </div>
      <button class="add-btn" data-act="add-to-playlist" data-idx="${i}" title="Add to playlist"><span class="mi">add</span></button>
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
        ${pl.items.length ? `<button class="primary" data-act="play-playlist">Play all</button>` : ''}
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
        <button data-act="pl-play" data-idx="${i}" title="Play"><span class="mi mi-fill">play_arrow</span></button>
        <button data-act="pl-up" data-idx="${i}" title="Move up"><span class="mi">arrow_upward</span></button>
        <button data-act="pl-down" data-idx="${i}" title="Move down"><span class="mi">arrow_downward</span></button>
        <button data-act="pl-remove" data-idx="${i}" title="Remove"><span class="mi">close</span></button>
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
        <button data-act="refresh-discover">Refresh</button>
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
      <button class="subscribe-btn${isSubbed ? ' subscribed' : ''}" data-act="toggle-sub" data-feed="${escapeHtml(r.feedUrl)}" data-title="${escapeHtml(r.title)}" data-img="${escapeHtml(r.imageUrl || '')}" title="${isSubbed ? 'Unsubscribe' : 'Subscribe'}"><span class="mi">${isSubbed ? 'check' : 'add'}</span></button>
      <img src="${escapeHtml(r.imageUrl || '')}" alt="" />
      <div class="title">${escapeHtml(r.title)}</div>
      ${r.artist ? `<div class="artist">${escapeHtml(r.artist)}</div>` : ''}
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
}

function inProgressRow (e, i) {
  const playing = state.player.episode?.audioUrl === e.audioUrl
  const pct = e.durationSec > 0 ? Math.max(0, Math.min(100, (e.currentTime / e.durationSec) * 100)) : 0
  const remain = Math.max(0, (e.durationSec || 0) - (e.currentTime || 0))
  return `
    <div class="episode">
      <button class="play-btn${playing ? ' playing' : ''}" data-act="play-in-progress" data-idx="${i}"><span class="mi mi-fill">play_arrow</span></button>
      <div class="episode-info">
        <div class="ep-podcast">${escapeHtml(e.podcastTitle || '')}</div>
        <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
        <div class="meta">${fmtDate(e.pubDate)} · ${fmtClock(e.currentTime)} / ${fmtClock(e.durationSec)} · ${fmtClock(remain)} left</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>
      <button class="add-btn" data-act="remove-in-progress" data-idx="${i}" title="Remove"><span class="mi">close</span></button>
    </div>
  `
}

function renderSettings () {
  const user = state.store.discoverBlacklist || []
  const defaults = state.blacklistDefaults
  els.view.innerHTML = `
    <div class="view-header"><h1>Settings</h1></div>
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
          ? user.map((t, i) => `<span class="tag">${escapeHtml(t)}<button data-act="bl-remove" data-idx="${i}" title="Remove"><span class="mi">close</span></button></span>`).join('')
          : '<div class="muted-empty">No custom keywords yet.</div>'}
      </div>
      <form class="blacklist-form" id="bl-form">
        <input type="text" id="bl-input" placeholder="Add keyword (e.g. crypto)" />
        <button type="submit" class="primary">Add</button>
      </form>
    </section>
  `
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
    <div class="view-header"><h1>Search: ${escapeHtml(term)}</h1></div>
    <div class="gallery">
      ${results.map(r => searchCardHtml(r, subbed)).join('')}
    </div>
  `
}

// ------- Feed actions -------

async function openFeed (feedUrl) {
  setView({ kind: 'loading' })
  try {
    const feed = await window.api.fetchFeed(feedUrl)
    state.episodeCache.set(feed.feedUrl, { fetchedAt: Date.now(), ...feed })
    setView({ kind: 'podcast', feedUrl: feed.feedUrl, feed })
  } catch (err) {
    setView({ kind: 'error', message: err.message || 'Failed to load feed' })
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
    if (state.view.kind === 'incoming') renderView()
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
  els.npTitle.textContent = episode.title || 'Untitled'
  els.npPodcast.textContent = episode.podcastTitle || ''
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
  const playing = !els.audio.paused && !els.audio.ended && els.audio.currentSrc
  els.pcPlay.innerHTML = `<span class="mi mi-fill">${playing ? 'pause' : 'play_arrow'}</span>`
  els.pcPlay.title = playing ? 'Pause' : 'Play'
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
  els.audio.currentTime = Math.max(0, els.audio.currentTime - 15)
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

els.pcRate.addEventListener('change', () => {
  els.audio.playbackRate = parseFloat(els.pcRate.value)
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

els.audio.addEventListener('play', setPlayBtn)
els.audio.addEventListener('pause', setPlayBtn)
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
  if (!src || src.kind !== 'playlist') return
  const pl = state.store.playlists.find(p => p.id === src.playlistId)
  if (!pl) return
  const next = src.index + 1
  if (next >= pl.items.length) {
    state.player.source = null
    return
  }
  playEpisode(pl.items[next], { kind: 'playlist', playlistId: pl.id, index: next })
})

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

// ------- Folder assignment -------

async function pickFolderFor (feedUrl) {
  const sub = state.store.subscriptions.find(s => s.feedUrl === feedUrl)
  if (!sub) return
  const choice = await pickFromList(
    `Move "${sub.title}" to folder`,
    [
      { id: '__none__', label: '(no folder)' },
      ...state.store.folders.map(f => ({ id: f.id, label: f.name }))
    ],
    { label: '+ New folder…', prompt: 'New folder name' }
  )
  if (!choice) return
  if (choice.newName) {
    const f = { id: uid(), name: choice.newName }
    state.store.folders.push(f)
    sub.folderId = f.id
  } else if (choice.id === '__none__') {
    sub.folderId = null
  } else {
    sub.folderId = choice.id
  }
  await persist()
  renderView()
}

// ------- Event wiring -------

els.search.addEventListener('input', e => {
  const term = e.target.value.trim()
  clearTimeout(state.searchDebounce)
  if (!term) {
    setView({ kind: 'podcasts' })
    return
  }
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

els.nav.addEventListener('click', async (e) => {
  const navItem = e.target.closest('.nav-item')
  if (navItem && !e.target.closest('button')) {
    setView({ kind: navItem.dataset.view })
    return
  }
  if (e.target === els.refresh) {
    e.stopPropagation()
    await refreshAll()
    return
  }
  const actBtn = e.target.closest('button[data-act]')
  if (actBtn) {
    e.stopPropagation()
    const id = actBtn.dataset.id
    const act = actBtn.dataset.act
    if (act === 'rename-folder') {
      const f = state.store.folders.find(x => x.id === id)
      const name = await promptText('Rename folder', f.name)
      if (name && name.trim()) { f.name = name.trim(); await persist() }
    } else if (act === 'delete-folder') {
      if (await confirmAction('Delete folder? Subscriptions will move to uncategorized.')) {
        state.store.folders = state.store.folders.filter(x => x.id !== id)
        for (const s of state.store.subscriptions) if (s.folderId === id) s.folderId = null
        if (state.view.kind === 'folder' && state.view.folderId === id) setView({ kind: 'podcasts' })
        else await persist()
      }
    } else if (act === 'rename-playlist') {
      const p = state.store.playlists.find(x => x.id === id)
      const name = await promptText('Rename playlist', p.name)
      if (name && name.trim()) { p.name = name.trim(); await persist() }
    } else if (act === 'delete-playlist') {
      if (await confirmAction('Delete playlist?')) {
        state.store.playlists = state.store.playlists.filter(x => x.id !== id)
        if (state.view.kind === 'playlist' && state.view.playlistId === id) setView({ kind: 'podcasts' })
        else await persist()
      }
    }
    return
  }
  const folderRow = e.target.closest('[data-folder]')
  if (folderRow) {
    setView({ kind: 'folder', folderId: folderRow.dataset.folder })
    return
  }
  const playlistRow = e.target.closest('[data-playlist]')
  if (playlistRow) {
    setView({ kind: 'playlist', playlistId: playlistRow.dataset.playlist })
  }
})

els.addUrl.addEventListener('click', async () => {
  const url = await promptText('Podcast feed URL (RSS or Apple Podcasts page)')
  if (!url) return
  setView({ kind: 'loading' })
  try {
    const feed = await window.api.fetchFeed(url.trim())
    const canonical = feed.feedUrl || url.trim()
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
    setView({ kind: 'podcast', feedUrl: canonical, feed })
  } catch (err) {
    setView({ kind: 'error', message: `Could not load feed: ${err.message}` })
  }
})

els.newFolder.addEventListener('click', async () => {
  const name = await promptText('Folder name')
  if (!name || !name.trim()) return
  state.store.folders.push({ id: uid(), name: name.trim() })
  await persist()
})

els.newPlaylist.addEventListener('click', async () => {
  const name = await promptText('Playlist name')
  if (!name || !name.trim()) return
  const pl = { id: uid(), name: name.trim(), items: [] }
  state.store.playlists.push(pl)
  await persist()
  setView({ kind: 'playlist', playlistId: pl.id })
})

els.view.addEventListener('click', async e => {
  const card = e.target.closest('.gallery-card')
  const actBtn = e.target.closest('[data-act]')
  const v = state.view

  if (actBtn) {
    const act = actBtn.dataset.act
    if (act === 'pick-folder') {
      e.stopPropagation()
      await pickFolderFor(actBtn.dataset.feed)
      return
    }
    if (act === 'refresh-all') { await refreshAll(); return }
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
      })
      return
    }
    if (act === 'add-to-playlist' && v.kind === 'podcast') {
      const ep = v.feed.episodes[parseInt(actBtn.dataset.idx, 10)]
      await addEpisodeToPlaylistFlow({
        ...ep,
        feedUrl: v.feedUrl,
        podcastTitle: v.feed.title,
        podcastImage: v.feed.imageUrl
      })
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
    if (act === 'add-incoming' && v.kind === 'incoming') {
      const ep = allCachedEpisodes()[parseInt(actBtn.dataset.idx, 10)]
      if (ep) await addEpisodeToPlaylistFlow(ep)
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
    openFeed(card.dataset.feed)
  }
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

;(async () => {
  state.store = await window.api.getStore()
  try { state.blacklistDefaults = await window.api.getBlacklistDefaults() } catch {}
  renderSidebar()
  renderView()
  refreshAll()
  setInterval(refreshAll, 30 * 60 * 1000)
})()
