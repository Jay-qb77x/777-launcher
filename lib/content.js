'use strict';

/**
 * Loads manifest.json (news, updates, tutorials, extras) and validates every
 * field. The renderer never sees raw remote data, and a broken or tampered
 * entry is dropped instead of trusted.
 */

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const config = require('../config');
const { isHttps, isAllowedDownloadUrl } = require('./urls');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNOWFLAKE_RE = /^\d{5,25}$/;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = 100) => (Array.isArray(v) ? v.slice(0, max) : []);
const image = (v) => (isHttps(str(v, 500)) ? str(v, 500) : '');
const day = (v) => (DATE_RE.test(str(v, 10)) ? str(v, 10) : '');

function cleanExtra(e) {
  if (!e || typeof e !== 'object') return null;
  const id = str(e.id, 64);
  const fileName = str(e.fileName, 121);
  const url = str(e.url, 500);
  const sha256 = str(e.sha256, 64).toLowerCase();
  if (!ID_RE.test(id) || !FILE_RE.test(fileName) || fileName.includes('..')) return null;
  if (!SHA_RE.test(sha256) || !isAllowedDownloadUrl(url)) return null;
  if (!config.allowedExtensions.includes(path.extname(fileName).toLowerCase())) return null;

  const size = Number(e.size);
  return {
    id,
    name: str(e.name, 80) || id,
    category: str(e.category, 24) || 'Other',
    description: str(e.description, 240),
    version: str(e.version, 24) || '1',
    size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
    date: day(e.date),
    thumbnail: image(e.thumbnail),
    fileName,
    url,
    sha256,
  };
}

function validate(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const ann = m.announcement && typeof m.announcement === 'object' ? m.announcement : null;

  return {
    announcement: ann && str(ann.text, 240)
      ? { text: str(ann.text, 240), level: ann.level === 'warn' ? 'warn' : 'info' }
      : null,
    blockedUserIds: list(m.blockedUserIds, 5000).map((v) => String(v)).filter((v) => SNOWFLAKE_RE.test(v)),
    news: list(m.news, 50)
      .filter((n) => n && typeof n === 'object')
      .map((n) => ({ id: str(n.id, 64), title: str(n.title, 120), body: str(n.body, 600), date: day(n.date) }))
      .filter((n) => n.title),
    updates: list(m.updates, 50)
      .filter((u) => u && typeof u === 'object')
      .map((u) => ({
        version: str(u.version, 24),
        title: str(u.title, 120),
        date: day(u.date),
        notes: list(u.notes, 30).map((x) => str(x, 200)).filter(Boolean),
      }))
      .filter((u) => u.version || u.title),
    tutorials: list(m.tutorials, 100)
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: str(t.id, 64),
        title: str(t.title, 120),
        description: str(t.description, 240),
        duration: str(t.duration, 12),
        thumbnail: image(t.thumbnail),
        url: isHttps(str(t.url, 500)) ? str(t.url, 500) : '',
      }))
      .filter((t) => t.title && t.url),
    scripts: list(m.scripts, 100)
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        id: str(s.id, 64),
        title: str(s.title, 120),
        description: str(s.description, 240),
        duration: str(s.duration, 12),
        thumbnail: image(s.thumbnail),
        url: isHttps(str(s.url, 500)) ? str(s.url, 500) : '',
      }))
      .filter((s) => s.title && s.url),
    extras: list(m.extras, 500).map(cleanExtra).filter(Boolean),
  };
}

async function load() {
  // No URL configured yet: preview the UI with the bundled sample.
  if (!config.manifestUrl) {
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.sample.json'), 'utf8'));
    return { data: validate(sample), offline: false, sample: true, fetchedAt: Date.now() };
  }

  const cachePath = path.join(app.getPath('userData'), 'manifest-cache.json');
  try {
    const res = await net.fetch(config.manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    fs.writeFile(cachePath, JSON.stringify(raw), () => {});
    return { data: validate(raw), offline: false, sample: false, fetchedAt: Date.now() };
  } catch {
    try {
      const raw = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      return { data: validate(raw), offline: true, sample: false, fetchedAt: null };
    } catch {
      return { data: validate({}), offline: true, sample: false, fetchedAt: null };
    }
  }
}

module.exports = { load, validate };
