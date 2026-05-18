const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const Parser = require('rss-parser')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')

const parser = new Parser({
  customFields: {
    item: [['itunes:duration', 'itunesDuration'], ['itunes:image', 'itunesImage']]
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
  return store
}

async function saveStore (store) {
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2))
}

function createWindow () {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.loadFile('index.html')
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
      .map(item => ({
        title: item.title,
        pubDate: item.pubDate,
        description: item.contentSnippet || '',
        audioUrl: item.enclosure?.url,
        duration: item.itunesDuration || item.itunes?.duration,
        guid: item.guid || item.link || item.enclosure?.url
      }))
      .filter(e => e.audioUrl)
  }
}

ipcMain.handle('fetchFeed', (_e, feedUrl) => fetchFeedData(feedUrl))

const DISCOVER_BLACKLIST = [
  'joe rogan',
  'tucker carlson',
  'megyn kelly',
  'theo von'
]

function isBlacklisted (p) {
  const hay = `${p.collectionName || ''} ${p.artistName || ''}`.toLowerCase()
  return DISCOVER_BLACKLIST.some(term => hay.includes(term))
}

ipcMain.handle('discover', async (_e, opts = {}) => {
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
    .filter(p => p && p.feedUrl && !isBlacklisted(p))
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

ipcMain.handle('getStore', () => loadStore())
ipcMain.handle('saveStore', async (_e, store) => {
  await saveStore(store)
  return store
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
