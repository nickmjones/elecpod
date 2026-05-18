# elecpod

A minimal Electron podcast app for Linux. Streams only — no downloads. Vanilla JS, no build step.

## Run

```
npm install
npm start
```

If you hit a SUID sandbox error on Linux:
```
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Architecture

Three processes, three files. Talk only via IPC over `contextBridge`.

- **`main.js`** — main process. Owns persistence (`store.json` in `app.getPath('userData')`), network calls (iTunes Search/Lookup, Apple Top Charts, RSS feeds), and `rss-parser`. Registers IPC handlers: `search`, `discover`, `fetchFeed`, `refreshFeeds`, `getStore`, `saveStore`.
- **`preload.js`** — exposes those handlers as `window.api.*` via `contextBridge.exposeInMainWorld`. The key is named `api`; do not declare a top-level `let`/`const` named `api` in the renderer (ES2015 forbids it when a non-configurable global property of the same name exists — silent SyntaxError that kills the whole script).
- **`renderer.js`** — single-file UI. Imperative DOM updates. No framework. No `prompt()` / `confirm()` — Electron doesn't implement them; use the `promptText` / `confirmAction` / `pickFromList` modal helpers instead.

`index.html` is the layout; `style.css` is the (dark) theme.

## Data model

`store.json`:

```js
{
  subscriptions: [{ feedUrl, title, imageUrl, folderId | null }],
  folders:       [{ id, name }],
  playlists:     [{ id, name, items: [{ audioUrl, title, pubDate, duration, guid, feedUrl, podcastTitle, podcastImage }] }]
}
```

Episodes are *not* persisted — they're refetched from feeds at runtime into `state.episodeCache` (in-memory `Map<feedUrl, FeedData>`). Playlist items snapshot the fields they need so they keep playing even after a feed drops the episode.

## Views

State machine in `state.view = { kind, ... }`. Kinds: `podcasts` (all subs gallery), `folder` (filtered gallery), `incoming` (cross-feed episode timeline), `discover` (Apple top charts), `podcast` (feed detail), `playlist`, `search`, `loading`, `error`.

## Networking

- **Search:** `https://itunes.apple.com/search?term=…&media=podcast`
- **Apple Podcasts URL resolve:** if user pastes `podcasts.apple.com/…/idN`, look up via `https://itunes.apple.com/lookup?id=N` to get `feedUrl`.
- **Top charts:** `https://rss.applemarketingtools.com/api/v2/us/podcasts/top/50/podcasts.json` → IDs → one batched `lookup?id=…` call.
- **RSS:** raw fetch + `sanitizeXml` (strip BOM/control chars, escape stray `&`) before `rss-parser` in strict mode. Don't switch rss-parser to `xml2js: { strict: false }` — it breaks rss-parser's RSS-1/2/Atom detection.
- **Refresh:** `refreshFeeds` runs the per-feed pipeline with concurrency 4. Auto-fires on launch + every 30 min; manual via the ↻ button.

## Discover blacklist

Hard-coded in `main.js` (`DISCOVER_BLACKLIST`). Case-insensitive substring match against `collectionName` + `artistName`. Edit the array to extend.

## Drag-drop

Custom impl on `document`-level listeners. `currentDrag` module variable holds the payload (HTML5 dataTransfer is too restrictive for non-string data). Source elements carry `data-drag` (`sub` / `ep` / `pl-item`) and contextual attrs. Drop zones:

- `.nav-row[data-folder]` accepts `sub`
- `.nav-row[data-playlist]` accepts `ep`
- `.playlist-item[data-drag="pl-item"]` accepts same-playlist `pl-item` for reorder

## Audio

Single `<audio id="audio">`. `state.player.source` tracks origin; on `ended`, advances if source is a playlist.

## CSP

In `index.html` `<meta>`. Allows external https for `img-src` and `media-src`; everything else is `'self'`. Don't add inline `style=""` or `onerror=""` attrs — they trip `style-src` / `script-src`.

## Linux GPU

`app.disableHardwareAcceleration()` + disabling `VaapiVideoDecoder,VaapiVideoEncoder` in `main.js` to silence libva probe errors. No video in this app so software rendering is fine.

## Conventions

- Vanilla everything. Don't pull in React, a bundler, or TypeScript.
- New IPC: add handler in `main.js`, expose in `preload.js`, call as `window.api.X(...)` in `renderer.js`.
- Don't introduce a build step.
- Don't add inline event handler attributes.
