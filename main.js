const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const Parser = require('rss-parser')

if (!app.isPackaged) {
  try {
    require('electron-reloader')(module, {
      ignore: ['store.json', 'node_modules/**', '.git/**']
    })
  } catch {}
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')

const parser = new Parser({
  customFields: {
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:image', 'itunesImage'],
      ['itunes:subtitle', 'itunesSubtitle'],
      ['itunes:summary', 'itunesSummary'],
      ['itunes:season', 'itunesSeason'],
      ['itunes:episode', 'itunesEpisode'],
      ['content:encoded', 'contentEncoded']
    ]
  }
})

async function resolveFeedUrl (url) {
  const m = url.match(/podcasts\.apple\.com\/.*?\/id(\d+)/i)
  if (!m) return url
  const r = await fetch(`https://itunes.apple.com/lookup?id=${m[1]}`)
  if (!r.ok) throw new Error(`Apple lookup failed: HTTP ${r.status}`)
  const j = await r.json()
  const feedUrl = j.results?.[0]?.feedUrl
  if (!feedUrl) throw new Error('Apple Podcasts page found, but no RSS feed listed for it')
  return feedUrl
}

function sanitizeXml (xml) {
  return xml
    .replace(/^﻿/, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
}

const storePath = () => path.join(app.getPath('userData'), 'store.json')

async function loadStore () {
  let store
  try {
    store = JSON.parse(await fs.readFile(storePath(), 'utf-8'))
  } catch {
    store = {}
  }
  store.subscriptions ||= []
  store.folders ||= []
  store.playlists ||= []
  store.discoverBlacklist ||= []
  store.inProgress ||= []
  store.favorites ||= []
  store.skippedEpisodes ||= []
  return store
}

async function saveStore (store) {
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2))
}

function createWindow () {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    backgroundColor: '#1d1d1f',
    titleBarStyle: isMac ? 'hiddenInset' : (isWin ? 'hidden' : 'default'),
    ...(isMac ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    ...(isWin ? { titleBarOverlay: { color: '#232326', symbolColor: '#e6e6e6', height: 36 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.loadFile('index.html')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

ipcMain.handle('search', async (_e, term) => {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=podcast&limit=30`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`iTunes search failed: ${r.status}`)
  const j = await r.json()
  return (j.results || [])
    .map(p => ({
      feedUrl: p.feedUrl,
      title: p.collectionName,
      artist: p.artistName,
      imageUrl: p.artworkUrl600 || p.artworkUrl100
    }))
    .filter(p => p.feedUrl)
})

async function fetchFeedData (feedUrl) {
  const resolved = await resolveFeedUrl(feedUrl)
  const r = await fetch(resolved, { redirect: 'follow' })
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${resolved}`)
  const raw = await r.text()
  const feed = await parser.parseString(sanitizeXml(raw))
  return {
    feedUrl: resolved,
    title: feed.title,
    description: feed.description,
    imageUrl: feed.image?.url || feed.itunes?.image,
    episodes: (feed.items || [])
      .map(item => {
        const itunesImage = typeof item.itunesImage === 'object'
          ? (item.itunesImage?.href || item.itunesImage?.$?.href || '')
          : (item.itunesImage || '')
        return {
          title: item.title,
          pubDate: item.pubDate,
          description: item.contentSnippet || '',
          content: item.contentEncoded || item.content || '',
          link: item.link || '',
          imageUrl: itunesImage || item.itunes?.image || '',
          author: item.creator || item.itunes?.author || '',
          subtitle: item.itunesSubtitle || item.itunes?.subtitle || '',
          summary: item.itunesSummary || item.itunes?.summary || '',
          season: item.itunesSeason || item.itunes?.season || null,
          episodeNum: item.itunesEpisode || item.itunes?.episode || null,
          audioUrl: item.enclosure?.url,
          duration: item.itunesDuration || item.itunes?.duration,
          guid: item.guid || item.link || item.enclosure?.url
        }
      })
      .filter(e => e.audioUrl)
  }
}

ipcMain.handle('fetchFeed', (_e, feedUrl) => fetchFeedData(feedUrl))

const DISCOVER_BLACKLIST_DEFAULTS = [
  'joe rogan',
  'tucker carlson',
  'megyn kelly',
  'theo von'
]

function isBlacklisted (p, terms) {
  const hay = `${p.collectionName || ''} ${p.artistName || ''}`.toLowerCase()
  return terms.some(term => term && hay.includes(term))
}

ipcMain.handle('discover', async (_e, opts = {}) => {
  const store = await loadStore()
  const terms = [
    ...DISCOVER_BLACKLIST_DEFAULTS,
    ...store.discoverBlacklist.map(t => String(t).toLowerCase())
  ]
  const country = opts.country || 'us'
  const limit = Math.min(opts.limit || 50, 50)
  const chartRes = await fetch(`https://rss.applemarketingtools.com/api/v2/${country}/podcasts/top/${limit}/podcasts.json`)
  if (!chartRes.ok) throw new Error(`Top charts fetch failed: ${chartRes.status}`)
  const chart = await chartRes.json()
  const ids = (chart.feed?.results || []).map(r => r.id).filter(Boolean)
  if (!ids.length) return []
  const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${ids.join(',')}`)
  if (!lookupRes.ok) throw new Error(`Lookup failed: ${lookupRes.status}`)
  const lookup = await lookupRes.json()
  const byId = new Map((lookup.results || []).map(r => [String(r.collectionId), r]))
  return ids
    .map(id => byId.get(String(id)))
    .filter(p => p && p.feedUrl && !isBlacklisted(p, terms))
    .map(p => ({
      feedUrl: p.feedUrl,
      title: p.collectionName,
      artist: p.artistName,
      imageUrl: p.artworkUrl600 || p.artworkUrl100
    }))
})

ipcMain.handle('refreshFeeds', async (_e, feedUrls) => {
  const results = {}
  const queue = [...feedUrls]
  const CONCURRENCY = 4
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const url = queue.shift()
      try {
        results[url] = { ok: true, feed: await fetchFeedData(url) }
      } catch (err) {
        results[url] = { ok: false, error: err.message }
      }
    }
  }))
  return results
})

ipcMain.handle('getBlacklistDefaults', () => DISCOVER_BLACKLIST_DEFAULTS.slice())
ipcMain.handle('getStore', () => loadStore())
ipcMain.handle('saveStore', async (_e, store) => {
  await saveStore(store)
  return store
})

ipcMain.handle('openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) return shell.openExternal(url)
})

ipcMain.handle('showCardMenu', (event, { items, x, y }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null
  return new Promise(resolve => {
    let chosen = null
    const menu = Menu.buildFromTemplate(items.map(it => ({
      label: it.label,
      click: () => { chosen = it.id }
    })))
    menu.popup({
      window: win,
      x: Math.round(x),
      y: Math.round(y),
      callback: () => resolve(chosen)
    })
  })
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
