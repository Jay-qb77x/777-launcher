'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let data = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  return data;
}

function get(key, fallback) {
  const value = load()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  load()[key] = value;
  const target = file();
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

module.exports = { get, set };
