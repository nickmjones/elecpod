const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('platform', process.platform)

contextBridge.exposeInMainWorld('api', {
  search: (term) => ipcRenderer.invoke('search', term),
  discover: (opts) => ipcRenderer.invoke('discover', opts),
  fetchFeed: (feedUrl) => ipcRenderer.invoke('fetchFeed', feedUrl),
  refreshFeeds: (feedUrls) => ipcRenderer.invoke('refreshFeeds', feedUrls),
  getBlacklistDefaults: () => ipcRenderer.invoke('getBlacklistDefaults'),
  getStore: () => ipcRenderer.invoke('getStore'),
  saveStore: (store) => ipcRenderer.invoke('saveStore', store)
})
