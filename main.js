'use strict';

const { app, BrowserWindow, ipcMain, shell, session, Menu } = require('electron');
const path = require('path');
const config = require('./config');
const store = require('./lib/store');
const auth = require('./lib/auth');
const downloads = require('./lib/downloads');
const content = require('./lib/content');
const { isHttps } = require('./lib/urls');

let win = null;
let manifest = null;

// ---------- helpers ----------

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/** Only our own bundled page (file://) may talk to the main process. */
const trusted = (event) => {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://');
};

/** Registers an IPC handler that returns { ok, data } / { ok:false, error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted sender.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Something went wrong.' };
    }
  });
}

async function getManifest(force) {
  if (!manifest || force) manifest = await content.load();
  return manifest;
}

function currentUser() {
  const session = store.get('session', null);
  return session && session.user ? session.user : null;
}

function assertAccess(m) {
  const user = currentUser();
  if (config.requireLogin && !user) throw new Error('Sign in with Discord to download files.');
  if (user && m.data.blockedUserIds.includes(user.id)) throw new Error('This account can’t download files.');
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#08090c',
    title: config.appName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links never open inside the app; https links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttps(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

// ---------- IPC ----------

handle('app:info', () => ({
  name: config.appName,
  version: app.getVersion(),
  requireLogin: config.requireLogin,
  packaged: app.isPackaged,
}));

handle('auth:session', () => store.get('session', null));

handle('auth:login', async () => {
  const user = await auth.login();
  const sessionData = { user, signedInAt: Date.now() };
  store.set('session', sessionData);
  return sessionData;
});

handle('auth:cancel', () => auth.cancel());

handle('auth:logout', () => {
  store.set('session', null);
  return true;
});

handle('content:get', (force) => getManifest(!!force));

handle('extras:state', () => downloads.installedState());

handle('extras:download', async (id) => {
  if (typeof id !== 'string') throw new Error('Invalid item.');
  const m = await getManifest(false);
  assertAccess(m);
  // The renderer only sends an id. The URL and hash always come from the validated manifest.
  const item = m.data.extras.find((e) => e.id === id);
  if (!item) throw new Error('That file is no longer available.');
  await downloads.download(item, (progress) => send('extras:progress', progress));
  return downloads.installedState();
});

handle('extras:cancel', (id) => downloads.cancel(String(id)));
handle('extras:open', (id) => downloads.showInFolder(String(id)));
handle('extras:remove', async (id) => {
  await downloads.remove(String(id));
  return downloads.installedState();
});

handle('link:open', async (url) => {
  if (!isHttps(url)) throw new Error('Only secure (https) links can be opened.');
  await shell.openExternal(url);
  return true;
});

// ---------- auto-update (packaged builds only) ----------

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }));
    autoUpdater.on('error', () => {});
    autoUpdater.checkForUpdates().catch(() => {});
    handle('update:install', () => autoUpdater.quitAndInstall());
  } catch {
    // Updater unavailable: the launcher still works.
  }
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    createWindow();
    setupUpdater();
  });

  app.on('window-all-closed', () => app.quit());
}
