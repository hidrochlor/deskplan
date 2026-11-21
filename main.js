// Electron main process: window, data file, attached files. Nothing else.
// All app logic lives in renderer/.
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, protocol, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { ReceiverController } = require('./main/receiver/ReceiverController');
const { registerReceiverIpc } = require('./main/receiver/registerReceiverIpc');
const { RendererItemGateway } = require('./main/receiver/RendererItemGateway');
const { JsonFile } = require('./main/receiver/JsonFile');
const { FeedController } = require('./main/calendar/FeedController');
const { FeedFetcher } = require('./main/calendar/FeedFetcher');
const { FeedStore } = require('./main/calendar/FeedStore');
const { registerCalendarIpc } = require('./main/calendar/registerCalendarIpc');
const { FeedSettingsSync } = require('./main/calendar/FeedSettingsSync');

app.setAppUserModelId('com.deskplan.app'); // needed for Windows notifications

// Lets the page show attached photos: deskplan-file://files/<id>/<name>
protocol.registerSchemesAsPrivileged([
  { scheme: 'deskplan-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const dataFile = () => path.join(app.getPath('userData'), 'deskplan-data.json');

// Files and photos added to folders are copied here, one sub-folder per file,
// so the originals can be moved or deleted without breaking anything.
const filesDir = () => path.join(app.getPath('userData'), 'files');

/** Stored relative path -> absolute path. Refuses anything outside the files folder. */
function resolveStored(rel) {
  const root = filesDir();
  const full = path.resolve(root, String(rel || ''));
  if (!full.startsWith(root + path.sep)) throw new Error(`Not an attached file: ${rel}`);
  return full;
}

function importFile(src) {
  const name = path.basename(src);
  const id = crypto.randomUUID();
  const dir = path.join(filesDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, name));
  return { name, path: `${id}/${name}`, size: fs.statSync(src).size, ext: path.extname(name).slice(1).toLowerCase() };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Returns saved data, falls back to the backup if the main file is damaged, or null.
function readData() {
  const file = dataFile();
  for (const candidate of [file, file + '.bak']) {
    try {
      return readJson(candidate);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[storage] could not read', candidate, err.message);
    }
  }
  return null;
}

// Writes to a temp file first, then swaps it in, so a crash never leaves a half-written file.
function writeData(data) {
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    show: false,
    backgroundColor: '#0c0d12', // --frame in styles.css
    title: 'DeskPlan',
    icon: path.join(__dirname, 'build', 'icon.ico'), // taskbar and Alt+Tab (build/icon.svg is the source drawing)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d12', symbolColor: '#c9cbd3', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  // A file dropped outside a drop zone must not replace the app with that file.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

ipcMain.handle('storage:load', () => readData());
ipcMain.handle('storage:save', (_event, data) => { writeData(data); return true; });
ipcMain.on('storage:save-sync', (event, data) => {
  try { writeData(data); event.returnValue = true; } catch (err) { console.error(err); event.returnValue = false; }
});
ipcMain.handle('files:pick', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Add files', properties: ['openFile', 'multiSelections'] });
  return res.canceled ? [] : res.filePaths;
});
// Files above this size get a warning first: DeskPlan keeps its own copy, so they take disk space twice.
const LARGE_FILE = 10 * 1024 * 1024;
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

ipcMain.handle('files:import', async (_event, paths) => {
  let list = (Array.isArray(paths) ? paths : []).map((p) => {
    try { return { path: p, size: fs.statSync(p).size }; } catch { return null; }
  }).filter(Boolean);

  const large = list.filter((f) => f.size > LARGE_FILE);
  if (large.length) {
    const names = large.slice(0, 6).map((f) => `•  ${path.basename(f.path)}  (${mb(f.size)})`).join('\n');
    const more = large.length > 6 ? `\n…and ${large.length - 6} more` : '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Large files',
      message: large.length === 1 ? 'This file is larger than 10 MB' : `${large.length} files are larger than 10 MB`,
      detail: `${names}${more}\n\nDeskPlan keeps its own copy of every file you add, so these will use the same amount of space again on your disk.`,
      buttons: ['Add anyway', 'Skip large files', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return [];
    if (response === 1) list = list.filter((f) => f.size <= LARGE_FILE);
  }

  return list.flatMap((f) => {
    try { return [importFile(f.path)]; } catch (err) { console.error('[files] could not add', f.path, err.message); return []; }
  });
});
ipcMain.handle('files:open', (_event, rel) => shell.openPath(resolveStored(rel)));
ipcMain.handle('files:reveal', (_event, rel) => shell.showItemInFolder(resolveStored(rel)));
ipcMain.handle('files:delete', (_event, rel) => {
  const dir = path.dirname(resolveStored(rel));
  if (dir !== filesDir()) fs.rmSync(dir, { recursive: true, force: true });
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }));
ipcMain.handle('app:open-data-folder', () => shell.openPath(app.getPath('userData')));
// Links in notes open in the normal browser / mail app. Only web and mail links are allowed.
ipcMain.handle('app:open-link', (_event, url) => {
  if (/^(https?:|mailto:)/i.test(String(url))) return shell.openExternal(String(url));
  return null;
});
ipcMain.handle('app:export-backup', async (_event, data) => {
  const day = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export a backup',
    defaultPath: path.join(app.getPath('documents'), `deskplan-backup-${day}.json`),
    filters: [{ name: 'DeskPlan backup', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
  return res.filePath;
});
// Window-control strip colours follow the theme chosen in Settings.
ipcMain.handle('app:set-titlebar', (_event, colors) => {
  if (win && colors && typeof win.setTitleBarOverlay === 'function') {
    win.setTitleBarOverlay({ color: String(colors.color), symbolColor: String(colors.symbolColor), height: 38 });
  }
});

ipcMain.handle('app:focus', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('deskplan-file', (req) => {
      try {
        const rel = decodeURIComponent(new URL(req.url).pathname.slice(1));
        return net.fetch(pathToFileURL(resolveStored(rel)).toString());
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    // Calendar feeds (FH timetable, Moodle). Addresses are encrypted with the Windows account. Details in main/calendar/.
    const cipher = safeStorage.isEncryptionAvailable()
      ? { available: true, encrypt: (s) => safeStorage.encryptString(s).toString('base64'), decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) }
      : undefined;
    const feedStore = new FeedStore({ file: new JsonFile(path.join(app.getPath('userData'), 'calendar-feeds.json')), cipher });
    registerCalendarIpc({ ipcMain, controller: new FeedController({ store: feedStore, fetcher: new FeedFetcher({ fetch: net.fetch }) }) });
    // The feed list is shared with the phone; a change made there makes the page list the feeds again.
    const feedSettings = new FeedSettingsSync({
      store: feedStore, onChanged: () => { if (win && !win.isDestroyed()) win.webContents.send('feeds:changed-remote'); },
    });
    // Phone receiver: off until switched on in Settings. Details in main/receiver/.
    const gateway = new RendererItemGateway({ getWindow: () => win });
    const receiver = new ReceiverController({ dir: app.getPath('userData'), version: app.getVersion(), items: gateway, feedSettings });
    registerReceiverIpc({ ipcMain, shell, controller: receiver, getWindow: () => win, gateway });
    receiver.start().catch((err) => console.error('[receiver] could not start:', err));
    app.on('before-quit', () => { receiver.stop().catch(() => {}); });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
