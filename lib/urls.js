'use strict';

const config = require('../config');

function parse(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttps(value) {
  const url = parse(value);
  return !!url && url.protocol === 'https:';
}

function isAllowedDownloadUrl(value) {
  const url = parse(value);
  if (!url || url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return config.allowedDownloadHosts.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

module.exports = { isHttps, isAllowedDownloadUrl };
