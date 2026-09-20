'use strict';

/**
 * Downloads extras straight into the user's Downloads folder:
 *  - only https URLs on allow-listed hosts
 *  - size capped
 *  - SHA-256 must match the manifest or the file is deleted
 *  - files are NEVER executed
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

const downloadsDir = () => path.resolve(app.getPath('downloads'));
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid item.');
}

/** True only for files sitting directly inside the Downloads folder. */
function isInDownloads(filePath) {
  return typeof filePath === 'string' && norm(path.dirname(path.resolve(filePath))) === norm(downloadsDir());
}

/** file.zip, then "file (1).zip", "file (2).zip", ... so nothing is overwritten. */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i += 1) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function installedState() {
  const records = store.get('installed', {});
  const out = {};
  for (const [id, rec] of Object.entries(records)) {
    // If the user deleted or moved the file, it simply shows as not downloaded.
    if (rec && rec.filePath && isInDownloads(rec.filePath) && fs.existsSync(rec.filePath)) {
      out[id] = { version: rec.version, installedAt: rec.installedAt };
    }
  }
  return out;
}

async function download(item, onProgress) {
  assertId(item.id);
  if (active.has(item.id)) throw new Error('This file is already downloading.');
  if (!isAllowedDownloadUrl(item.url)) throw new Error('The download link is not from a trusted host.');

  const dir = downloadsDir();
  const records = store.get('installed', {});
  const previous = records[item.id];
  const previousPath = previous && previous.filePath && isInDownloads(previous.filePath) && fs.existsSync(previous.filePath) ? previous.filePath : null;

  // Updating a file we downloaded before replaces it. Otherwise never overwrite anything.
  const finalPath =
    previousPath && path.basename(previousPath) === item.fileName ? previousPath : uniquePath(dir, item.fileName);
  if (!isInDownloads(finalPath)) throw new Error('Invalid file path.');
  const tmpPath = finalPath + '.part';

  const controller = new AbortController();
  active.set(item.id, controller);

  try {
    const res = await net.fetch(item.url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (server said ${res.status}).`);
    // GitHub redirects release files to its storage servers. The SHA-256 check below is what
    // proves the file is genuine, so here we only require that the final link is https.
    if (res.url && !res.url.startsWith('https://')) throw new Error('The download was redirected to an insecure link and was blocked.');

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

    // Clean up the older version if it had a different name.
    if (previousPath && previousPath !== finalPath) await fsp.rm(previousPath, { force: true });

    records[item.id] = { version: item.version, filePath: finalPath, installedAt: Date.now() };
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
  assertId(id);
  const records = store.get('installed', {});
  const rec = records[id];
  // Only ever deletes the exact file this launcher downloaded, inside Downloads.
  if (rec && rec.filePath && isInDownloads(rec.filePath)) await fsp.rm(rec.filePath, { force: true });
  delete records[id];
  store.set('installed', records);
}

function showInFolder(id) {
  assertId(id);
  const rec = store.get('installed', {})[id];
  if (!rec || !rec.filePath || !isInDownloads(rec.filePath) || !fs.existsSync(rec.filePath)) {
    throw new Error('This file is not in your Downloads folder anymore.');
  }
  shell.showItemInFolder(rec.filePath);
}

module.exports = { download, cancel, remove, showInFolder, installedState };