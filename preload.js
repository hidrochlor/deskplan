// The only bridge between the page and the main process.
// The page can load/save data, manage attached files and focus the window, nothing more.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

function subscribe(channel, fn) {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('storage:load'),
  save: (data) => ipcRenderer.invoke('storage:save', data),
  saveSync: (data) => ipcRenderer.sendSync('storage:save-sync', data),
  focusWindow: () => ipcRenderer.invoke('app:focus'),
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    openLink: (url) => ipcRenderer.invoke('app:open-link', url),
    exportBackup: (data) => ipcRenderer.invoke('app:export-backup', data),
    setTitleBar: (colors) => ipcRenderer.invoke('app:set-titlebar', colors),
    setZoom: (factor) => webFrame.setZoomFactor(Math.min(1.5, Math.max(0.75, Number(factor) || 1))),
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    import: (paths) => ipcRenderer.invoke('files:import', paths),
    open: (rel) => ipcRenderer.invoke('files:open', rel),
    reveal: (rel) => ipcRenderer.invoke('files:reveal', rel),
    delete: (rel) => ipcRenderer.invoke('files:delete', rel),
    pathOf: (file) => webUtils.getPathForFile(file), // for files dropped on the window
  },
  // Calendar feeds (see main/calendar/). Each answers { ok, feed, events } or { ok: false, error }. The page never gets an address.
  feeds: {
    list: () => ipcRenderer.invoke('feeds:list'),
    add: (url) => ipcRenderer.invoke('feeds:add', url),
    refresh: (id) => ipcRenderer.invoke('feeds:refresh', id),
    remove: (id) => ipcRenderer.invoke('feeds:remove', id),
    // The phone changed the shared feed list (see main/calendar/FeedSettingsSync.js): list it again.
    onRemoteChange: (fn) => subscribe('feeds:changed-remote', fn),
  },
  // Files from the phone (see main/receiver/). The page never gets a token, only the QR picture.
  receiver: {
    status: () => ipcRenderer.invoke('receiver:status'),
    setEnabled: (on) => ipcRenderer.invoke('receiver:set-enabled', on),
    startPairing: () => ipcRenderer.invoke('receiver:start-pairing'),
    approve: (id) => ipcRenderer.invoke('receiver:approve', id),
    revoke: (id) => ipcRenderer.invoke('receiver:revoke', id),
    rename: (id, name) => ipcRenderer.invoke('receiver:rename', id, name),
    pendingReceived: () => ipcRenderer.invoke('receiver:pending-received'),
    acknowledge: (uploadIds) => ipcRenderer.invoke('receiver:acknowledge', uploadIds),
    openFile: (storedAs) => ipcRenderer.invoke('receiver:open-file', storedAs),
    revealFile: (storedAs) => ipcRenderer.invoke('receiver:reveal-file', storedAs),
    attachFile: (storedAs, uploadId) => ipcRenderer.invoke('receiver:attach-file', storedAs, uploadId),
    deleteFile: (storedAs) => ipcRenderer.invoke('receiver:delete-file', storedAs),
    openFolder: () => ipcRenderer.invoke('receiver:open-folder'),
    // Each returns a function that stops listening.
    onReceived: (fn) => subscribe('receiver:received', fn),
    onDevices: (fn) => subscribe('receiver:devices', fn),
    // The phone changed a task: handler({ op, payload }) must return { status, body }. Register once.
    onItemRequest: (handler) => subscribe('receiver:item-request', async ({ requestId, op, payload }) => {
      let reply;
      try { reply = await handler({ op, payload }); } catch (err) { console.error('[receiver] task change failed', err); reply = { status: 500, body: { error: 'server-error' } }; }
      ipcRenderer.invoke('receiver:item-reply', { requestId, reply });
    }),
  },
});
