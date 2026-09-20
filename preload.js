'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Calls the main process and unwraps its { ok, data } / { ok:false, error } reply. */
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Something went wrong.');
  return reply.data;
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Only these functions exist in the page. No Node, no file paths, no raw IPC.
contextBridge.exposeInMainWorld('launcher', {
  getInfo: () => call('app:info'),
  auth: {
    session: () => call('auth:session'),
    login: () => call('auth:login'),
    cancel: () => call('auth:cancel'),
    logout: () => call('auth:logout'),
  },
  content: {
    get: (force) => call('content:get', !!force),
  },
  extras: {
    state: () => call('extras:state'),
    download: (id) => call('extras:download', String(id)),
    cancel: (id) => call('extras:cancel', String(id)),
    open: (id) => call('extras:open', String(id)),
    remove: (id) => call('extras:remove', String(id)),
    onProgress: (callback) => subscribe('extras:progress', callback),
  },
  openLink: (url) => call('link:open', String(url)),
  installUpdate: () => call('update:install'),
  onUpdateReady: (callback) => subscribe('update:ready', callback),
});
