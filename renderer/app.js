(() => {
  'use strict';

  const api = window.launcher;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    info: null,
    session: null,
    content: null,
    offline: false,
    loading: true,
    installed: {},
    progress: {},
    errors: {},
    updateReady: null,
    view: 'home',
    filter: 'All',
    query: '',
  };

  // ---------- tiny DOM helpers (no innerHTML: remote text is never parsed as HTML) ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function icon(name, cls = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', `icon ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(2)} ${units[i]}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function hueOf(text) {
    let n = 0;
    for (const ch of String(text)) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return n;
  }

  function categoryIcon(category) {
    const c = String(category).toLowerCase();
    if (c.includes('model')) return 'box';
    if (c.includes('texture')) return 'image';
    return 'file';
  }

  function toast(message, kind = '') {
    const el = h('div', { class: `toast ${kind}`.trim(), role: 'status', text: message });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 4500);
  }

  const data = () => (state.content && state.content.data) || null;

  // ---------- shared UI pieces ----------

  function pageHead(title, subtitle) {
    return h('header', { class: 'page-head' }, h('h1', { text: title }), subtitle && h('p', { text: subtitle }));
  }

  function empty(title, body, actionLabel, onAction) {
    return h(
      'div',
      { class: 'empty' },
      h('h3', { text: title }),
      h('p', { text: body }),
      actionLabel && h('button', { class: 'btn btn-secondary', onClick: onAction, text: actionLabel })
    );
  }

  function skeletons(count = 6) {
    return h('div', { class: 'grid', 'aria-hidden': 'true' }, Array.from({ length: count }, () => h('div', { class: 'skeleton' })));
  }

  function tag(text) {
    const el = h('span', { class: 'tag', text });
    el.style.setProperty('--hue', hueOf(text));
    return el;
  }

  function thumb(item, fallbackIcon) {
    const box = h('div', { class: 'thumb' }, icon(fallbackIcon, 'thumb-icon'));
    box.style.setProperty('--hue', hueOf(item.category || item.title || 'x'));
    if (item.thumbnail) {
      const img = h('img', { src: item.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  function avatar(user) {
    const wrap = h('span', { class: 'avatar' }, (user.displayName || '?').trim().charAt(0).toUpperCase());
    if (user.avatarUrl) {
      const img = h('img', { src: user.avatarUrl, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      wrap.append(img);
    }
    return wrap;
  }

  // ---------- appearance: background color + your own picture ----------
  // Saved on this PC only (localStorage). Nothing is sent anywhere.

  const THEME_KEY = '777.theme';
  const IMAGE_KEY = '777.background';
  const DEFAULT_BG = '#08090c';
  const DEFAULT_DIM = 0.45;
  const BG_PRESETS = [
    { name: 'Default', color: '#08090c' },
    { name: 'Midnight', color: '#0b1226' },
    { name: 'Ocean', color: '#06202b' },
    { name: 'Teal', color: '#062a26' },
    { name: 'Forest', color: '#08170f' },
    { name: 'Indigo', color: '#12103a' },
    { name: 'Plum', color: '#1a0d26' },
    { name: 'Crimson', color: '#240a10' },
    { name: 'Espresso', color: '#1e130c' },
    { name: 'Graphite', color: '#1b1d22' },
    { name: 'Light', color: '#eef1f7' },
    { name: 'Cream', color: '#f4efe6' },
  ];
  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];
  const THEME_VARS = ['--bg', '--panel', '--raised', '--raised-2', '--line', '--line-strong', '--text', '--muted', '--faint'];

  const defaultTheme = () => ({ color: DEFAULT_BG, dim: DEFAULT_DIM, fx: 'none', fxColor: '#3d6bff', fxSpeed: 1 });
  let theme = defaultTheme();
  let bgImage = null;
  let themePop = null;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  function loadTheme() {
    try {
      const saved = JSON.parse(localStorage.getItem(THEME_KEY) || 'null');
      if (saved && isHex(saved.color)) theme.color = saved.color.toLowerCase();
      if (saved && typeof saved.dim === 'number') theme.dim = clamp(saved.dim, 0, 0.9);
      if (saved && FX_STYLES.some((f) => f.id === saved.fx)) theme.fx = saved.fx;
      if (saved && isHex(saved.fxColor)) theme.fxColor = saved.fxColor.toLowerCase();
      if (saved && typeof saved.fxSpeed === 'number') theme.fxSpeed = clamp(saved.fxSpeed, 0.25, 2);
      const img = localStorage.getItem(IMAGE_KEY);
      if (img && img.startsWith('data:image/')) bgImage = img;
    } catch {
      // Storage unavailable or damaged: the default look is fine.
    }
  }

  function saveTheme() {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(theme));
    } catch {
      // Not saved, but the change still applies for this session.
    }
  }

  function applyTheme() {
    const root = document.documentElement;
    const set = (name, rgb) => root.style.setProperty(name, rgbToHex(rgb));

    if (theme.color === DEFAULT_BG) {
      // Untouched: use the stylesheet's own colors exactly as designed.
      THEME_VARS.forEach((v) => root.style.removeProperty(v));
      root.removeAttribute('data-theme');
      root.style.removeProperty('color-scheme');
    } else {
      const bg = hexToRgb(theme.color);
      const light = luminance(bg) > 0.25;
      set('--bg', bg);
      if (light) {
        set('--panel', mix(bg, WHITE, 0.45));
        set('--raised', mix(bg, WHITE, 0.7));
        set('--raised-2', mix(bg, BLACK, 0.05));
        set('--line', mix(bg, BLACK, 0.11));
        set('--line-strong', mix(bg, BLACK, 0.22));
        root.style.setProperty('--text', '#10131a');
        root.style.setProperty('--muted', '#485169');
        root.style.setProperty('--faint', '#5d6780');
      } else {
        set('--panel', mix(bg, WHITE, 0.035));
        set('--raised', mix(bg, WHITE, 0.06));
        set('--raised-2', mix(bg, WHITE, 0.1));
        set('--line', mix(bg, WHITE, 0.13));
        set('--line-strong', mix(bg, WHITE, 0.21));
        ['--text', '--muted', '--faint'].forEach((v) => root.style.removeProperty(v));
      }
      root.dataset.theme = light ? 'light' : 'dark';
      root.style.colorScheme = light ? 'light' : 'dark';
    }

    const layer = $('#bg-image');
    const dim = $('#bg-dim');
    if (bgImage) {
      layer.style.backgroundImage = `url("${bgImage}")`;
      layer.classList.add('has-image');
      dim.style.opacity = String(theme.dim);
    } else {
      layer.style.backgroundImage = '';
      layer.classList.remove('has-image');
      dim.style.opacity = '0';
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file isn’t a picture the launcher can open.'));
      img.src = src;
    });
  }

  /** Shrinks the picture to screen size so it stays small enough to save. */
  async function prepareBackground(file) {
    if (!/^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type)) throw new Error('Choose a PNG, JPG, WebP or GIF picture.');
    if (file.size > 40 * 1024 * 1024) throw new Error('That picture is too large. Try one under 40 MB.');
    const img = await loadImage(await readAsDataUrl(file));
    let longest = 2200;
    let quality = 0.86;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = theme.color; // fills any transparent areas
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= 3500000) return url;
      longest = Math.round(longest * 0.75);
      quality = Math.max(0.6, quality - 0.06);
    }
    throw new Error('That picture is too large to save. Try a smaller one.');
  }

  // ---------- animated backgrounds ----------
  // Drawn on one canvas behind the app. Runs at ~30 fps and pauses when the
  // window is hidden, so it stays light on the GPU/CPU.

  const FX_STYLES = [
    { id: 'none', name: 'Off' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'particles', name: 'Particles' },
    { id: 'stars', name: 'Stars' },
  ];
  const fx = { canvas: null, ctx: null, raf: 0, w: 0, h: 0, last: 0, t: 0, items: [], resizing: false };
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const rgba = (rgb, a) => `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${a})`;

  function shiftHue(rgb, deg) {
    const [r, g, b] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let hue = 0;
    let s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
    }
    hue = (hue + deg + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    const parts = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60) % 6];
    return parts.map((v) => (v + m) * 255);
  }

  function fxResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    fx.w = window.innerWidth;
    fx.h = window.innerHeight;
    fx.canvas.width = Math.round(fx.w * dpr);
    fx.canvas.height = Math.round(fx.h * dpr);
    fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fxSeed() {
    const { w, h } = fx;
    if (theme.fx === 'particles') {
      const n = clamp(Math.round((w * h) / 15000), 35, 100);
      fx.items = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 36, vy: (Math.random() - 0.5) * 36, r: 1 + Math.random() * 1.6 }));
    } else if (theme.fx === 'stars') {
      const n = clamp(Math.round((w * h) / 5500), 80, 320);
      fx.items = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, r: 0.4 + Math.random() * 1.3, tw: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.6, z: 0.3 + Math.random() * 0.7 }));
    } else {
      const hues = [0, 40, -35, 75];
      fx.items = hues.map((hue) => ({ px: Math.random() * 6.28, py: Math.random() * 6.28, sx: 0.12 + Math.random() * 0.13, sy: 0.1 + Math.random() * 0.13, hue, size: 0.32 + Math.random() * 0.18 }));
    }
  }

  /** Draws one frame. `step` is seconds of animation time to advance (0 = still frame). */
  function drawFx(step) {
    const { ctx, w, h, items } = fx;
    ctx.clearRect(0, 0, w, h);
    const rgb = hexToRgb(theme.fxColor);
    const light = document.documentElement.dataset.theme === 'light';
    fx.t += step;

    if (theme.fx === 'aurora') {
      const reach = Math.max(w, h);
      for (const b of items) {
        const x = w * (0.5 + 0.4 * Math.sin(fx.t * b.sx + b.px));
        const y = h * (0.5 + 0.4 * Math.cos(fx.t * b.sy + b.py));
        const r = reach * b.size;
        const col = shiftHue(rgb, b.hue);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba(col, light ? 0.3 : 0.4));
        grad.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
    } else if (theme.fx === 'particles') {
      for (const p of items) {
        p.x += p.vx * step;
        p.y += p.vy * step;
        if (p.x < -10) p.x = w + 10;
        else if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        else if (p.y > h + 10) p.y = -10;
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < items.length; i += 1) {
        const a = items[i];
        for (let j = i + 1; j < items.length; j += 1) {
          const b = items[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = dx * dx + dy * dy;
          if (dist < 14400) {
            ctx.strokeStyle = rgba(rgb, (1 - dist / 14400) * 0.32);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = rgba(rgb, 0.75);
      for (const p of items) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fill();
      }
    } else if (theme.fx === 'stars') {
      const tint = light ? rgb : mix(rgb, WHITE, 0.6);
      for (const s of items) {
        s.x -= 3 * s.z * step;
        s.y += 6 * s.z * step;
        if (s.x < -4) s.x = w + 4;
        if (s.y > h + 4) s.y = -4;
        const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(fx.t * s.sp + s.tw));
        ctx.fillStyle = rgba(tint, twinkle * (0.5 + 0.5 * s.z));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.2832);
        ctx.fill();
      }
    }
  }

  function fxFrame(ts) {
    fx.raf = requestAnimationFrame(fxFrame);
    if (fx.last && ts - fx.last < 30) return; // ~30 fps is plenty for a background
    const dt = fx.last ? Math.min(0.1, (ts - fx.last) / 1000) : 0;
    fx.last = ts;
    drawFx(dt * theme.fxSpeed);
  }

  function fxStopLoop() {
    if (fx.raf) cancelAnimationFrame(fx.raf);
    fx.raf = 0;
  }

  function fxStartLoop() {
    if (fx.raf || theme.fx === 'none' || reducedMotion() || document.hidden) return;
    fx.last = 0;
    fx.raf = requestAnimationFrame(fxFrame);
  }

  /** Redraws a still frame (used when the loop isn't running, e.g. reduced motion). */
  function fxRefreshStill() {
    if (!fx.raf && theme.fx !== 'none') drawFx(0);
  }

  function applyFx() {
    if (!fx.canvas) {
      fx.canvas = $('#bg-fx');
      fx.ctx = fx.canvas.getContext('2d');
      document.addEventListener('visibilitychange', () => (document.hidden ? fxStopLoop() : fxStartLoop()));
      window.addEventListener('resize', () => {
        if (fx.resizing || theme.fx === 'none') return;
        fx.resizing = true;
        requestAnimationFrame(() => {
          fx.resizing = false;
          fxResize();
          fxSeed();
          fxRefreshStill();
        });
      });
    }
    fxStopLoop();
    if (theme.fx === 'none') {
      fx.canvas.classList.remove('is-on');
      fx.ctx.clearRect(0, 0, fx.canvas.width, fx.canvas.height);
      return;
    }
    fx.canvas.classList.add('is-on');
    fxResize();
    fxSeed();
    fx.t = 5; // start mid-cycle so a still frame already looks good
    drawFx(0);
    fxStartLoop();
  }

  function closeTheme() {
    if (!themePop) return;
    themePop.remove();
    themePop = null;
    document.removeEventListener('mousedown', onThemeOutside, true);
    document.removeEventListener('keydown', onThemeKey, true);
    const trigger = $('.avatar-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function onThemeOutside(e) {
    if (themePop && !themePop.contains(e.target) && !e.target.closest('.avatar-btn, .appearance-btn')) closeTheme();
  }

  function onThemeKey(e) {
    if (e.key === 'Escape') closeTheme();
  }

  function toggleTheme() {
    if (themePop) {
      closeTheme();
      return;
    }
    themePop = buildThemePanel();
    document.body.append(themePop);
    document.addEventListener('mousedown', onThemeOutside, true);
    document.addEventListener('keydown', onThemeKey, true);
    const trigger = $('.avatar-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    const first = $('.swatch.is-active', themePop) || $('.swatch', themePop);
    if (first) first.focus();
  }

  function buildThemePanel() {
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', class: 'is-hidden', tabindex: '-1', 'aria-hidden': 'true' });
    const colorInput = h('input', { type: 'color', value: theme.color, class: 'color-input', 'aria-label': 'Pick any background color', onInput: (e) => setColor(e.target.value) });
    const hex = h('span', { class: 'color-hex' });
    const swatches = BG_PRESETS.map((p) => {
      const btn = h('button', { class: 'swatch', title: p.name, 'aria-label': `${p.name} background`, 'data-color': p.color, onClick: () => setColor(p.color) });
      btn.style.backgroundColor = p.color;
      return btn;
    });
    const dimValue = h('span', { class: 'range-value' });
    const dimRange = h('input', {
      type: 'range',
      min: '0',
      max: '90',
      step: '5',
      value: String(Math.round(theme.dim * 100)),
      'aria-label': 'How much to darken the picture',
      onInput: (e) => {
        theme.dim = Number(e.target.value) / 100;
        dimValue.textContent = `${e.target.value}%`;
        applyTheme();
        saveTheme();
      },
    });
    const dimRow = h('div', { class: 'range-row' }, h('span', { text: 'Dim' }), dimRange, dimValue);
    const removeBtn = h('button', { class: 'btn btn-ghost btn-sm', onClick: removePicture, text: 'Remove' });

    const fxChips = FX_STYLES.map((f) => h('button', { class: 'chip', 'data-fx': f.id, onClick: () => setFx(f.id), text: f.name }));
    const fxColorInput = h('input', {
      type: 'color',
      value: theme.fxColor,
      class: 'color-input',
      'aria-label': 'Animation color',
      onInput: (e) => {
        theme.fxColor = e.target.value.toLowerCase();
        saveTheme();
        fxRefreshStill();
      },
    });
    const speedValue = h('span', { class: 'range-value' });
    const speedRange = h('input', {
      type: 'range',
      min: '25',
      max: '200',
      step: '25',
      value: String(Math.round(theme.fxSpeed * 100)),
      'aria-label': 'Animation speed',
      onInput: (e) => {
        theme.fxSpeed = Number(e.target.value) / 100;
        speedValue.textContent = `${e.target.value}%`;
        saveTheme();
      },
    });
    const fxOptions = h(
      'div',
      { class: 'fx-options' },
      h('div', { class: 'color-row' }, fxColorInput, h('span', { class: 'color-hint', text: 'Animation color' })),
      h('div', { class: 'range-row' }, h('span', { text: 'Speed' }), speedRange, speedValue),
      reducedMotion() && h('p', { class: 'theme-fine', text: 'Animations are turned off in your Windows settings, so this shows a still frame.' })
    );

    function sync() {
      colorInput.value = theme.color;
      hex.textContent = theme.color.toUpperCase();
      swatches.forEach((s) => {
        const on = s.dataset.color === theme.color;
        s.classList.toggle('is-active', on);
        s.setAttribute('aria-pressed', String(on));
      });
      fxChips.forEach((c) => {
        const on = c.dataset.fx === theme.fx;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      fxOptions.classList.toggle('is-hidden', theme.fx === 'none');
      fxColorInput.value = theme.fxColor;
      speedRange.value = String(Math.round(theme.fxSpeed * 100));
      speedValue.textContent = `${Math.round(theme.fxSpeed * 100)}%`;
      dimRow.classList.toggle('is-hidden', !bgImage);
      removeBtn.classList.toggle('is-hidden', !bgImage);
      dimRange.value = String(Math.round(theme.dim * 100));
      dimValue.textContent = `${Math.round(theme.dim * 100)}%`;
    }

    function setColor(color) {
      if (!isHex(color)) return;
      theme.color = color.toLowerCase();
      saveTheme();
      applyTheme();
      sync();
    }

    function setFx(id) {
      theme.fx = id;
      saveTheme();
      applyFx();
      sync();
    }

    function removePicture() {
      bgImage = null;
      try {
        localStorage.removeItem(IMAGE_KEY);
      } catch {
        // Nothing saved to remove.
      }
      applyTheme();
      sync();
    }

    function resetAll() {
      theme = defaultTheme();
      bgImage = null;
      try {
        localStorage.removeItem(THEME_KEY);
        localStorage.removeItem(IMAGE_KEY);
      } catch {
        // Nothing saved to remove.
      }
      applyTheme();
      applyFx();
      sync();
      toast('Appearance reset');
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const previous = bgImage;
      try {
        const url = await prepareBackground(file);
        bgImage = url;
        try {
          localStorage.setItem(IMAGE_KEY, url);
        } catch {
          bgImage = previous;
          throw new Error('Not enough space to save that picture. Try a smaller one.');
        }
        saveTheme();
        applyTheme();
        sync();
        toast('Background updated', 'ok');
      } catch (err) {
        toast(err.message || 'Could not use that picture.', 'error');
      }
    });

    const panel = h(
      'div',
      { class: 'theme-pop', role: 'dialog', 'aria-label': 'Appearance' },
      h('div', { class: 'theme-head' }, h('h2', { text: 'Appearance' }), h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: closeTheme }, icon('x'))),
      h(
        'section',
        {},
        h('div', { class: 'theme-label', text: 'Background color' }),
        h('div', { class: 'swatches' }, swatches),
        h('div', { class: 'color-row' }, colorInput, h('span', { class: 'color-hint', text: 'Any color' }), hex)
      ),
      h('section', {}, h('div', { class: 'theme-label', text: 'Animated background' }), h('div', { class: 'chips' }, fxChips), fxOptions),
      h(
        'section',
        {},
        h('div', { class: 'theme-label', text: 'Your own background' }),
        h('div', { class: 'theme-actions' }, h('button', { class: 'btn btn-secondary btn-sm', onClick: () => fileInput.click() }, icon('upload'), 'Choose picture'), removeBtn),
        dimRow,
        fileInput
      ),
      h('div', { class: 'theme-foot' }, h('button', { class: 'btn btn-ghost btn-sm', onClick: resetAll, text: 'Reset to default' }), h('p', { class: 'theme-fine', text: 'Saved on this PC only.' }))
    );
    sync();
    return panel;
  }

  // ---------- account + sign-in ----------

  function renderAccount() {
    closeTheme();
    const box = $('#account');
    box.replaceChildren();
    const user = state.session && state.session.user;
    if (!user) {
      if (!state.info.requireLogin) {
        box.append(
          h('button', { class: 'btn btn-secondary btn-sm', onClick: () => showGate('idle'), text: 'Sign in' }),
          h('button', { class: 'icon-btn appearance-btn', title: 'Appearance', 'aria-label': 'Appearance', 'aria-haspopup': 'dialog', onClick: toggleTheme }, icon('image'))
        );
      }
      return;
    }
    box.append(
      h(
        'button',
        { class: 'avatar-btn', title: 'Change background', 'aria-label': 'Appearance: change background', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: toggleTheme },
        avatar(user)
      ),
      h('span', { class: 'account-name', title: user.displayName, text: user.displayName }),
      h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onClick: signOut }, icon('logout'))
    );
  }

  function showGate(mode, message) {
    const gate = $('#gate');
    gate.classList.remove('is-hidden');
    const waiting = mode === 'waiting';
    $('#gate-title').textContent = waiting ? 'Waiting for Discord…' : 'Sign in to continue';
    $('#gate-text').textContent = waiting
      ? 'Finish signing in in your browser, then come back here.'
      : 'Use your Discord account to get in.';
    $('#gate-error').textContent = mode === 'error' ? message : '';
    $('#gate-signin').classList.toggle('is-hidden', waiting);
    $('#gate-cancel').classList.toggle('is-hidden', !(waiting || !state.info.requireLogin));
    $('#gate-cancel').textContent = waiting ? 'Cancel' : 'Not now';
    if (!waiting) $('#gate-signin').focus();
  }

  function hideGate() {
    $('#gate').classList.add('is-hidden');
  }

  async function signIn() {
    showGate('waiting');
    try {
      state.session = await api.auth.login();
      hideGate();
      renderAccount();
      renderCurrent();
    } catch (err) {
      showGate('error', err.message);
    }
  }

  async function cancelGate() {
    const waiting = $('#gate-signin').classList.contains('is-hidden');
    if (waiting) {
      await api.auth.cancel().catch(() => {});
      showGate('idle');
    } else {
      hideGate();
    }
  }

  async function signOut() {
    await api.auth.logout();
    state.session = null;
    renderAccount();
    renderCurrent();
    if (state.info.requireLogin) showGate('idle');
  }

  // ---------- banners ----------

  function banner(kind, text, actionLabel, onAction) {
    return h(
      'div',
      { class: `banner ${kind}` },
      icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'bell'),
      h('span', { class: 'banner-text', text }),
      actionLabel && h('button', { class: 'btn btn-secondary btn-sm', onClick: onAction, text: actionLabel })
    );
  }

  function renderBanners() {
    const box = $('#banner');
    box.replaceChildren();
    const c = data();
    if (state.updateReady) {
      box.append(banner('ok', `Version ${state.updateReady} is ready.`, 'Restart to update', () => api.installUpdate().catch((e) => toast(e.message, 'error'))));
    }
    if (state.content && state.content.sample) {
      box.append(banner('warn', 'Preview mode: showing sample content. Set manifestUrl in config.js to go live.'));
    } else if (state.offline) {
      box.append(banner('warn', 'You’re offline. Showing saved content; downloads need a connection.', 'Try again', () => loadContent(true)));
    }
    if (c && c.announcement) box.append(banner(c.announcement.level, c.announcement.text));
  }

  // ---------- views ----------

  function renderHome() {
    const el = $('#view-home');
    el.replaceChildren();
    const c = data();
    const name = state.session && state.session.user ? state.session.user.displayName : '';
    el.append(pageHead(name ? `Welcome back, ${name}` : 'Welcome', 'Here’s what’s new.'));

    if (state.loading && !c) {
      el.append(skeletons(3));
      return;
    }

    const news = h('div', { class: 'stack' });
    if (c && c.news.length) {
      for (const n of c.news.slice(0, 4)) {
        news.append(
          h('article', { class: 'panel' }, n.date && h('div', { class: 'news-date', text: formatDate(n.date) }), h('h3', { text: n.title }), n.body && h('p', { text: n.body }))
        );
      }
    } else {
      news.append(empty('No news yet', 'New announcements will show up here.'));
    }

    const side = h('div', { class: 'stack' });

    const newest = c ? [...c.extras].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3) : [];
    if (newest.length) {
      const rows = newest.map((item) =>
        h('button', { class: 'list-row', onClick: () => go('extras') }, h('span', { class: 'list-name', text: item.name }), tag(item.category))
      );
      side.append(h('div', { class: 'panel' }, h('div', { class: 'section-title', text: 'New in Extras' }), rows));
    }

    const latest = c && c.updates[0];
    if (latest) {
      side.append(
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'section-title', text: 'Latest update' }),
          h('div', { class: 'release-head' }, latest.version && h('span', { class: 'release-ver', text: latest.version }), h('span', { class: 'list-name', text: latest.title })),
          h('button', { class: 'btn btn-ghost btn-sm', onClick: () => go('updates'), text: 'See all updates' })
        )
      );
    }

    el.append(h('div', { class: 'home-grid' }, h('section', {}, h('div', { class: 'section-title', text: 'News' }), news), h('section', {}, side)));
  }

  function renderUpdates() {
    const el = $('#view-updates');
    el.replaceChildren();
    el.append(pageHead('Updates', 'What changed, newest first.'));
    const c = data();
    if (state.loading && !c) {
      el.append(skeletons(2));
      return;
    }
    if (!c || !c.updates.length) {
      el.append(empty('No updates yet', 'Release notes will appear here.'));
      return;
    }
    const sorted = [...c.updates].sort((a, b) => b.date.localeCompare(a.date));
    el.append(
      h(
        'div',
        { class: 'timeline' },
        sorted.map((u) =>
          h(
            'article',
            { class: 'panel release' },
            h('div', { class: 'release-head' }, u.version && h('span', { class: 'release-ver', text: u.version }), u.title && h('h3', { text: u.title }), u.date && h('span', { class: 'release-date', text: formatDate(u.date) })),
            u.notes.length > 0 && h('ul', {}, u.notes.map((n) => h('li', { text: n })))
          )
        )
      )
    );
  }

  function renderTutorials() {
    const el = $('#view-tutorials');
    el.replaceChildren();
    el.append(pageHead('Tutorials', 'Learn the workflow, step by step.'));
    const c = data();
    if (state.loading && !c) {
      el.append(skeletons(3));
      return;
    }
    if (!c || !c.tutorials.length) {
      el.append(empty('No tutorials yet', 'Video guides will appear here.'));
      return;
    }
    el.append(
      h(
        'div',
        { class: 'grid' },
        c.tutorials.map((t) => {
          const box = thumb(t, 'play');
          if (t.duration) box.append(h('span', { class: 'duration', text: t.duration }));
          return h(
            'button',
            { class: 'card', onClick: () => api.openLink(t.url).catch((e) => toast(e.message, 'error')) },
            box,
            h('div', { class: 'card-body' }, h('div', { class: 'card-title', text: t.title }), t.description && h('p', { class: 'card-desc', text: t.description }))
          );
        })
      )
    );
  }

  function renderScripts() {
    const el = $('#view-scripts');
    el.replaceChildren();
    el.append(pageHead('Scripts', 'Ready-made scripts and how to use them.'));
    const c = data();
    if (state.loading && !c) {
      el.append(skeletons(3));
      return;
    }
    const list = (c && c.scripts) || [];
    if (!list.length) {
      el.append(empty('No scripts yet', 'New scripts will appear here.'));
      return;
    }
    el.append(
      h(
        'div',
        { class: 'grid' },
        list.map((item) => {
          const box = thumb(item, 'code');
          if (item.duration) box.append(h('span', { class: 'duration', text: item.duration }));
          return h(
            'button',
            { class: 'card', onClick: () => api.openLink(item.url).catch((e) => toast(e.message, 'error')) },
            box,
            h('div', { class: 'card-body' }, h('div', { class: 'card-title', text: item.title }), item.description && h('p', { class: 'card-desc', text: item.description }))
          );
        })
      )
    );
  }

  // ----- extras -----

  function extraCard(item) {
    const installed = state.installed[item.id];
    const progress = state.progress[item.id];
    const hasUpdate = installed && installed.version !== item.version;
    const error = state.errors[item.id];

    let actions;
    if (progress) {
      actions = h(
        'div',
        { class: 'progress' },
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Downloading ${item.name}` }, h('div', { class: 'bar-fill' })),
        h('div', { class: 'progress-row' }, h('span', { class: 'pct', text: 'Starting…' }), h('button', { class: 'btn btn-ghost btn-sm', onClick: () => api.extras.cancel(item.id), text: 'Cancel' }))
      );
    } else if (installed && !hasUpdate) {
      actions = [
        h('button', { class: 'btn btn-secondary btn-grow', onClick: () => api.extras.open(item.id).catch((e) => toast(e.message, 'error')) }, icon('folder'), 'Show in folder'),
        h('button', { class: 'icon-btn danger', title: 'Remove from this PC', 'aria-label': `Remove ${item.name}`, onClick: () => removeExtra(item) }, icon('trash')),
      ];
    } else {
      actions = [
        h('button', { class: 'btn btn-primary btn-grow', onClick: () => downloadExtra(item) }, icon('download'), hasUpdate ? 'Update' : 'Download'),
        hasUpdate && h('button', { class: 'icon-btn danger', title: 'Remove from this PC', 'aria-label': `Remove ${item.name}`, onClick: () => removeExtra(item) }, icon('trash')),
      ];
    }

    const meta = [formatSize(item.size), formatDate(item.date)].filter(Boolean).join(' · ');
    const card = h(
      'article',
      { class: 'card', 'data-extra': item.id },
      thumb(item, categoryIcon(item.category)),
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'card-title', text: item.name }),
        h('div', { class: 'card-row' }, tag(item.category), meta && h('span', { class: 'card-meta', text: meta }), hasUpdate && h('span', { class: 'card-meta', text: 'Update available' })),
        item.description && h('p', { class: 'card-desc', text: item.description }),
        error && h('p', { class: 'card-error', role: 'alert', text: error }),
        h('div', { class: 'card-actions' }, actions)
      )
    );
    return card;
  }

  function renderExtrasGrid() {
    const grid = $('#extras-grid');
    if (!grid) return;
    grid.replaceChildren();
    grid.classList.add('grid');
    const c = data();
    if (state.loading && !c) {
      grid.append(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton' })));
      return;
    }
    const all = c ? c.extras : [];
    const q = state.query.trim().toLowerCase();
    const items = all.filter((e) => (state.filter === 'All' || e.category === state.filter) && (!q || `${e.name} ${e.category} ${e.description}`.toLowerCase().includes(q)));

    if (!all.length) {
      grid.classList.remove('grid');
      grid.append(empty('Nothing here yet', 'New files will show up here when they’re published.'));
      return;
    }
    if (!items.length) {
      grid.classList.remove('grid');
      grid.append(
        empty(q ? `No results for “${state.query.trim()}”` : 'No files in this category', 'Try a different search or category.', 'Clear filters', () => {
          state.query = '';
          state.filter = 'All';
          renderExtras();
        })
      );
      return;
    }
    grid.classList.add('grid');
    grid.append(...items.map(extraCard));
  }

  function renderChips() {
    const box = $('#extras-chips');
    if (!box) return;
    box.replaceChildren();
    const c = data();
    const cats = ['All', ...new Set((c ? c.extras : []).map((e) => e.category))];
    if (cats.length < 3) return; // filters only help with 2+ categories
    for (const cat of cats) {
      box.append(
        h('button', {
          class: `chip${state.filter === cat ? ' is-active' : ''}`,
          'aria-pressed': String(state.filter === cat),
          text: cat,
          onClick: () => {
            state.filter = cat;
            renderChips();
            renderExtrasGrid();
          },
        })
      );
    }
  }

  function renderExtras() {
    const el = $('#view-extras');
    el.replaceChildren();
    const search = h('input', {
      type: 'search',
      placeholder: 'Search extras…',
      'aria-label': 'Search extras',
      value: state.query,
      onInput: (e) => {
        state.query = e.target.value;
        renderExtrasGrid();
      },
    });
    el.append(
      pageHead('Extras', 'Models, textures and other files. Download and go.'),
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search), h('div', { class: 'chips', id: 'extras-chips' })),
      h('div', { class: 'grid', id: 'extras-grid' })
    );
    renderChips();
    renderExtrasGrid();
  }

  function refreshCard(id) {
    const old = document.querySelector(`[data-extra="${CSS.escape(id)}"]`);
    const c = data();
    const item = c && c.extras.find((e) => e.id === id);
    if (old && item) old.replaceWith(extraCard(item));
  }

  async function downloadExtra(item) {
    delete state.errors[item.id];
    state.progress[item.id] = { received: 0, total: item.size };
    refreshCard(item.id);
    try {
      state.installed = await api.extras.download(item.id);
      toast(`${item.name} downloaded`, 'ok');
    } catch (err) {
      if (err.message !== 'Cancelled') state.errors[item.id] = err.message;
    } finally {
      delete state.progress[item.id];
      refreshCard(item.id);
    }
  }

  async function removeExtra(item) {
    if (!window.confirm(`Remove “${item.name}” from this computer?`)) return;
    try {
      state.installed = await api.extras.remove(item.id);
      toast(`${item.name} removed`);
    } catch (err) {
      state.errors[item.id] = err.message;
    }
    refreshCard(item.id);
  }

  api.extras.onProgress((p) => {
    if (!state.progress[p.id]) return;
    state.progress[p.id] = p;
    const card = document.querySelector(`[data-extra="${CSS.escape(p.id)}"]`);
    if (!card) return;
    const fill = card.querySelector('.bar-fill');
    const label = card.querySelector('.pct');
    if (!fill || !label) return;
    const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    card.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    label.textContent = p.total ? `${Math.round(pct)}% · ${formatSize(p.received)} of ${formatSize(p.total)}` : formatSize(p.received);
  });

  // ---------- navigation + loading ----------

  const renderers = { home: renderHome, updates: renderUpdates, tutorials: renderTutorials, scripts: renderScripts, extras: renderExtras };

  function renderCurrent() {
    renderers[state.view]();
  }

  function go(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('is-active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
    $('#content').scrollTop = 0;
    renderCurrent();
  }

  async function loadContent(force = false) {
    state.loading = true;
    renderCurrent();
    try {
      state.content = await api.content.get(force);
      state.offline = !!state.content.offline;
      state.installed = await api.extras.state();
    } catch (err) {
      toast(err.message, 'error');
    }
    state.loading = false;
    renderBanners();
    renderCurrent();
  }

  async function init() {
    state.info = await api.getInfo();
    document.title = state.info.name;

    document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.view)));
    $('#gate-signin').addEventListener('click', signIn);
    $('#gate-cancel').addEventListener('click', cancelGate);

    api.onUpdateReady(({ version }) => {
      state.updateReady = version;
      renderBanners();
    });

    state.session = await api.auth.session();
    renderAccount();
    if (state.info.requireLogin && !state.session) showGate('idle');

    await loadContent();
  }

  loadTheme();
  applyTheme();
  applyFx();
  init().catch((err) => toast(err.message || 'The launcher could not start.', 'error'));
})();
