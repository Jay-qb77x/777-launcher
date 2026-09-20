'use strict';

/**
 * Downloads extras safely:
 *  - only https URLs on allow-listed hosts (also checked after redirects)
 *  - size capped
 *  - SHA-256 must match the manifest or the file is deleted
 *  - files are written only inside <userData>/extras/<id>/ and NEVER executed
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { app, net, shell } = require('electron');
const config = require('../config');
const store = require('./store');
const { isAllowedDownloadUrl } = require('./urls');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const active = new Map();

const root = () => path.join(app.getPath('userData'), 'extras');

function safeDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid item.');
  const base = path.resolve(root());
  const dir = path.resolve(base, id);
  if (!dir.startsWith(base + path.sep)) throw new Error('Invalid path.');
  return dir;
}

function installedState() {
  const records = store.get('installed', {});
  const out = {};
  for (const [id, rec] of Object.entries(records)) {
    try {
      if (rec && rec.fileName && fs.existsSync(path.join(safeDir(id), rec.fileName))) {
        out[id] = { version: rec.version, installedAt: rec.installedAt };
      }
    } catch {
      // ignore bad records
    }
  }
  return out;
}

async function download(item, onProgress) {
  if (active.has(item.id)) throw new Error('This file is already downloading.');
  if (!isAllowedDownloadUrl(item.url)) throw new Error('The download link is not from a trusted host.');

  const dir = safeDir(item.id);
  const finalPath = path.join(dir, item.fileName);
  const tmpPath = finalPath + '.part';
  const controller = new AbortController();
  active.set(item.id, controller);

  try {
    await fsp.mkdir(dir, { recursive: true });

    const res = await net.fetch(item.url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (server said ${res.status}).`);
    if (!isAllowedDownloadUrl(res.url)) throw new Error('The download was redirected to an untrusted host and was blocked.');

    const total = Number(res.headers.get('content-length')) || item.size || 0;
    if (total > config.maxDownloadBytes) throw new Error('This file is larger than the launcher allows.');

    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastEmit = 0;

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > config.maxDownloadBytes) return cb(new Error('This file is larger than the launcher allows.'));
        hash.update(chunk);
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          onProgress({ id: item.id, received, total });
        }
        cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmpPath), { signal: controller.signal });
    onProgress({ id: item.id, received, total: total || received });

    if (hash.digest('hex') !== item.sha256) {
      throw new Error('File check failed: the download does not match its published hash, so it was deleted.');
    }

    await fsp.rename(tmpPath, finalPath);

    const records = store.get('installed', {});
    const previous = records[item.id];
    if (previous && previous.fileName && previous.fileName !== item.fileName) {
      await fsp.rm(path.join(dir, previous.fileName), { force: true });
    }
    records[item.id] = { version: item.version, fileName: item.fileName, installedAt: Date.now() };
    store.set('installed', records);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw new Error('Cancelled');
    throw err;
  } finally {
    active.delete(item.id);
  }
}

function cancel(id) {
  const controller = active.get(id);
  if (controller) controller.abort();
  return true;
}

async function remove(id) {
  const dir = safeDir(id);
  await fsp.rm(dir, { recursive: true, force: true });
  const records = store.get('installed', {});
  delete records[id];
  store.set('installed', records);
}

function showInFolder(id) {
  const rec = store.get('installed', {})[id];
  if (!rec || !rec.fileName) throw new Error('This file is not downloaded yet.');
  shell.showItemInFolder(path.join(safeDir(id), rec.fileName));
}

module.exports = { download, cancel, remove, showInFolder, installedState };
