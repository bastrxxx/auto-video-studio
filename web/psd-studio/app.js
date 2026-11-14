/* PSD Studio - đọc / chỉnh sửa / xuất file Photoshop ngay trên trình duyệt (local) */
(() => {
  'use strict';
  const { readPsd, writePsd } = window.agPsd;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- state
  const state = {
    psd: null,
    fileName: '',
    fileSize: 0,
    selected: null,
    zoom: 1,
    showOriginal: false,
    showFx: true,
    dirty: false,
    undo: [],
    expanded: new Set(),
    origComposite: null,
    fitMode: 'cover',
    applyAllInstances: true,
  };
  let renderCache = new WeakMap();
  let thumbCache = new WeakMap();
  const maskCache = new WeakMap();
  const soPreviewCache = new WeakMap();
  const parentMap = new WeakMap();
  const uidMap = new WeakMap();
  let uidCounter = 0;
  const uid = (l) => { let u = uidMap.get(l); if (!u) { u = ++uidCounter; uidMap.set(l, u); } return u; };

  const BLEND = {
    'normal': 'source-over', 'pass through': 'source-over', 'dissolve': 'source-over',
    'darken': 'darken', 'multiply': 'multiply', 'color burn': 'color-burn', 'linear burn': 'multiply', 'darker color': 'darken',
    'lighten': 'lighten', 'screen': 'screen', 'color dodge': 'color-dodge', 'linear dodge': 'lighter', 'lighter color': 'lighten',
    'overlay': 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'hard-light', 'linear light': 'hard-light',
    'pin light': 'hard-light', 'hard mix': 'hard-light', 'difference': 'difference', 'exclusion': 'exclusion', 'subtract': 'difference',
    'divide': 'color-dodge', 'hue': 'hue', 'saturation': 'saturation', 'color': 'color', 'luminosity': 'luminosity',
  };
  const BLEND_NAMES = Object.keys(BLEND);
  const blendOp = (m) => BLEND[m] || 'source-over';

  const KIND_LABEL = {
    group: 'Nhóm (Group)', adjustment: 'Adjustment layer', text: 'Text layer', smart: 'Smart Object',
    fill: 'Fill / Shape layer', raster: 'Layer ảnh (Raster)', empty: 'Layer rỗng',
  };

  // ---------------------------------------------------------------- helpers
  // Canvas dùng bộ nhớ CPU (willReadFrequently) để Chrome không "đánh rơi" nội dung
  // khi có hàng trăm canvas lớn (GPU context lost) với file PSD nặng.
  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    c.getContext('2d', { willReadFrequently: true });
    return c;
  }
  if (window.agPsd.initializeCanvas) {
    window.agPsd.initializeCanvas((w, h) => createCanvas(w, h));
  }
  const ctx2d = (c) => { const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; return x; };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uv = (u) => (u == null ? 0 : typeof u === 'number' ? u : u.value || 0);
  const docW = () => state.psd.width;
  const docH = () => state.psd.height;
  const baseName = () => state.fileName.replace(/\.(psd|psb)$/i, '');

  function toRGB(c) {
    if (!c) return [0, 0, 0];
    if ('r' in c) return [c.r, c.g, c.b];
    if ('fr' in c) return [c.fr * 255, c.fg * 255, c.fb * 255];
    if ('c' in c && 'k' in c) {
      const k = c.k / 255;
      return [255 * (1 - c.c / 255) * (1 - k), 255 * (1 - c.m / 255) * (1 - k), 255 * (1 - c.y / 255) * (1 - k)];
    }
    if ('k' in c) return [255 - c.k, 255 - c.k, 255 - c.k];
    if ('h' in c) {
      const h = c.h / 60, s = c.s, v = c.b * 255, i = Math.floor(h) % 6, f = h - Math.floor(h);
      const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
      return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
    }
    return [0, 0, 0];
  }
  const rgba = (c, a = 1) => { const [r, g, b] = toRGB(c); return `rgba(${r | 0},${g | 0},${b | 0},${a})`; };

  // type: false | true (lỗi) | 'error' | 'success'
  function toast(msg, type = false, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    const cls = type === true || type === 'error' ? ' error' : type === 'success' ? ' success' : '';
    t.className = 'toast' + cls;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function showOverlay(text) { $('overlayText').textContent = text; $('overlay').hidden = false; }
  function hideOverlay() { $('overlay').hidden = true; }

  // ---------------------------------------------------------------- layer tree helpers
  function indexParents() {
    const walk = (arr, parent) => arr.forEach((l) => { parentMap.set(l, parent); if (l.children) walk(l.children, l); });
    walk(state.psd.children || [], null);
  }
  const siblingsOf = (l) => { const p = parentMap.get(l); return p ? p.children : state.psd.children; };
  function allLayers(arr = state.psd?.children || [], out = []) {
    for (const l of arr) { out.push(l); if (l.children) allLayers(l.children, out); }
    return out;
  }
  const inDocument = (l) => allLayers().includes(l);

  function layerKind(l) {
    if (l.children) return 'group';
    if (l.adjustment) return 'adjustment';
    if (l.text) return 'text';
    if (l.placedLayer) return 'smart';
    if (l.vectorFill) return 'fill';
    if (!l.canvas) return 'empty';
    return 'raster';
  }
  const effectList = (a) => (Array.isArray(a) ? a : a ? [a] : []).filter((e) => e && e.enabled);
  function hasFx(l) {
    const fx = l.effects;
    if (!fx || fx.disabled) return false;
    return ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'solidFill', 'satin', 'stroke', 'gradientOverlay', 'patternOverlay']
      .some((k) => effectList(fx[k]).length);
  }
  const hasMask = (l) => !!(l.mask && l.mask.canvas && !l.mask.disabled);

  function layerBounds(l) {
    if (l.children) {
      let b = null;
      for (const c of l.children) {
        const cb = layerBounds(c);
        if (!cb) continue;
        b = b ? { left: Math.min(b.left, cb.left), top: Math.min(b.top, cb.top), right: Math.max(b.right, cb.right), bottom: Math.max(b.bottom, cb.bottom) } : { ...cb };
      }
      return b;
    }
    const left = l.left || 0, top = l.top || 0, right = l.right || 0, bottom = l.bottom || 0;
    if (right - left < 1 || bottom - top < 1) return null;
    return { left, top, right, bottom };
  }
  const findLinked = (id) => (state.psd.linkedFiles || []).find((f) => f.id === id);
  const soInstances = (id) => allLayers().filter((l) => l.placedLayer && l.placedLayer.id === id);

  function fileTypeOf(data) {
    if (!data || data.length < 4) return null;
    if (data[0] === 0x89 && data[1] === 0x50) return 'png';
    if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
    if (data[0] === 0x38 && data[1] === 0x42 && data[2] === 0x50 && data[3] === 0x53) return 'psd';
    if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
    if (data[0] === 0x25 && data[1] === 0x50) return 'pdf';
    if (data[0] === 0x52 && data[1] === 0x49) return 'webp';
    return null;
  }

  // ---------------------------------------------------------------- rendering
  function maskAlpha(mask) {
    let m = maskCache.get(mask.canvas);
    if (m) return m;
    const mc = mask.canvas;
    m = createCanvas(mc.width, mc.height);
    const x = m.getContext('2d', { willReadFrequently: true });
    x.drawImage(mc, 0, 0);
    const id = x.getImageData(0, 0, m.width, m.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) { d[i + 3] = Math.round((d[i] * d[i + 3]) / 255); d[i] = d[i + 1] = d[i + 2] = 0; }
    x.putImageData(id, 0, 0);
    maskCache.set(mask.canvas, m);
    return m;
  }
  // áp mask (toạ độ document) lên canvas src đặt tại (L,T)
  function applyMask(src, L, T, mask) {
    const w = src.width, h = src.height;
    const out = createCanvas(w, h), x = out.getContext('2d');
    x.drawImage(src, 0, 0);
    const m = createCanvas(w, h), mx = m.getContext('2d');
    const def = (mask.defaultColor ?? 0) / 255;
    const ml = (mask.left || 0) - L, mt = (mask.top || 0) - T;
    if (def > 0) {
      mx.fillStyle = `rgba(0,0,0,${def})`;
      mx.fillRect(0, 0, w, h);
      mx.clearRect(ml, mt, mask.canvas.width, mask.canvas.height);
    }
    mx.drawImage(maskAlpha(mask), ml, mt);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(m, 0, 0);
    return out;
  }
  function silhouette(src, color) {
    const c = createCanvas(src.width, src.height), x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function dilate(src, r) {
    const c = createCanvas(src.width, src.height), x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    if (r <= 0) return c;
    for (const rr of [r, r * 0.66, r * 0.33]) {
      const n = Math.min(48, Math.max(8, Math.ceil((2 * Math.PI * rr) / 1.5)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        x.drawImage(src, Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    return c;
  }
  function drawShadow(x, img, dx, dy, blur, color) {
    const OFF = img.width + 2000;
    x.save();
    x.shadowColor = color;
    x.shadowBlur = blur;
    x.shadowOffsetX = dx + OFF;
    x.shadowOffsetY = dy;
    x.drawImage(img, -OFF, 0);
    x.restore();
  }
  function gradientStyle(x, g, e, bx, by, bw, bh) {
    const ang = ((e.angle ?? 90) * Math.PI) / 180;
    const cx = bx + bw / 2, cy = by + bh / 2;
    let grad;
    if (e.type === 'radial' || e.style === 'radial') {
      grad = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bw, bh) / 2);
    } else {
      const len = Math.abs(bw * Math.cos(ang)) + Math.abs(bh * Math.sin(ang));
      const dx = (Math.cos(ang) * len) / 2, dy = (Math.sin(ang) * len) / 2;
      grad = e.reverse ? x.createLinearGradient(cx + dx, cy - dy, cx - dx, cy + dy) : x.createLinearGradient(cx - dx, cy + dy, cx + dx, cy - dy);
    }
    const norm = (v) => (v > 1 ? v / 4096 : v);
    const ops = (g.opacityStops || []).map((s) => ({ loc: norm(s.location), op: s.opacity ?? 1 })).sort((a, b) => a.loc - b.loc);
    const opAt = (loc) => {
      if (!ops.length) return 1;
      if (loc <= ops[0].loc) return ops[0].op;
      for (let i = 1; i < ops.length; i++) {
        if (loc <= ops[i].loc) { const a = ops[i - 1], b = ops[i]; return a.op + ((b.op - a.op) * (loc - a.loc)) / (b.loc - a.loc || 1); }
      }
      return ops[ops.length - 1].op;
    };
    const stops = (g.colorStops || []).map((s) => ({ loc: Math.min(1, Math.max(0, norm(s.location))), color: s.color })).sort((a, b) => a.loc - b.loc);
    if (!stops.length) return null;
    stops.forEach((s) => grad.addColorStop(s.loc, rgba(s.color, opAt(s.loc))));
    return grad;
  }

  // Render một layer thường (không phải group): áp mask + hiệu ứng. Kết quả được cache.
  function renderLeaf(l) {
    let res = renderCache.get(l);
    if (res) return res;
    const src = l.canvas;
    if (!src || !src.width || !src.height || l.adjustment) return null;
    const L = l.left || 0, T = l.top || 0;
    const content = hasMask(l) ? applyMask(src, L, T, l.mask) : src;
    const fillOp = l.fillOpacity ?? 1;
    const fx = state.showFx && l.effects && !l.effects.disabled ? l.effects : null;
    const drops = fx ? effectList(fx.dropShadow) : [];
    const glows = fx ? effectList(fx.outerGlow) : [];
    const strokes = fx ? effectList(fx.stroke) : [];
    const fills = fx ? effectList(fx.solidFill) : [];
    const grads = fx ? effectList(fx.gradientOverlay) : [];

    if (!drops.length && !glows.length && !strokes.length && !fills.length && !grads.length && fillOp >= 1) {
      res = { canvas: content, dx: 0, dy: 0, shape: content };
    } else {
      let pad = 4;
      drops.forEach((d) => (pad = Math.max(pad, uv(d.size) + uv(d.distance) + 4)));
      glows.forEach((g) => (pad = Math.max(pad, uv(g.size) * 1.5 + 4)));
      strokes.forEach((s) => (pad = Math.max(pad, uv(s.size) + 4)));
      pad = Math.ceil(pad);
      const w = content.width, h = content.height, W = w + pad * 2, H = h + pad * 2;
      const shape = createCanvas(W, H);
      shape.getContext('2d').drawImage(content, pad, pad);
      const out = createCanvas(W, H), ox = out.getContext('2d');
      const gAngle = state.psd.imageResources?.globalAngle ?? 120;

      for (const d of drops) {
        const a = ((d.useGlobalLight ? gAngle : d.angle ?? gAngle) * Math.PI) / 180;
        const dist = uv(d.distance);
        drawShadow(ox, shape, -Math.cos(a) * dist, Math.sin(a) * dist, uv(d.size), rgba(d.color, d.opacity ?? 0.75));
      }
      for (const g of glows) {
        const col = g.color ? rgba(g.color, g.opacity ?? 0.75) : 'rgba(255,255,190,0.75)';
        drawShadow(ox, shape, 0, 0, uv(g.size), col);
        drawShadow(ox, shape, 0, 0, uv(g.size) / 2, col);
      }
      // nội dung + overlay (bị ảnh hưởng bởi fill opacity)
      const cont = createCanvas(W, H), cx = cont.getContext('2d');
      cx.drawImage(content, pad, pad);
      cx.globalCompositeOperation = 'source-atop';
      for (const g of grads) {
        const st = gradientStyle(cx, g.gradient || {}, g, pad, pad, w, h);
        if (!st) continue;
        cx.globalAlpha = g.opacity ?? 1;
        cx.fillStyle = st;
        cx.fillRect(0, 0, W, H);
      }
      for (const f of fills) {
        cx.globalAlpha = f.opacity ?? 1;
        cx.fillStyle = rgba(f.color);
        cx.fillRect(0, 0, W, H);
      }
      ox.globalAlpha = fillOp;
      ox.drawImage(cont, 0, 0);
      ox.globalAlpha = 1;
      // stroke
      for (const s of strokes) {
        const r = uv(s.size);
        const color = s.fillType === 'gradient' && s.gradient?.colorStops?.length ? rgba(s.gradient.colorStops[0].color) : rgba(s.color);
        const pos = s.position || 'outside';
        const parts = [];
        const outside = (rad) => {
          const d = dilate(silhouette(shape, color), rad), dx = d.getContext('2d');
          dx.globalCompositeOperation = 'destination-out';
          dx.drawImage(shape, 0, 0);
          parts.push(d);
        };
        const inside = (rad) => {
          const inv = createCanvas(W, H), ix = inv.getContext('2d');
          ix.fillStyle = color; ix.fillRect(0, 0, W, H);
          ix.globalCompositeOperation = 'destination-out'; ix.drawImage(shape, 0, 0);
          const d = dilate(inv, rad), dx = d.getContext('2d');
          dx.globalCompositeOperation = 'destination-in'; dx.drawImage(shape, 0, 0);
          parts.push(d);
        };
        if (pos === 'outside') outside(r);
        else if (pos === 'inside') inside(r);
        else { outside(r / 2); inside(r / 2); }
        ox.globalAlpha = s.opacity ?? 1;
        parts.forEach((p) => ox.drawImage(p, 0, 0));
        ox.globalAlpha = 1;
      }
      res = { canvas: out, dx: -pad, dy: -pad, shape: content };
    }
    renderCache.set(l, res);
    return res;
  }

  // Trả về {canvas, x, y, shape, sx, sy} theo toạ độ document
  function renderNode(l) {
    if (l.children) {
      const off = createCanvas(docW(), docH());
      compositeList(l.children, off.getContext('2d'));
      const c = hasMask(l) ? applyMask(off, 0, 0, l.mask) : off;
      return { canvas: c, x: 0, y: 0, shape: c, sx: 0, sy: 0 };
    }
    const r = renderLeaf(l);
    if (!r) return null;
    const L = l.left || 0, T = l.top || 0;
    return { canvas: r.canvas, x: L + r.dx, y: T + r.dy, shape: r.shape, sx: L, sy: T };
  }

  function compositeList(layers, ctx) {
    for (let i = 0; i < layers.length;) {
      const L = layers[i];
      const clips = [];
      let j = i + 1;
      while (j < layers.length && layers[j].clipping) { clips.push(layers[j]); j++; }
      i = j;
      if (L.hidden) continue;
      const visClips = clips.filter((c) => !c.hidden);
      if (L.children && (L.blendMode === 'pass through' || !L.blendMode) && !visClips.length && (L.opacity ?? 1) >= 1 && !hasMask(L)) {
        compositeList(L.children, ctx);
        continue;
      }
      const base = renderNode(L);
      if (!base) continue;
      let img = base.canvas, x = base.x, y = base.y;
      if (visClips.length) {
        const off = createCanvas(docW(), docH()), ox = off.getContext('2d');
        ox.drawImage(base.canvas, base.x, base.y);
        for (const c of visClips) {
          const r = renderNode(c);
          if (!r) continue;
          const tmp = createCanvas(docW(), docH()), tx = tmp.getContext('2d');
          tx.globalAlpha = c.opacity ?? 1;
          tx.drawImage(r.canvas, r.x, r.y);
          tx.globalAlpha = 1;
          tx.globalCompositeOperation = 'destination-in';
          tx.drawImage(base.shape, base.sx, base.sy);
          ox.globalCompositeOperation = blendOp(c.blendMode);
          ox.drawImage(tmp, 0, 0);
          ox.globalCompositeOperation = 'source-over';
        }
        img = off; x = 0; y = 0;
      }
      ctx.save();
      ctx.globalAlpha = L.opacity ?? 1;
      ctx.globalCompositeOperation = blendOp(L.blendMode);
      ctx.drawImage(img, x, y);
      ctx.restore();
    }
  }

  function renderComposite(forceFx = true) {
    const prev = state.showFx;
    if (forceFx && !prev) { state.showFx = true; renderCache = new WeakMap(); }
    const c = createCanvas(docW(), docH());
    const x = c.getContext('2d');
    if (state.psd.children?.length) compositeList(state.psd.children, x);
    else if (state.origComposite) x.drawImage(state.origComposite, 0, 0);
    if (forceFx && !prev) { state.showFx = prev; renderCache = new WeakMap(); }
    return c;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (!state.psd) return;
    const c = $('viewCanvas');
    if (c.width !== docW() || c.height !== docH()) { c.width = docW(); c.height = docH(); }
    const x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (state.showOriginal && state.origComposite) x.drawImage(state.origComposite, 0, 0);
    else if (state.psd.children?.length) compositeList(state.psd.children, x);
    else if (state.origComposite) x.drawImage(state.origComposite, 0, 0);
    $('badgeOriginal').hidden = !state.showOriginal;
    updateSelBox();
  }

  function invalidate(l) {
    renderCache.delete(l);
    thumbCache.delete(l);
  }

  // ---------------------------------------------------------------- image helpers
  function drawFit(x, img, w, h, fit) {
    const iw = img.width, ih = img.height;
    x.imageSmoothingQuality = 'high';
    if (fit === 'stretch') return x.drawImage(img, 0, 0, w, h);
    const s = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  // thu nhỏ nhiều bước để giữ chất lượng
  function resizeSmooth(img, tw, th) {
    let cur = img, cw = img.width, ch = img.height;
    while (cw / 2 >= tw && ch / 2 >= th) {
      cw = Math.round(cw / 2); ch = Math.round(ch / 2);
      const c = createCanvas(cw, ch);
      ctx2d(c).drawImage(cur, 0, 0, cw, ch);
      cur = c;
    }
    return cur;
  }
  const canvasToBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
  async function canvasToBytes(c, type = 'image/png', q) {
    const b = await canvasToBlob(c, type, q);
    return new Uint8Array(await b.arrayBuffer());
  }
  function bitmapToCanvas(bmp) {
    const c = createCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c;
  }

  // vẽ nội dung smart object theo transform (4 góc) của layer
  function renderPlaced(l, img, cw, ch) {
    const t = l.placedLayer.transform;
    const xs = [t[0], t[2], t[4], t[6]], ys = [t[1], t[3], t[5], t[7]];
    const minX = Math.floor(Math.min(...xs)), minY = Math.floor(Math.min(...ys));
    const maxX = Math.ceil(Math.max(...xs)), maxY = Math.ceil(Math.max(...ys));
    const ew = Math.hypot(t[2] - t[0], t[3] - t[1]), eh = Math.hypot(t[6] - t[0], t[7] - t[1]);
    const src = resizeSmooth(img, Math.max(1, ew), Math.max(1, eh));
    const sw = src.width, sh = src.height;
    const c = createCanvas(maxX - minX, maxY - minY), x = ctx2d(c);
    x.setTransform((t[2] - t[0]) / sw, (t[3] - t[1]) / sw, (t[6] - t[0]) / sh, (t[7] - t[1]) / sh, t[0] - minX, t[1] - minY);
    x.drawImage(src, 0, 0, sw, sh);
    l.canvas = c;
    delete l.imageData;
    l.left = minX; l.top = minY; l.right = minX + c.width; l.bottom = minY + c.height;
    void cw; void ch;
  }

  function snapshot(l) {
    return {
      canvas: l.canvas, imageData: l.imageData, left: l.left, top: l.top, right: l.right, bottom: l.bottom, text: l.text,
      placed: l.placedLayer ? { id: l.placedLayer.id, width: l.placedLayer.width, height: l.placedLayer.height, type: l.placedLayer.type } : null,
    };
  }
  function restore(l, s) {
    Object.assign(l, { canvas: s.canvas, imageData: s.imageData, left: s.left, top: s.top, right: s.right, bottom: s.bottom });
    if (s.text) l.text = s.text; else delete l.text;
    if (s.placed && l.placedLayer) Object.assign(l.placedLayer, s.placed);
    invalidate(l);
  }

  // ---------------------------------------------------------------- edit operations
  function pushUndo(label, fn) {
    state.undo.push({ label, fn });
    if (state.undo.length > 60) state.undo.shift();
    state.dirty = true;
    updateButtons();
  }
  function undo() {
    const u = state.undo.pop();
    if (!u) return;
    textSession = null;
    u.fn();
    renderCache = new WeakMap();
    thumbCache = new WeakMap();
    indexParents();
    if (state.selected && !inDocument(state.selected)) state.selected = null;
    buildLayerList();
    buildProps();
    scheduleRender();
    updateButtons();
    toast('Đã hoàn tác: ' + u.label);
  }

  function moveLayer(l, dx, dy) {
    if (!dx && !dy) return;
    if (l.children) { l.children.forEach((c) => moveLayer(c, dx, dy)); }
    else {
      if (l.right - l.left > 0 || l.canvas) { l.left = (l.left || 0) + dx; l.right = (l.right || 0) + dx; l.top = (l.top || 0) + dy; l.bottom = (l.bottom || 0) + dy; }
      if (l.placedLayer) {
        const sh = (arr) => arr && arr.forEach((v, i) => (arr[i] = v + (i % 2 ? dy : dx)));
        sh(l.placedLayer.transform);
        sh(l.placedLayer.nonAffineTransform);
      }
      if (l.text && Array.isArray(l.text.transform)) { l.text.transform[4] += dx; l.text.transform[5] += dy; }
      if (l.vectorMask?.paths) l.vectorMask.paths.forEach((p) => p.knots?.forEach((k) => k.points.forEach((v, i) => (k.points[i] = v + (i % 2 ? dy : dx)))));
    }
    if (l.mask && l.mask.canvas) {
      l.mask.left = (l.mask.left || 0) + dx; l.mask.right = (l.mask.right || 0) + dx;
      l.mask.top = (l.mask.top || 0) + dy; l.mask.bottom = (l.mask.bottom || 0) + dy;
    }
  }

  function setHidden(l, hidden) {
    const old = !!l.hidden;
    if (old === hidden) return;
    l.hidden = hidden;
    pushUndo(hidden ? 'Ẩn layer' : 'Hiện layer', () => (l.hidden = old));
    scheduleRender();
  }

  function deleteLayer(l) {
    if (!l) return;
    const sib = siblingsOf(l);
    const idx = sib.indexOf(l);
    if (idx < 0) return;
    sib.splice(idx, 1);
    pushUndo('Xóa layer "' + l.name + '"', () => sib.splice(idx, 0, l));
    state.selected = sib[Math.min(idx, sib.length - 1)] || parentMap.get(l) || null;
    indexParents();
    buildLayerList();
    buildProps();
    scheduleRender();
    toast('Đã xóa layer "' + l.name + '" (Ctrl+Z để hoàn tác)');
  }

  function reorderLayer(l, dir) {
    const sib = siblingsOf(l);
    const i = sib.indexOf(l), j = i + dir;
    if (j < 0 || j >= sib.length) return;
    [sib[i], sib[j]] = [sib[j], sib[i]];
    pushUndo('Đổi thứ tự layer', () => { [sib[i], sib[j]] = [sib[j], sib[i]]; });
    buildLayerList();
    scheduleRender();
  }

  async function replaceLayerImage(l, file, fit = state.fitMode, allInstances = state.applyAllInstances) {
    if (!l || l.children || l.adjustment) { toast('Layer này không thể thay ảnh', true); return; }
    showOverlay('Đang thay thế ảnh...');
    await nextFrame();
    try {
      const bmp = await createImageBitmap(file);
      if (l.placedLayer) await replaceSmartObject(l, file, bmp, fit, allInstances);
      else replaceRaster(l, bmp, fit);
      buildLayerList();
      buildProps();
      scheduleRender();
      toast('Đã thay ảnh cho "' + l.name + '"', 'success');
    } catch (err) {
      console.error(err);
      toast('Không thể thay ảnh: ' + err.message, true, 5000);
    } finally { hideOverlay(); }
  }

  function replaceRaster(l, bmp, fit) {
    const snap = snapshot(l);
    let b = layerBounds(l) || { left: 0, top: 0, right: docW(), bottom: docH() };
    const bw = b.right - b.left, bh = b.bottom - b.top;
    let c;
    if (fit === 'original') {
      c = bitmapToCanvas(bmp);
      l.left = Math.round(b.left + bw / 2 - c.width / 2);
      l.top = Math.round(b.top + bh / 2 - c.height / 2);
    } else {
      c = createCanvas(bw, bh);
      drawFit(ctx2d(c), resizeSmooth(bmp, bw, bh), bw, bh, fit);
      l.left = b.left; l.top = b.top;
    }
    l.canvas = c;
    delete l.imageData;
    l.right = l.left + c.width;
    l.bottom = l.top + c.height;
    if (l.text) delete l.text; // text layer -> layer ảnh
    if (l.vectorFill) delete l.vectorFill;
    invalidate(l);
    pushUndo('Thay ảnh "' + l.name + '"', () => restore(l, snap));
  }

  async function replaceSmartObject(l, file, bmp, fit, allInstances) {
    const pl = l.placedLayer;
    const lf = findLinked(pl.id);
    const ow = pl.width || bmp.width, oh = pl.height || bmp.height;
    const target = ow / oh, iw = bmp.width, ih = bmp.height, ia = iw / ih;
    let content, cw, ch, data = null, type = null, name = file.name;
    const nativeType = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'JPEG' : null;

    if (fit === 'stretch' || Math.abs(ia - target) / target < 0.005) {
      content = bmp; cw = iw; ch = ih;
      if (nativeType) { data = new Uint8Array(await file.arrayBuffer()); type = nativeType; }
    } else {
      if (fit === 'cover') {
        if (ia > target) { ch = ih; cw = Math.round(ih * target); } else { cw = iw; ch = Math.round(iw / target); }
      } else { // contain / original
        if (ia > target) { cw = iw; ch = Math.round(iw / target); } else { ch = ih; cw = Math.round(ih * target); }
      }
      content = createCanvas(cw, ch);
      drawFit(ctx2d(content), bmp, cw, ch, fit === 'cover' ? 'cover' : 'contain');
    }
    if (!data) {
      const c = content instanceof HTMLCanvasElement ? content : bitmapToCanvas(content);
      data = await canvasToBytes(c, 'image/png');
      type = 'png';
      name = name.replace(/\.[^.]+$/, '') + '.png';
    }

    const instances = soInstances(pl.id);
    const targets = allInstances ? instances : [l];
    const snaps = targets.map((t) => [t, snapshot(t)]);
    let undoLinked;

    if (!lf || (!allInstances && instances.length > 1)) {
      // tạo file nhúng mới riêng cho layer này
      const nf = { id: crypto.randomUUID(), name, type, creator: lf?.creator, data };
      state.psd.linkedFiles = state.psd.linkedFiles || [];
      state.psd.linkedFiles.push(nf);
      targets.forEach((t) => (t.placedLayer.id = nf.id));
      undoLinked = () => { const arr = state.psd.linkedFiles; const k = arr.indexOf(nf); if (k >= 0) arr.splice(k, 1); };
    } else {
      const old = { name: lf.name, type: lf.type, data: lf.data, descriptor: lf.descriptor, linkedFile: lf.linkedFile };
      Object.assign(lf, { name, type, data });
      delete lf.descriptor;
      delete lf.linkedFile;
      undoLinked = () => Object.assign(lf, old);
    }
    soPreviewCache.delete(lf);

    for (const t of targets) {
      t.placedLayer.width = cw;
      t.placedLayer.height = ch;
      if (t.placedLayer.type === 'vector' || t.placedLayer.type === 'unknown') t.placedLayer.type = 'raster';
      renderPlaced(t, content, cw, ch);
      invalidate(t);
    }
    pushUndo('Thay smart object "' + l.name + '"', () => { snaps.forEach(([t, s]) => restore(t, s)); undoLinked(); });
  }

  async function addImageLayer(file) {
    if (!state.psd) return;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, docW() / bmp.width, docH() / bmp.height);
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const c = createCanvas(w, h);
      ctx2d(c).drawImage(resizeSmooth(bmp, w, h), 0, 0, w, h);
      const left = Math.round((docW() - w) / 2), top = Math.round((docH() - h) / 2);
      const layer = { name: file.name.replace(/\.[^.]+$/, ''), canvas: c, left, top, right: left + w, bottom: top + h, opacity: 1, blendMode: 'normal', hidden: false };
      let sib = state.psd.children, idx = sib.length;
      if (state.selected) {
        if (state.selected.children && state.expanded.has(uid(state.selected))) { sib = state.selected.children; idx = sib.length; }
        else { sib = siblingsOf(state.selected); idx = sib.indexOf(state.selected) + 1; }
      }
      sib.splice(idx, 0, layer);
      pushUndo('Thêm layer ảnh', () => { const k = sib.indexOf(layer); if (k >= 0) sib.splice(k, 1); });
      indexParents();
      state.selected = layer;
      buildLayerList();
      buildProps();
      scheduleRender();
      toast('Đã thêm layer "' + layer.name + '"', 'success');
    } catch (err) {
      toast('Không đọc được ảnh: ' + err.message, true);
    }
  }

  // ---------------------------------------------------------------- open / save / export
  async function openFile(file) {
    if (!authState.loggedIn) {
      toast('Vui lòng đăng nhập để sử dụng ứng dụng', true);
      return;
    }
    showOverlay(`Đang đọc ${file.name} (${fmtSize(file.size)})...`);
    await nextFrame(); await nextFrame();
    try {
      const buf = await file.arrayBuffer();
      const t0 = performance.now();
      const psd = readPsd(buf, { skipThumbnail: true });
      console.log('readPsd', Math.round(performance.now() - t0) + 'ms', psd);
      state.psd = psd;
      state.fileName = file.name;
      state.fileSize = file.size;
      state.origComposite = psd.canvas || null;
      state.selected = null;
      state.undo = [];
      state.dirty = false;
      state.showOriginal = false;
      state.expanded = new Set();
      renderCache = new WeakMap();
      thumbCache = new WeakMap();
      psd.children = psd.children || [];
      indexParents();
      allLayers().forEach((l) => { if (l.children && l.opened) state.expanded.add(uid(l)); });

      $('dropzone').hidden = true;
      $('canvasWrap').hidden = false;
      $('zoombar').hidden = false;
      const total = allLayers().length;
      const soCount = allLayers().filter((l) => l.placedLayer).length;
      $('fileInfo').textContent = `${file.name} · ${psd.width}×${psd.height}px · ${total} layer · ${soCount} smart object`;
      document.title = file.name + ' – PSD Studio';
      buildLayerList();
      buildProps();
      zoomFit();
      render();
      updateButtons();
      toast('Đã mở ' + file.name, 'success');
      checkDocFonts();
      if (window.PSD_DB?.onPsdOpened) window.PSD_DB.onPsdOpened(file);
    } catch (err) {
      console.error(err);
      toast('Không đọc được file PSD: ' + err.message, true, 6000);
    } finally { hideOverlay(); }
  }

  async function saveBlob(blob, name, desc, mime, ext) {
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { [mime]: [ext] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
        console.warn('showSaveFilePicker lỗi, dùng download', e);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }

  async function exportImage(kind, scale = 1, quality = 92) {
    if (!state.psd) return;
    showOverlay('Đang xuất ảnh...');
    await nextFrame();
    try {
      let c = renderComposite(true);
      if (scale !== 1) {
        const w = Math.max(1, Math.round(c.width * scale)), h = Math.max(1, Math.round(c.height * scale));
        const s = createCanvas(w, h);
        ctx2d(s).drawImage(scale < 1 ? resizeSmooth(c, w, h) : c, 0, 0, w, h);
        c = s;
      }
      let blob;
      if (kind === 'jpg') {
        const j = createCanvas(c.width, c.height), x = j.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, j.width, j.height); x.drawImage(c, 0, 0);
        const q = Math.min(100, Math.max(10, +quality || 92)) / 100;
        blob = await canvasToBlob(j, 'image/jpeg', q);
      } else blob = await canvasToBlob(c, 'image/png');
      hideOverlay();
      const suffix = scale !== 1 ? `@${scale}x` : '';
      const ok = await saveBlob(blob, `${baseName()}${suffix}.${kind}`, kind.toUpperCase() + ' image', kind === 'jpg' ? 'image/jpeg' : 'image/png', kind === 'jpg' ? '.jpg' : '.png');
      if (ok) toast(`Đã xuất ${kind.toUpperCase()} ${c.width}×${c.height} (${fmtSize(blob.size)})`, 'success');
    } catch (err) {
      console.error(err);
      toast('Lỗi xuất ảnh: ' + err.message, true);
    } finally { hideOverlay(); }
  }

  async function exportLayer(l) {
    const r = renderNode(l);
    if (!r) return toast('Layer không có pixel để xuất', true);
    let c = r.canvas;
    if (l.children) {
      const b = layerBounds(l);
      if (b) {
        const t = createCanvas(b.right - b.left, b.bottom - b.top);
        t.getContext('2d').drawImage(c, -b.left, -b.top);
        c = t;
      }
    }
    const blob = await canvasToBlob(c, 'image/png');
    await saveBlob(blob, `${(l.name || 'layer').replace(/[\\/:*?"<>|]/g, '_')}.png`, 'PNG image', 'image/png', '.png');
  }

  async function savePsd() {
    if (!state.psd) return;
    showOverlay('Đang tạo file PSD...');
    await nextFrame(); await nextFrame();
    const psd = state.psd;
    const prevCanvas = psd.canvas, prevLinked = psd.linkedFiles, prevImageData = psd.imageData;
    try {
      // bỏ file nhúng không còn dùng tới để giảm dung lượng
      if (psd.linkedFiles) {
        const used = new Set(allLayers().filter((l) => l.placedLayer).map((l) => l.placedLayer.id));
        psd.linkedFiles = psd.linkedFiles.filter((f) => used.has(f.id));
        if (!psd.linkedFiles.length) delete psd.linkedFiles;
      }
      if (state.dirty || !psd.canvas) { psd.canvas = renderComposite(true); delete psd.imageData; }
      // nếu có text đã sửa: bỏ engine data cũ để Photoshop tự dựng lại text layer khi mở
      const textEdited = allLayers().some((l) => editedText.has(l));
      const buf = writePsd(psd, { generateThumbnail: true, invalidateTextLayers: textEdited });
      psd.canvas = prevCanvas; psd.linkedFiles = prevLinked; psd.imageData = prevImageData;
      const blob = new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
      if (window.PSD_DB?.saveBlobToDb) window.PSD_DB.saveBlobToDb(blob, state.fileName || `${baseName()}.psd`);
      hideOverlay();
      const ok = await saveBlob(blob, `${baseName()}-edited.psd`, 'Photoshop document', 'image/vnd.adobe.photoshop', '.psd');
      if (ok) toast(`Đã lưu PSD (${fmtSize(blob.size)})`, 'success');
    } catch (err) {
      console.error(err);
      psd.canvas = prevCanvas; psd.linkedFiles = prevLinked; psd.imageData = prevImageData;
      toast('Lỗi khi lưu PSD: ' + err.message, true, 6000);
    } finally { hideOverlay(); }
  }


  // ---------------------------------------------------------------- icons (flat, line)
  const ICONS = {
    open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    undo: 'M9 14 4 9l5-5|M4 9h11a5 5 0 0 1 0 10h-3',
    compare: 'M4 5h16v14H4z|M12 3v18',
    export: 'M12 3v12|m7 10 5 5 5-5|M5 21h14',
    upload: 'M12 16V4|m7 9 5-5 5 5|M5 20h14',
    save: 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z|M7 3v5h8V3|M7 21v-7h10v7',
    layers: 'm12 3 9 5-9 5-9-5z|m3 13 9 5 9-5',
    sliders: 'M4 6h9|M17 6h3|M4 12h3|M11 12h9|M4 18h11|M19 18h1|M15 4v4|M9 10v4|M17 16v4',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
    eyeoff: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z|M3 3l18 18',
    image: 'M3 5h18v14H3z|m3 17 5-5 4 4 3-3 6 6|M8.5 8.5h.01',
    replace: 'M4 7h13|m14 4 3 3-3 3|M20 17H7|m10 14-3 3 3 3',
    trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    up: 'm6 15 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    right: 'm9 6 6 6-6 6',
    plus: 'M12 5v14|M5 12h14',
    minus: 'M5 12h14',
    fit: 'M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5',
    close: 'M6 6l12 12|M18 6 6 18',
    search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z|m20 20-4-4',
    expand: 'M4 4h16v16H4z|M12 8v8|M8 12h8',
    collapse: 'M4 4h16v16H4z|M8 12h8',
    text: 'M5 6V4h14v2|M12 4v16|M9 20h6',
    smart: 'M4 4h16v16H4z|m4 16 5-5 3 3 2-2 6 6|M15 4v5h5',
    adjust: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z|M12 3v18',
    shape: 'M12 3l9 16H3z',
    download: 'M12 3v12|m7 10 5 5 5-5|M5 21h14',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z|M12 2v2|M12 20v2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M2 12h2|M20 12h2|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4',
    alignLeft: 'M4 6h16|M4 10h10|M4 14h16|M4 18h10',
    alignCenter: 'M4 6h16|M7 10h10|M4 14h16|M7 18h10',
    alignRight: 'M4 6h16|M10 10h10|M4 14h16|M10 18h10',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7|M20 4v7h-7',
    check: 'm5 12 5 5 9-10',
    alert: 'M12 3 2 21h20z|M12 10v5|M12 18h.01',
    font: 'M4 20 10 4h1l6 16|M6.5 14h8',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z|M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    key: 'M15 3a6 6 0 1 1-5.6 8.2L3 17.6V21h3.4v-2.2h2.2v-2.2h2.2l1.2-1.2A6 6 0 0 1 15 3z|M16.5 7.5h.01',
    scissors: 'M6 9a3 3 0 1 1 0-6 3 3 0 0 1 0 6z|M6 21a3 3 0 1 1 0-6 3 3 0 0 1 0 6z|M20 4 8.1 15.9|M14.5 14.5 20 20|M8.1 8.1 12 12',
    wand: 'M15 4V2|M15 10V8|M11 6h2|M17 6h2|M3 21l11-11|M17.8 8.8 19 10|M17.8 3.2 19 2',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z|M7 11V7a5 5 0 0 1 10 0v4',
    login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4|m10 17 5-5-5-5|M15 12H3',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|m16 17 5-5-5-5|M21 12H9',
  };
  const svg = (n) => {
    const d = ICONS[n];
    return d ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d.split('|').map((p) => `<path d="${p}"/>`).join('')}</svg>` : '';
  };
  const ic = (n) => `<i data-ic="${n}">${svg(n)}</i>`;
  function hydrateIcons(root = document) {
    root.querySelectorAll('i[data-ic]').forEach((el) => { if (!el.firstElementChild) el.innerHTML = svg(el.dataset.ic); });
  }
  function setIcon(el, n) { if (!el) return; el.dataset.ic = n; el.innerHTML = svg(n); }
  const KIND_ICON = { group: 'folder', adjustment: 'adjust', text: 'text', smart: 'smart', fill: 'shape', raster: 'image', empty: 'image' };

  const mqMobile = window.matchMedia('(max-width: 760px)');
  const mqTablet = window.matchMedia('(max-width: 1180px)');
  const isMobile = () => mqMobile.matches;
  const isTablet = () => mqTablet.matches;

  // ---------------------------------------------------------------- authentication (bắt buộc đăng nhập: sts / 1111)
  const AUTH_STORAGE_KEY = 'psdstudio-auth-token';
  const EXPECTED_USER = 'sts';
  const EXPECTED_PASS = '1111';
  const EXPECTED_TOKEN = '20f97d2f8acb1257cb22d5280ef2b2a43d82308325aef14566f369dc41d68e75'; // sha256('vlive-psd-studio:sts:1111')
  const authState = { loggedIn: false, user: null, token: '' };

  function authHeaders(extra = {}) {
    return authState.token ? { 'x-psd-auth': authState.token, ...extra } : { ...extra };
  }

  function unlockApp(user, token, remember = true) {
    authState.loggedIn = true;
    authState.user = user || EXPECTED_USER;
    authState.token = token || EXPECTED_TOKEN;
    try {
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user: authState.user, token: authState.token }));
      if (remember) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user: authState.user, token: authState.token }));
    } catch { /* ignore */ }
    document.body.classList.remove('locked');
    if ($('loginGate')) $('loginGate').hidden = true;
    if ($('userBadge')) $('userBadge').textContent = authState.user;
    if ($('loginError')) $('loginError').hidden = true;
    loadFontList();
  }

  function lockApp() {
    authState.loggedIn = false;
    authState.user = null;
    authState.token = '';
    try {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch { /* ignore */ }
    fetch('api/auth/logout', { method: 'POST' }).catch(() => {});
    document.body.classList.add('locked');
    if ($('loginGate')) $('loginGate').hidden = false;
    if ($('loginPass')) $('loginPass').value = '';
    if ($('loginError')) $('loginError').hidden = true;
    setTimeout(() => $('loginUser')?.focus(), 50);
  }

  function initAuth() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    } catch { saved = null; }
    if (saved && saved.user === EXPECTED_USER && saved.token === EXPECTED_TOKEN) {
      // Đồng bộ phiên lên server nếu chạy qua server.js
      fetch('api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: EXPECTED_USER, pass: EXPECTED_PASS, remember: true }),
      }).catch(() => {});
      unlockApp(saved.user, saved.token, true);
    } else {
      lockApp();
    }

    if ($('loginPassShow')) {
      $('loginPassShow').onclick = () => {
        const inp = $('loginPass');
        inp.type = inp.type === 'password' ? 'text' : 'password';
        setIcon($('loginPassShow').querySelector('i'), inp.type === 'password' ? 'eye' : 'eyeoff');
      };
    }
    if ($('logoutBtn')) {
      $('logoutBtn').onclick = () => {
        lockApp();
        toast('Đã đăng xuất khỏi hệ thống');
      };
    }
    if ($('loginForm')) {
      $('loginForm').onsubmit = async (e) => {
        e.preventDefault();
        const u = ($('loginUser')?.value || '').trim();
        const p = $('loginPass')?.value || '';
        const remember = !!$('loginRemember')?.checked;
        const errBox = $('loginError');
        const card = $('loginCard');
        if (u === EXPECTED_USER && p === EXPECTED_PASS) {
          fetch('api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: u, pass: p, remember }),
          }).catch(() => {});
          unlockApp(EXPECTED_USER, EXPECTED_TOKEN, remember);
          toast('Đăng nhập thành công! Xin chào ' + EXPECTED_USER, 'success');
        } else {
          if (errBox) {
            errBox.innerHTML = `${ic('alert')}<span>Sai tài khoản hoặc mật khẩu. Vui lòng thử lại!</span>`;
            errBox.hidden = false;
          }
          if (card) {
            card.classList.remove('shake');
            void card.offsetWidth;
            card.classList.add('shake');
          }
          $('loginPass')?.select();
        }
      };
    }
  }

  // ---------------------------------------------------------------- theme (dark / light)
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('psdstudio-theme', theme); } catch { /* ignore */ }
    const btn = $('themeBtn');
    if (btn) {
      setIcon(btn.querySelector('i'), theme === 'dark' ? 'sun' : 'moon');
      btn.title = theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1220' : '#1e2a44');
  }
  $('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  // ---------------------------------------------------------------- fonts (server local + online fallback)
  const WEB_FONTS = [
    ['Arial', 'Regular', 'ArialMT', 'system'],
    ['Arial', 'Bold', 'Arial-BoldMT', 'system'],
    ['Segoe UI', 'Regular', 'SegoeUI', 'system'],
    ['Segoe UI', 'Bold', 'SegoeUI-Bold', 'system'],
    ['Tahoma', 'Regular', 'Tahoma', 'system'],
    ['Tahoma', 'Bold', 'Tahoma-Bold', 'system'],
    ['Times New Roman', 'Regular', 'TimesNewRomanPSMT', 'system'],
    ['Times New Roman', 'Bold', 'TimesNewRomanPS-BoldMT', 'system'],
    ['Verdana', 'Regular', 'Verdana', 'system'],
    ['Georgia', 'Regular', 'Georgia', 'system'],
    ['Impact', 'Regular', 'Impact', 'system'],
    ['Trebuchet MS', 'Regular', 'TrebuchetMS', 'system'],
    ['Courier New', 'Regular', 'CourierNewPSMT', 'system'],
    ['Roboto', 'Regular', 'Roboto-Regular', 'gfont'],
    ['Roboto', 'Bold', 'Roboto-Bold', 'gfont'],
    ['Inter', 'Regular', 'Inter-Regular', 'gfont'],
    ['Inter', 'Bold', 'Inter-Bold', 'gfont'],
    ['Montserrat', 'Regular', 'Montserrat-Regular', 'gfont'],
    ['Montserrat', 'Bold', 'Montserrat-Bold', 'gfont'],
    ['Be Vietnam Pro', 'Regular', 'BeVietnamPro-Regular', 'gfont'],
    ['Be Vietnam Pro', 'Bold', 'BeVietnamPro-Bold', 'gfont'],
    ['Open Sans', 'Regular', 'OpenSans-Regular', 'gfont'],
    ['Open Sans', 'Bold', 'OpenSans-Bold', 'gfont'],
    ['Noto Sans', 'Regular', 'NotoSans-Regular', 'gfont'],
    ['Playfair Display', 'Regular', 'PlayfairDisplay-Regular', 'gfont'],
    ['Playfair Display', 'Bold', 'PlayfairDisplay-Bold', 'gfont'],
    ['Oswald', 'Regular', 'Oswald-Regular', 'gfont'],
    ['Poppins', 'Regular', 'Poppins-Regular', 'gfont'],
    ['Poppins', 'Bold', 'Poppins-Bold', 'gfont'],
    ['Nunito', 'Regular', 'Nunito-Regular', 'gfont'],
    ['Raleway', 'Regular', 'Raleway-Regular', 'gfont'],
    ['Anton', 'Regular', 'Anton-Regular', 'gfont'],
    ['Bebas Neue', 'Regular', 'BebasNeue-Regular', 'gfont'],
    ['Dancing Script', 'Regular', 'DancingScript-Regular', 'gfont'],
    ['Pacifico', 'Regular', 'Pacifico-Regular', 'gfont'],
  ];

  const fontDB = { list: [], customFonts: [], byKey: new Map(), ready: null, loaded: new Map(), loadedOk: false, isOnline: false };
  const normFont = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function rebuildFontIndex(baseList) {
    const merged = [...fontDB.customFonts, ...baseList];
    merged.forEach((f, idx) => { f.id = idx; });
    fontDB.list = merged;
    fontDB.byKey = new Map();
    const add = (k, f) => { k = normFont(k); if (k && !fontDB.byKey.has(k)) fontDB.byKey.set(k, f); };
    for (const f of fontDB.list) add(f.postscript, f);
    for (const f of fontDB.list) { add(f.fullName, f); add(f.family + f.style, f); if (/^(regular|normal|book)$/i.test(f.style)) add(f.family, f); }
    fontDB.loadedOk = true;
    return fontDB.list;
  }

  async function buildOnlineFontList(tryBrowserLocal = false) {
    fontDB.isOnline = true;
    const out = WEB_FONTS.map(([family, style, postscript, source]) => ({
      family,
      style,
      fullName: `${family} ${style}`.trim(),
      postscript,
      source,
    }));
    if (tryBrowserLocal && typeof window.queryLocalFonts === 'function') {
      try {
        const local = await window.queryLocalFonts();
        for (const lf of local) {
          out.push({
            family: lf.family,
            style: lf.style || 'Regular',
            fullName: lf.fullName || `${lf.family} ${lf.style || ''}`.trim(),
            postscript: lf.postscriptName || `${lf.family}-${lf.style || 'Regular'}`.replace(/\s+/g, ''),
            source: 'localAccess',
            localRef: lf,
          });
        }
      } catch (e) {
        console.warn('queryLocalFonts bị từ chối hoặc lỗi:', e);
      }
    }
    return rebuildFontIndex(out);
  }

  function loadFontList(refresh = false) {
    if (!authState.loggedIn) {
      fontDB.ready = Promise.resolve([]);
      return fontDB.ready;
    }
    fontDB.ready = fetch('api/fonts' + (refresh ? '?refresh=1' : ''), { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        fontDB.isOnline = false;
        return rebuildFontIndex(d.fonts || []);
      })
      .catch(() => buildOnlineFontList(refresh));
    return fontDB.ready;
  }

  // Cho phép người dùng tải trực tiếp file .ttf / .otf / .woff2 từ máy lên trình duyệt (cực hữu ích khi dùng online)
  async function importFontFiles(files) {
    if (!files || !files.length) return;
    let added = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const rawName = file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
        const psName = rawName.replace(/\s+/g, '');
        const family = rawName.replace(/[-_](Regular|Bold|Italic|Medium|Light|Black|SemiBold|ExtraBold)$/i, '').replace(/[-_]+/g, ' ').trim() || rawName;
        const styleMatch = rawName.match(/[-_](Regular|Bold|Italic|Medium|Light|Black|SemiBold|ExtraBold)$/i);
        const style = styleMatch ? styleMatch[1] : 'Regular';
        const blobUrl = URL.createObjectURL(new Blob([buf]));
        const item = {
          family,
          style,
          fullName: rawName,
          postscript: psName,
          source: 'custom',
          blobUrl,
        };
        fontDB.customFonts.unshift(item);
        added++;
      } catch (err) {
        console.warn('Lỗi đọc file font:', file.name, err);
      }
    }
    if (added) {
      const base = fontDB.list.filter((f) => f.source !== 'custom');
      fontDB.loaded.clear();
      rebuildFontIndex(base);
      toast(`Đã nạp thêm ${added} font chữ vào ứng dụng`, 'success');
      buildLayerList();
      buildProps();
    }
  }
  if ($('fontFileInput')) {
    $('fontFileInput').onchange = (e) => {
      importFontFiles([...e.target.files]);
      e.target.value = '';
    };
  }

  const findFont = (name) => (name ? fontDB.byKey.get(normFont(name)) || null : null);
  function loadFace(face) {
    let p = fontDB.loaded.get(face.id);
    if (p) return p;
    const alias = 'psdfont-' + face.id;
    const q = (s) => String(s).replace(/["\\]/g, '');
    if (face.source === 'custom' && face.blobUrl) {
      p = new FontFace(alias, `url("${face.blobUrl}")`).load().then((ff) => { document.fonts.add(ff); return alias; });
    } else if (face.source === 'localAccess' && face.localRef?.blob) {
      p = face.localRef.blob().then((b) => new FontFace(alias, `url("${URL.createObjectURL(b)}")`).load()).then((ff) => { document.fonts.add(ff); return alias; });
    } else if (face.source === 'gfont') {
      const weight = /bold/i.test(face.style) ? '700' : '400';
      const id = 'gf-' + normFont(face.family);
      if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.family)}:wght@400;700&display=swap`;
        document.head.appendChild(link);
      }
      p = document.fonts.load(`${weight} 16px "${face.family}"`).then(() => face.family);
    } else if (face.source === 'system') {
      p = Promise.resolve(face.family);
    } else {
      const src = `local("${q(face.postscript)}"), local("${q(face.fullName)}"), url(api/font/${face.id})`;
      p = new FontFace(alias, src).load().then((ff) => { document.fonts.add(ff); return alias; });
    }
    p.catch(() => fontDB.loaded.delete(face.id));
    fontDB.loaded.set(face.id, p);
    return p;
  }
  const fontLabel = (f) => (f ? `${f.family} ${/^regular$/i.test(f.style) ? '' : f.style}`.trim() : '');

  // ---------------------------------------------------------------- text engine
  const editedText = new WeakSet();
  let textSession = null;
  const textBaseStyle = (t) => ({ ...(t.style || {}), ...((t.styleRuns && t.styleRuns[0] && t.styleRuns[0].style) || {}), font: (t.styleRuns?.[0]?.style?.font) || t.style?.font });
  const textFontName = (t) => textBaseStyle(t).font?.name || '';
  function textFontsOf(t) {
    const s = new Set();
    if (t.style?.font?.name) s.add(t.style.font.name);
    (t.styleRuns || []).forEach((r) => r.style?.font?.name && s.add(r.style.font.name));
    return [...s];
  }
  function docFonts() {
    const map = new Map(); // name -> số layer dùng
    allLayers().filter((l) => l.text).forEach((l) => textFontsOf(l.text).forEach((n) => map.set(n, (map.get(n) || 0) + 1)));
    return [...map.entries()].map(([name, count]) => ({ name, count, face: findFont(name) }));
  }
  const layerMissingFont = (l) => fontDB.loadedOk && l.text && textFontsOf(l.text).some((n) => !findFont(n));

  async function checkDocFonts() {
    await fontDB.ready;
    if (!state.psd || !fontDB.loadedOk) return;
    const missing = docFonts().filter((f) => !f.face);
    buildLayerList();
    if (!state.selected) buildProps();
    if (missing.length) {
      setTimeout(() => toast(`Chưa có font chữ trên máy: ${missing.map((m) => m.name).join(', ')}`, 'error', 6000), 1200);
    }
  }
  function showFontError(name) {
    toast(`Chưa có font chữ "${name}" trên máy. Hãy cài font này rồi bấm "Quét lại font", hoặc chọn font khác.`, 'error', 5500);
  }

  // Vẽ lại text layer bằng font trên máy (xấp xỉ cách Photoshop dựng chữ)
  async function renderTextLayer(l, face) {
    const t = l.text, st = textBaseStyle(t), ps = t.paragraphStyle || {};
    const alias = await loadFace(face);
    const size = st.fontSize || 12;
    await document.fonts.load(`${size}px "${alias}"`, t.text || 'A');
    let text = String(t.text || '');
    if (st.fontCaps === 2) text = text.toLocaleUpperCase('vi');
    const [xx, xy, yx, yy, tx, ty] = t.transform || [1, 0, 0, 1, l.left || 0, l.bottom || 0];
    const hs = st.horizontalScale ?? 1, vs = st.verticalScale ?? 1;
    const leading = st.autoLeading !== false ? size * (ps.autoLeading || 1.2) : st.leading || size * 1.2;
    const tracking = ((st.tracking || 0) / 1000) * size;
    const fontCss = `${size}px "${alias}"`;
    const mc = createCanvas(4, 4).getContext('2d');
    mc.font = fontCss;
    try { mc.letterSpacing = tracking + 'px'; } catch { /* ignore */ }
    const fm = mc.measureText('ÁẤgjpqyỵ');
    const ascent = fm.fontBoundingBoxAscent ?? size * 0.9;
    const descent = fm.fontBoundingBoxDescent ?? size * 0.3;
    const measure = (s) => Math.max(0, mc.measureText(s).width - (s.length ? tracking : 0)) * hs;

    const box = t.shapeType === 'box' && Array.isArray(t.boxBounds) && t.boxBounds[2] > t.boxBounds[0] ? t.boxBounds : null;
    const paras = text.split(/\r\n|\r|\n/);
    let lines = paras;
    if (box) {
      const maxW = box[2] - box[0];
      lines = [];
      for (const p of paras) {
        const words = p.split(/(\s+)/);
        let cur = '';
        for (const w of words) {
          const next = cur + w;
          if (cur && measure(next.trimEnd()) > maxW) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
          else cur = next;
        }
        lines.push(cur);
      }
    }
    const just = ps.justification || 'left';
    const items = lines.map((s, i) => {
      const w = measure(s);
      let x;
      if (box) x = just.includes('center') ? (box[0] + box[2]) / 2 - w / 2 : just.includes('right') ? box[2] - w : box[0];
      else x = just.includes('center') ? -w / 2 : just.includes('right') ? -w : 0;
      const y = (box ? box[1] + ascent * vs : 0) + i * leading - (st.baselineShift || 0);
      return { s, w, x, y };
    });
    const slant = st.fauxItalic ? size * 0.25 : 0, extra = size * 0.06 + 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      const pts = [[it.x - extra, it.y - ascent * vs - extra], [it.x + it.w + slant + extra, it.y - ascent * vs - extra], [it.x - extra, it.y + descent * vs + extra], [it.x + it.w + slant + extra, it.y + descent * vs + extra]];
      for (const [px, py] of pts) {
        const X = xx * px + yx * py + tx, Y = xy * px + yy * py + ty;
        minX = Math.min(minX, X); minY = Math.min(minY, Y); maxX = Math.max(maxX, X); maxY = Math.max(maxY, Y);
      }
    }
    if (!isFinite(minX)) return false;
    minX = Math.floor(minX); minY = Math.floor(minY); maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
    const W = Math.min(10000, Math.max(1, maxX - minX)), H = Math.min(10000, Math.max(1, maxY - minY));
    const c = createCanvas(W, H), x = c.getContext('2d');
    x.setTransform(xx, xy, yx, yy, tx - minX, ty - minY);
    x.font = fontCss;
    try { x.letterSpacing = tracking + 'px'; } catch { /* ignore */ }
    x.textBaseline = 'alphabetic';
    x.fillStyle = rgba(st.fillColor || { r: 0, g: 0, b: 0 });
    x.strokeStyle = x.fillStyle;
    for (const it of items) {
      if (!it.s) continue;
      x.save();
      x.translate(it.x, it.y);
      x.scale(hs, vs);
      if (st.fauxItalic) x.transform(1, 0, -0.21, 1, 0, 0);
      x.fillText(it.s, 0, 0);
      if (st.fauxBold) { x.lineWidth = size * 0.035; x.lineJoin = 'round'; x.strokeText(it.s, 0, 0); }
      if (st.underline) x.fillRect(0, size * 0.1, it.w / hs, Math.max(1, size * 0.06));
      if (st.strikethrough) x.fillRect(0, -size * 0.3, it.w / hs, Math.max(1, size * 0.06));
      x.restore();
    }
    l.canvas = c;
    delete l.imageData;
    l.left = minX; l.top = minY; l.right = minX + W; l.bottom = minY + H;
    invalidate(l);
    return true;
  }

  function snapText(l) {
    return { text: structuredClone(l.text), canvas: l.canvas, imageData: l.imageData, left: l.left, top: l.top, right: l.right, bottom: l.bottom, name: l.name };
  }
  function restoreText(l, s) {
    l.text = structuredClone(s.text);
    Object.assign(l, { canvas: s.canvas, imageData: s.imageData, left: s.left, top: s.top, right: s.right, bottom: s.bottom, name: s.name });
    invalidate(l);
  }

  // patch: { text, font, fontSize, fillColor, tracking, justification }
  async function applyTextEdit(l, patch) {
    const t = l.text;
    if (!t) return false;
    await fontDB.ready;
    const st = textBaseStyle(t);
    const fontName = patch.font ?? st.font?.name;
    const face = findFont(fontName);
    if (!face) { showFontError(fontName || '(không rõ)'); return false; }
    if (!textSession || textSession.layer !== l) {
      const snap = snapText(l);
      textSession = { layer: l };
      pushUndo('Sửa chữ "' + l.name + '"', () => restoreText(l, snap));
    }
    const oldText = String(t.text || '');
    const textChanged = patch.text != null && patch.text !== oldText;
    if (patch.text != null) t.text = patch.text;
    const ns = { ...st, font: { ...(st.font || {}), name: face.postscript } };
    if (patch.fontSize > 0) ns.fontSize = patch.fontSize;
    if (patch.fillColor) ns.fillColor = patch.fillColor;
    if (patch.tracking != null && !isNaN(patch.tracking)) ns.tracking = patch.tracking;
    t.style = ns;
    delete t.styleRuns;
    if (patch.justification) t.paragraphStyle = { ...(t.paragraphStyle || {}), justification: patch.justification };
    if (textChanged || patch.justification) delete t.paragraphStyleRuns;
    // tên layer text trong Photoshop thường chính là nội dung chữ
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    if (textChanged && flat(l.name) === flat(oldText)) l.name = flat(t.text).slice(0, 100) || l.name;
    editedText.add(l);
    try {
      await renderTextLayer(l, face);
    } catch (err) {
      console.error(err);
      toast('Không vẽ được chữ với font "' + fontLabel(face) + '": ' + err.message, 'error', 5000);
      return false;
    }
    scheduleRender();
    updateSelBox();
    updateContextBar();
    if ($('pName') && state.selected === l && document.activeElement !== $('pName')) $('pName').value = l.name;
    clearTimeout(applyTextEdit._t);
    applyTextEdit._t = setTimeout(buildLayerList, 300);
    return true;
  }

  // ---------------------------------------------------------------- layer list UI
  function thumbFor(l) {
    let t = thumbCache.get(l);
    if (t) return t;
    t = createCanvas(34, 34);
    const src = l.canvas;
    if (src && src.width && src.height) {
      const s = Math.min(34 / src.width, 34 / src.height);
      const w = Math.max(1, src.width * s), h = Math.max(1, src.height * s);
      t.width = Math.ceil(w); t.height = Math.ceil(h);
      ctx2d(t).drawImage(resizeSmooth(src, w, h), 0, 0, w, h);
    }
    thumbCache.set(l, t);
    return t;
  }

  function makeRow(l, depth) {
    const row = document.createElement('div');
    const kind = layerKind(l);
    row.className = 'layer-row' + (l === state.selected ? ' selected' : '') + (l.hidden ? ' hidden-layer' : '') + (kind === 'group' ? ' group-row' : '');
    row.dataset.uid = uid(l);
    row.style.paddingLeft = 4 + depth * 16 + 'px';

    const eye = document.createElement('span');
    eye.className = 'eye' + (l.hidden ? ' off' : '');
    eye.innerHTML = svg(l.hidden ? 'eyeoff' : 'eye');
    eye.title = l.hidden ? 'Hiện layer' : 'Ẩn layer';
    eye.onclick = (e) => { e.stopPropagation(); setHidden(l, !l.hidden); buildLayerList(); if (l === state.selected) buildProps(); };
    row.appendChild(eye);

    const tw = document.createElement('span');
    tw.className = 'twisty';
    if (l.children) {
      const open = state.expanded.has(uid(l));
      tw.innerHTML = ic(open ? 'down' : 'right');
      tw.onclick = (e) => { e.stopPropagation(); open ? state.expanded.delete(uid(l)) : state.expanded.add(uid(l)); buildLayerList(); };
    }
    row.appendChild(tw);

    if (l.clipping) {
      const ca = document.createElement('span');
      ca.className = 'clip-arrow'; ca.textContent = '↳'; ca.title = 'Clipping mask';
      row.appendChild(ca);
    }

    const th = document.createElement('div');
    th.className = 'thumb';
    if (kind === 'group') { th.classList.add('icon'); th.innerHTML = ic('folder'); }
    else if (kind === 'adjustment') { th.classList.add('icon', 'adj'); th.innerHTML = ic('adjust'); }
    else th.appendChild(thumbFor(l));
    row.appendChild(th);

    const nm = document.createElement('span');
    nm.className = 'lname';
    nm.textContent = l.name || '(không tên)';
    nm.title = l.name || '';
    row.appendChild(nm);

    const tags = document.createElement('span');
    tags.className = 'tags';
    const tag = (cls, txt, title) => { const s = document.createElement('span'); s.className = 'tag ' + cls; s.textContent = txt; s.title = title; tags.appendChild(s); };
    if (kind === 'smart') { const lf = findLinked(l.placedLayer.id); tag('so', 'SO', 'Smart Object' + (lf ? ': ' + lf.name : '')); }
    if (kind === 'text') {
      if (layerMissingFont(l)) tag('t missing', 'T!', 'Chưa có font: ' + textFontsOf(l.text).filter((n) => !findFont(n)).join(', '));
      else tag('t', 'T', 'Text layer · ' + textFontName(l.text));
    }
    if (kind === 'adjustment') tag('adj', 'ADJ', l.adjustment.type);
    if (hasMask(l)) tag('mask', 'M', 'Layer mask');
    if (hasFx(l)) tag('fx', 'fx', 'Layer effects');
    row.appendChild(tags);

    row.onclick = () => { select(l); if (isMobile()) openSheet(null); };
    // kéo thả ảnh vào 1 layer => thay thế
    row.ondragover = (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); } };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation();
      row.classList.remove('drop-target');
      const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (f) { select(l); replaceLayerImage(l, f); }
    };
    return row;
  }

  function buildLayerList() {
    const list = $('layerList');
    const scroll = list.scrollTop;
    list.innerHTML = '';
    if (!state.psd) { list.innerHTML = '<div class="empty-state small">Chưa có layer nào.<br>Hãy mở một file PSD.</div>'; return; }
    const q = $('layerSearch').value.trim().toLowerCase();
    const matches = (l) => !q || (l.name || '').toLowerCase().includes(q) || (l.children && l.children.some(matches));
    const frag = document.createDocumentFragment();
    const walk = (arr, depth) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const l = arr[i];
        if (!matches(l)) continue;
        frag.appendChild(makeRow(l, depth));
        if (l.children && (q || state.expanded.has(uid(l)))) walk(l.children, depth + 1);
      }
    };
    walk(state.psd.children, 0);
    list.appendChild(frag);
    if (!list.children.length) list.innerHTML = '<div class="empty-state small">Không tìm thấy layer phù hợp.</div>';
    list.scrollTop = scroll;
    $('layerCount').textContent = allLayers().length;
  }

  function select(l, scroll = true) {
    if (l !== state.selected) textSession = null;
    state.selected = l;
    let p = l && parentMap.get(l), needRebuild = false;
    while (p) { if (!state.expanded.has(uid(p))) { state.expanded.add(uid(p)); needRebuild = true; } p = parentMap.get(p); }
    if (needRebuild) buildLayerList();
    document.querySelectorAll('.layer-row.selected').forEach((r) => r.classList.remove('selected'));
    if (l) {
      const row = document.querySelector(`.layer-row[data-uid="${uid(l)}"]`);
      if (row) { row.classList.add('selected'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
    }
    buildProps();
    updateSelBox();
  }

  // ---------------------------------------------------------------- context bar
  function updateContextBar() {
    const bar = $('ctxbar');
    const l = state.selected;
    if (!state.psd || !l || state.showOriginal) { bar.hidden = true; return; }
    bar.hidden = false;
    const kind = layerKind(l);
    const sib = siblingsOf(l), idx = sib.indexOf(l);
    $('ctxName').textContent = l.name || '(không tên)';
    $('ctxReplace').disabled = ['group', 'adjustment'].includes(kind);
    $('ctxUp').disabled = idx >= sib.length - 1;
    $('ctxDown').disabled = idx <= 0;
    const v = $('ctxVisible');
    setIcon(v.querySelector('i'), l.hidden ? 'eyeoff' : 'eye');
    v.querySelector('span').textContent = l.hidden ? 'Hiện' : 'Ẩn';
    $('ctxText').hidden = kind !== 'text';
    $('ctxReplace').hidden = kind === 'text';
  }
  $('ctxText').onclick = () => {
    if (isTablet()) openSheet('props');
    setTimeout(() => { const ta = $('tText'); if (ta) { ta.focus(); ta.select(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 260);
  };
  $('ctxReplace').onclick = () => { const l = state.selected; if (l) pickImage((f) => replaceLayerImage(l, f, l.placedLayer && state.fitMode === 'original' ? 'cover' : state.fitMode, state.applyAllInstances)); };
  $('ctxVisible').onclick = () => { const l = state.selected; if (!l) return; setHidden(l, !l.hidden); buildLayerList(); buildProps(); };
  $('ctxUp').onclick = () => { if (state.selected) { reorderLayer(state.selected, +1); buildProps(); } };
  $('ctxDown').onclick = () => { if (state.selected) { reorderLayer(state.selected, -1); buildProps(); } };
  $('ctxProps').onclick = () => openSheet('props');
  $('ctxDelete').onclick = () => deleteLayer(state.selected);
  $('ctxClose').onclick = () => select(null);

  // ---------------------------------------------------------------- properties UI
  function docFontsHTML() {
    const fonts = docFonts();
    if (!fonts.length) return '';
    let body;
    if (!fontDB.loadedOk) body = `<div class="hint">${fontDB.ready ? 'Đang kiểm tra font trên máy…' : 'Không kiểm tra được font.'}</div>`;
    else {
      const missing = fonts.filter((f) => !f.face).length;
      body = `
        ${missing ? `<div class="font-status missing">${ic('alert')}<span>Chưa có <b>${missing}</b> font chữ trên máy. Các text dùng font này sẽ không chỉnh sửa được cho đến khi cài hoặc nạp font.</span></div>` : `<div class="font-status ok">${ic('check')}<span>Máy đã có đủ font của file này.</span></div>`}
        <div class="font-usage">${fonts.map((f) => `
          <div class="fu-row ${f.face ? 'ok' : 'missing'}">
            ${ic(f.face ? 'check' : 'alert')}
            <div class="fu-name"><b>${esc(f.name)}</b><small>${f.face ? esc(fontLabel(f.face)) : 'Chưa có trên máy'} · ${f.count} layer</small></div>
          </div>`).join('')}
        </div>
        <div class="btn-grid" style="margin-top:10px">
          <button class="btn sm" id="pRescanFonts">${ic('refresh')} Quét lại font</button>
          <button class="btn sm soft" id="pUploadFonts">${ic('upload')} Nạp file font (.ttf/.otf)</button>
        </div>`;
    }
    return `<div class="prop-card"><h4>Font chữ trong file</h4>${body}</div>`;
  }
  // ---- trình chỉnh sửa text
  const hexOf = (c) => '#' + toRGB(c || { r: 0, g: 0, b: 0 }).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const rgbOfHex = (v) => ({ r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) });

  function textEditorHTML(l) {
    const st = textBaseStyle(l.text);
    const fname = st.font?.name || '';
    const face = findFont(fname);
    const just = l.text.paragraphStyle?.justification || 'left';
    const ja = just.includes('center') ? 'center' : just.includes('right') ? 'right' : 'left';
    let status;
    if (!fontDB.loadedOk) status = `<div class="font-status">${ic('refresh')}<span>Đang kiểm tra font trên máy…</span></div>`;
    else if (face) status = `<div class="font-status ok">${ic('check')}<span>Font <b>${esc(fontLabel(face))}</b> đã có trên máy</span></div>`;
    else status = `<div class="font-status missing">${ic('alert')}<span><b>Chưa có font chữ "${esc(fname)}"</b> trên máy. Hãy cài font rồi bấm <a href="#" id="tRescan">Quét lại font</a>, <a href="#" id="tUploadFont">Nạp file .ttf/.otf</a>, hoặc chọn font khác bên dưới để chỉnh sửa.</span></div>`;
    const multi = (l.text.styleRuns?.length || 0) > 1;
    const aligns = [['left', 'alignLeft', 'Căn trái'], ['center', 'alignCenter', 'Căn giữa'], ['right', 'alignRight', 'Căn phải']];
    return `
      <div class="prop-card text-card"><h4>Chỉnh sửa chữ</h4>
        ${status}
        <label class="mini-label" for="tText">Nội dung</label>
        <textarea id="tText" rows="3" spellcheck="false">${esc(l.text.text)}</textarea>
        <label class="mini-label">Font chữ</label>
        <div class="font-picker">
          <button type="button" class="font-current ${face ? '' : 'missing'}" id="tFontBtn">
            ${ic('font')}
            <span class="fp-text"><span class="fp-name" id="tFontName">${esc(face ? fontLabel(face) : fname || 'Chọn font')}</span><span class="fp-ps">${esc(face ? face.postscript : 'Chưa có trên máy')}</span></span>
            ${ic('down')}
          </button>
          <div class="font-pop" id="tFontPop" hidden>
            <div class="search">${ic('search')}<input type="search" id="tFontSearch" placeholder="Tìm font: UTM, Roboto, SVN…" autocomplete="off" /></div>
            <div class="font-list" id="tFontList"></div>
            <div class="font-pop-foot">
              <span id="tFontCount"></span>
              <div class="font-pop-actions">
                <button type="button" class="btn sm soft" id="tFontUpload" title="Nạp file .ttf / .otf từ thiết bị">${ic('upload')} Nạp font</button>
                <button type="button" class="btn sm" id="tFontRescan">${ic('refresh')} Quét lại</button>
              </div>
            </div>
          </div>
        </div>
        <div class="row2">
          <div class="field"><label>Cỡ</label><input type="number" inputmode="decimal" id="tSize" min="1" step="0.5" value="${+(st.fontSize || 12).toFixed(2)}" /></div>
          <div class="field"><label>Màu</label><input type="color" id="tColor" value="${hexOf(st.fillColor)}" /></div>
        </div>
        <div class="row2">
          <div class="field"><label>Căn</label><div class="seg-mini" id="tAlign">${aligns.map(([a, icn, title]) => `<button type="button" data-align="${a}" class="${a === ja ? 'active' : ''}" title="${title}">${ic(icn)}</button>`).join('')}</div></div>
          <div class="field"><label>Giãn</label><input type="number" inputmode="numeric" id="tTracking" step="10" value="${st.tracking || 0}" title="Khoảng cách chữ (tracking)" /></div>
        </div>
        ${multi ? '<div class="hint">Text này có nhiều kiểu chữ, khi sửa sẽ dùng chung một kiểu.</div>' : ''}
        <div class="hint">Chữ được vẽ lại bằng font trên máy để xem trước. Khi lưu PSD, Photoshop sẽ tự dựng lại text layer.</div>
      </div>`;
  }

  function wireTextEditor(l) {
    const ta = $('tText');
    let tText, tColor;
    ta.oninput = () => { clearTimeout(tText); tText = setTimeout(() => applyTextEdit(l, { text: ta.value }), 350); };
    $('tSize').onchange = (e) => { if (+e.target.value > 0) applyTextEdit(l, { fontSize: +e.target.value }); };
    $('tColor').oninput = (e) => { clearTimeout(tColor); const v = e.target.value; tColor = setTimeout(() => applyTextEdit(l, { fillColor: rgbOfHex(v) }), 120); };
    $('tTracking').onchange = (e) => applyTextEdit(l, { tracking: Math.round(+e.target.value) });
    $('tAlign').querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        if (await applyTextEdit(l, { justification: b.dataset.align })) $('tAlign').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      };
    });
    if ($('tRescan')) $('tRescan').onclick = (e) => { e.preventDefault(); rescanFonts(); };
    if ($('tUploadFont')) $('tUploadFont').onclick = (e) => { e.preventDefault(); $('fontFileInput')?.click(); };

    // font hiện tại hiển thị bằng chính font đó
    const cur = findFont(textFontName(l.text));
    if (cur) loadFace(cur).then((alias) => { const el = $('tFontName'); if (el) el.style.fontFamily = `"${alias}", sans-serif`; }).catch(() => {});

    // ô chọn font
    const pop = $('tFontPop'), list = $('tFontList'), search = $('tFontSearch');
    let observer = null;
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const all = fontDB.list;
      const res = q ? all.filter((f) => `${f.family} ${f.style} ${f.postscript} ${f.fullName}`.toLowerCase().includes(q)) : all;
      const curId = findFont(textFontName(l.text))?.id;
      list.innerHTML = res.slice(0, 300).map((f) => `<div class="font-item ${curId === f.id ? 'active' : ''}" data-id="${f.id}"><span class="fi-name">${esc(f.family)} <small>${esc(f.style)}</small></span><span class="fi-ps">${esc(f.postscript)}</span></div>`).join('')
        || `<div class="empty-state small">${fontDB.loadedOk ? 'Không tìm thấy font phù hợp' : 'Chưa tải được danh sách font'}</div>`;
      $('tFontCount').textContent = `${Math.min(res.length, 300)} / ${all.length} font`;
      // xem trước font khi mục hiện ra trong danh sách
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          observer.unobserve(en.target);
          const f = fontDB.list[+en.target.dataset.id];
          if (f) loadFace(f).then((alias) => { en.target.querySelector('.fi-name').style.fontFamily = `"${alias}", sans-serif`; }).catch(() => {});
        }
      }, { root: list });
      list.querySelectorAll('.font-item').forEach((el) => observer.observe(el));
    };
    $('tFontBtn').onclick = async (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        search.value = '';
        list.innerHTML = '<div class="empty-state small">Đang tải danh sách font…</div>';
        await fontDB.ready;
        renderList();
        list.querySelector('.font-item.active')?.scrollIntoView({ block: 'center' });
        if (!isMobile()) search.focus();
      }
    };
    search.oninput = renderList;
    list.onclick = async (e) => {
      const it = e.target.closest('.font-item');
      if (!it) return;
      const f = fontDB.list[+it.dataset.id];
      pop.hidden = true;
      clearTimeout(tText);
      if (await applyTextEdit(l, { font: f.postscript, text: ta.value })) { toast('Đã đổi font: ' + fontLabel(f), 'success'); buildProps(); }
    };
    $('tFontRescan').onclick = (e) => { e.stopPropagation(); rescanFonts(); };
    if ($('tFontUpload')) $('tFontUpload').onclick = (e) => { e.stopPropagation(); $('fontFileInput')?.click(); };
    pop.onclick = (e) => e.stopPropagation();
  }
  document.addEventListener('click', () => { const p = $('tFontPop'); if (p) p.hidden = true; });

  async function rescanFonts(btn) {
    if (btn) { btn.disabled = true; btn.lastChild.textContent = ' Đang quét…'; }
    await loadFontList(true);
    toast(`Đã quét ${fontDB.list.length} font trên máy`, 'success');
    buildLayerList();
    buildProps();
  }
  function docInfoHTML() {
    const psd = state.psd;
    const lfs = psd.linkedFiles || [];
    const modes = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
    const soCount = allLayers().filter((l) => l.placedLayer).length;
    return `
      <div class="prop-card">
        <h4>Tài liệu</h4>
        <div class="stat-grid">
          <div class="stat"><b>${psd.width}×${psd.height}</b><span>Kích thước (px)</span></div>
          <div class="stat"><b>${allLayers().length}</b><span>Layer</span></div>
          <div class="stat"><b>${soCount}</b><span>Smart Object</span></div>
          <div class="stat"><b>${fmtSize(lfs.reduce((s, f) => s + (f.data?.length || 0), 0))}</b><span>${lfs.length} file nhúng</span></div>
        </div>
        <div class="info-grid" style="margin-top:12px">
          <div>File</div><div>${esc(state.fileName)} (${fmtSize(state.fileSize)})</div>
          <div>Chế độ màu</div><div>${modes[psd.colorMode] || psd.colorMode} · ${psd.bitsPerChannel || 8} bit</div>
        </div>
      </div>
      ${docFontsHTML()}
      <div class="prop-card">
        <h4>Bắt đầu</h4>
        <button class="btn soft block" id="pAddLayer">${ic('plus')} Thêm layer ảnh mới</button>
        <div class="hint">Chạm vào một layer trên ảnh hoặc trong danh sách Layers để chỉnh sửa. Kéo thả ảnh lên một dòng layer để thay thế nhanh.</div>
      </div>
      <div class="prop-card">
        <h4>Phím tắt & thao tác</h4>
        <div class="kbd-grid">
          <kbd>Click / chạm</kbd><span>Chọn layer tại vị trí</span>
          <kbd>Kéo</kbd><span>Di chuyển layer đang chọn</span>
          <kbd>2 ngón</kbd><span>Phóng to / thu nhỏ</span>
          <kbd>← ↑ → ↓</kbd><span>Dịch 1px (Shift: 10px)</span>
          <kbd>Delete</kbd><span>Xóa layer</span>
          <kbd>Ctrl+Z</kbd><span>Hoàn tác</span>
          <kbd>Ctrl+S</kbd><span>Lưu PSD</span>
          <kbd>Ctrl+Lăn</kbd><span>Phóng to / thu nhỏ</span>
        </div>
      </div>`;
  }

  function buildProps() {
    const p = $('props');
    updateContextBar();
    if (!state.psd) {
      p.innerHTML = `<div class="empty-state">${ic('sliders')}<br>Mở file PSD để bắt đầu.</div>`;
      return;
    }
    const l = state.selected;
    if (!l) {
      p.innerHTML = docInfoHTML();
      $('pAddLayer').onclick = () => pickImage((f) => addImageLayer(f));
      if ($('pRescanFonts')) $('pRescanFonts').onclick = (e) => rescanFonts(e.currentTarget);
      if ($('pUploadFonts')) $('pUploadFonts').onclick = () => $('fontFileInput')?.click();
      return;
    }
    const kind = layerKind(l);
    const b = layerBounds(l);
    const canReplace = !['group', 'adjustment'].includes(kind);
    const lf = l.placedLayer ? findLinked(l.placedLayer.id) : null;
    const instances = l.placedLayer ? soInstances(l.placedLayer.id).length : 0;
    const sib = siblingsOf(l), idx = sib.indexOf(l);
    const op = Math.round((l.opacity ?? 1) * 100);
    const extra = [l.clipping && 'clipping mask', hasMask(l) && 'có mask', hasFx(l) && 'có hiệu ứng'].filter(Boolean).join(' · ');

    let html = `
      <div class="prop-card">
        <div class="layer-head">
          <div class="kind-badge ${kind}">${ic(KIND_ICON[kind])}</div>
          <div class="meta">
            <input class="name-input" type="text" id="pName" value="${esc(l.name)}" title="Đổi tên layer" />
            <div class="kind-text">${KIND_LABEL[kind]}${extra ? ' · ' + extra : ''}</div>
          </div>
        </div>
      </div>
      <!--TEXT-EDITOR-->
      <div class="prop-card"><h4>Hiển thị</h4>
        <div class="switch-line"><span>Hiển thị layer</span><label class="switch"><input type="checkbox" id="pVisible" ${l.hidden ? '' : 'checked'} /><span></span></label></div>
        <div class="field"><label>Độ mờ</label><input type="range" id="pOpacity" min="0" max="100" value="${op}" /><span class="val" id="pOpacityVal">${op}%</span></div>
        <div class="field"><label>Blend</label><select id="pBlend">${BLEND_NAMES.map((n) => `<option ${n === (l.blendMode || 'normal') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>`;

    if (b) {
      html += `
      <div class="prop-card"><h4>Vị trí & kích thước</h4>
        <div class="row2">
          <div class="field"><label>X</label><input type="number" inputmode="numeric" id="pX" value="${b.left}" /></div>
          <div class="field"><label>Y</label><input type="number" inputmode="numeric" id="pY" value="${b.top}" /></div>
        </div>
        <div class="info-grid"><div>Kích thước</div><div>${b.right - b.left} × ${b.bottom - b.top} px</div></div>
      </div>`;
    }

    if (kind === 'text') {
      html = html.replace('<!--TEXT-EDITOR-->', () => textEditorHTML(l));
    }

    if (kind === 'smart') {
      html += `
      <div class="prop-card"><h4>Smart Object</h4>
        <div class="info-grid">
          <div>File nhúng</div><div>${lf ? esc(lf.name) : '<i>liên kết ngoài / không có dữ liệu</i>'}</div>
          ${lf ? `<div>Định dạng</div><div>${esc((fileTypeOf(lf.data) || lf.type || '?').toUpperCase())} · ${fmtSize(lf.data?.length || 0)}</div>` : ''}
          <div>Kích thước gốc</div><div>${l.placedLayer.width || '?'} × ${l.placedLayer.height || '?'} px</div>
          <div>Bản sao</div><div>${instances} layer dùng chung</div>
        </div>
        <div class="preview-box" id="pSoPreview"><span class="hint">${lf?.data ? 'Đang tải xem trước…' : 'Không có dữ liệu nhúng'}</span></div>
        ${lf?.data ? `<button class="btn sm block" style="margin-top:8px" id="pSoDownload">${ic('download')} Tải file nhúng gốc</button>` : ''}
      </div>`;
    }

    if (canReplace) {
      const fits = [['cover', 'Lấp đầy'], ['contain', 'Vừa khung'], ['stretch', 'Kéo giãn']];
      if (kind !== 'smart') fits.push(['original', 'Kích thước gốc']);
      const curFit = kind === 'smart' && state.fitMode === 'original' ? 'cover' : state.fitMode;
      html += `
      <div class="prop-card"><h4>Thay thế ảnh</h4>
        <div class="fit-options" id="pFit">${fits.map(([v, t]) => `<button class="fit-opt ${v === curFit ? 'active' : ''}" data-fit="${v}">${t}</button>`).join('')}</div>
        ${kind === 'smart' && instances > 1 ? `<label class="check-line"><input type="checkbox" id="pAllInst" ${state.applyAllInstances ? 'checked' : ''}/> Áp dụng cho cả ${instances} bản sao</label>` : ''}
        <button class="btn primary block" id="pReplace">${ic('replace')} Chọn ảnh thay thế</button>
        <div class="hint">${kind === 'smart' ? 'Ảnh mới được nhúng vào Smart Object, giữ nguyên vị trí & biến đổi.' : 'Ảnh mới được đặt vào đúng khung của layer.'} Hỗ trợ JPG, PNG, WebP.</div>
      </div>`;
    }

    if (kind !== 'adjustment') {
      html += `
      <div class="prop-card ai-prop"><h4>${ic('sparkle')} AI (Gemini)</h4>
        <div class="btn-grid">
          <button class="btn sm ai-grad" id="pAiBg">${ic('scissors')} Xóa nền</button>
          <button class="btn sm ai-grad" id="pAiEdit">${ic('wand')} Sửa bằng AI</button>
        </div>
      </div>`;
    }

    html += `
      <div class="prop-card"><h4>Thao tác</h4>
        <div class="btn-grid">
          <button class="btn sm" id="pUp" ${idx >= sib.length - 1 ? 'disabled' : ''}>${ic('up')} Đưa lên</button>
          <button class="btn sm" id="pDown" ${idx <= 0 ? 'disabled' : ''}>${ic('down')} Đưa xuống</button>
          <button class="btn sm full" id="pExportLayer">${ic('export')} Xuất layer ra PNG</button>
          <button class="btn sm full" id="pAddLayer">${ic('plus')} Thêm layer ảnh phía trên</button>
          <button class="btn sm danger full" id="pDelete">${ic('trash')} Xóa layer</button>
        </div>
      </div>`;
    p.innerHTML = html;

    // ---- wiring
    if ($('pAiBg')) { $('pAiBg').onclick = () => openAi('bg', 'layer'); $('pAiEdit').onclick = () => openAi('edit', 'layer'); }
    if (kind === 'text') wireTextEditor(l);
    $('pName').onchange = (e) => {
      const old = l.name; l.name = e.target.value;
      pushUndo('Đổi tên', () => (l.name = old));
      buildLayerList();
      updateContextBar();
    };
    $('pVisible').onchange = (e) => { setHidden(l, !e.target.checked); buildLayerList(); updateContextBar(); };
    let opOld = l.opacity ?? 1;
    $('pOpacity').oninput = (e) => { l.opacity = e.target.value / 100; $('pOpacityVal').textContent = e.target.value + '%'; scheduleRender(); };
    $('pOpacity').onchange = (e) => {
      const old = opOld; opOld = e.target.value / 100;
      pushUndo('Đổi độ mờ', () => (l.opacity = old));
    };
    $('pBlend').onchange = (e) => {
      const old = l.blendMode; l.blendMode = e.target.value;
      pushUndo('Đổi blend mode', () => (l.blendMode = old));
      scheduleRender();
    };
    if (b) {
      const onPos = () => {
        const dx = Math.round(+$('pX').value - b.left), dy = Math.round(+$('pY').value - b.top);
        if (!dx && !dy) return;
        moveLayer(l, dx, dy);
        pushUndo('Di chuyển layer', () => moveLayer(l, -dx, -dy));
        scheduleRender();
        buildProps();
      };
      $('pX').onchange = onPos;
      $('pY').onchange = onPos;
    }
    if (kind === 'smart' && lf?.data) {
      showSoPreview(lf, $('pSoPreview'));
      $('pSoDownload').onclick = () => {
        const t = fileTypeOf(lf.data);
        const mime = t === 'png' ? 'image/png' : t === 'jpg' ? 'image/jpeg' : 'application/octet-stream';
        saveBlob(new Blob([lf.data], { type: mime }), lf.name || 'smart-object', 'File', mime, '.' + ((lf.name || '').split('.').pop() || 'bin'));
      };
    }
    if (canReplace) {
      $('pFit').querySelectorAll('.fit-opt').forEach((btn) => {
        btn.onclick = () => {
          state.fitMode = btn.dataset.fit;
          $('pFit').querySelectorAll('.fit-opt').forEach((x) => x.classList.toggle('active', x === btn));
        };
      });
      if ($('pAllInst')) $('pAllInst').onchange = (e) => (state.applyAllInstances = e.target.checked);
      $('pReplace').onclick = () => {
        const fit = $('pFit').querySelector('.fit-opt.active')?.dataset.fit || 'cover';
        pickImage((f) => replaceLayerImage(l, f, fit, $('pAllInst') ? $('pAllInst').checked : true));
      };
    }
    $('pUp').onclick = () => { reorderLayer(l, +1); buildProps(); };
    $('pDown').onclick = () => { reorderLayer(l, -1); buildProps(); };
    $('pExportLayer').onclick = () => exportLayer(l);
    $('pAddLayer').onclick = () => pickImage((f) => addImageLayer(f));
    $('pDelete').onclick = () => deleteLayer(l);
  }

  async function showSoPreview(lf, box) {
    try {
      let el = soPreviewCache.get(lf);
      if (!el) {
        const t = fileTypeOf(lf.data);
        if (t === 'psd') {
          await nextFrame();
          const sub = readPsd(lf.data, { skipLayerImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
          el = sub.canvas || createCanvas(1, 1);
          el.title = `PSB nhúng: ${sub.width}×${sub.height}, ${(sub.children || []).length} layer`;
        } else if (['png', 'jpg', 'gif', 'webp'].includes(t)) {
          el = new Image();
          el.src = URL.createObjectURL(new Blob([lf.data], { type: 'image/' + (t === 'jpg' ? 'jpeg' : t) }));
          await el.decode();
        } else {
          box.innerHTML = `<span class="hint">Không xem trước được định dạng ${esc(t || lf.type || '?')}</span>`;
          return;
        }
        soPreviewCache.set(lf, el);
      }
      if (!box.isConnected) return;
      box.innerHTML = '';
      box.appendChild(el);
      if (el.title) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = el.title; box.after(h); }
    } catch (err) {
      console.error(err);
      if (box.isConnected) box.innerHTML = `<span class="hint">Lỗi xem trước: ${esc(err.message)}</span>`;
    }
  }

  let pickCb = null;
  function pickImage(cb) { pickCb = cb; $('replaceInput').value = ''; $('replaceInput').click(); }
  $('replaceInput').onchange = (e) => { const f = e.target.files[0]; if (f && pickCb) pickCb(f); };

  // ---------------------------------------------------------------- sheets / drawers (tablet + mobile)
  function openSheet(name) {
    const lp = $('layersPanel'), pp = $('propsPanel');
    lp.classList.toggle('open', name === 'layers' && isMobile());
    pp.classList.toggle('open', name === 'props' && isTablet());
    const lOpen = lp.classList.contains('open'), pOpen = pp.classList.contains('open');
    $('backdrop').hidden = !(lOpen || pOpen);
    $('navLayers').classList.toggle('active', lOpen);
    $('navProps').classList.toggle('active', pOpen);
    $('propsToggle').classList.toggle('active', pOpen);
  }
  const toggleSheet = (name) => {
    const el = name === 'layers' ? $('layersPanel') : $('propsPanel');
    openSheet(el.classList.contains('open') ? null : name);
  };
  $('backdrop').onclick = () => openSheet(null);
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => openSheet(null)));
  $('navLayers').onclick = () => toggleSheet('layers');
  $('navProps').onclick = () => toggleSheet('props');
  $('propsToggle').onclick = () => toggleSheet('props');
  // vuốt xuống để đóng bottom sheet
  document.querySelectorAll('.sheet').forEach((sheet) => {
    let sy = null;
    const head = [sheet.querySelector('.sheet-grip'), sheet.querySelector('.panel-head')];
    head.forEach((h) => {
      h.addEventListener('pointerdown', (e) => { if (isMobile()) sy = e.clientY; });
      h.addEventListener('pointerup', (e) => { if (sy != null && e.clientY - sy > 50) openSheet(null); sy = null; });
    });
  });
  const onLayoutChange = () => { openSheet(null); if (state.psd) (state.autoFit ? zoomFit() : updateSelBox()); };
  mqMobile.addEventListener('change', onLayoutChange);
  mqTablet.addEventListener('change', onLayoutChange);

  // ---------------------------------------------------------------- export dialog
  const exportState = { fmt: 'png', scale: 1 };
  function openExport(fmt = exportState.fmt) {
    if (!state.psd) return;
    exportState.fmt = fmt;
    openSheet(null);
    refreshExportUI();
    $('exportModal').hidden = false;
  }
  function refreshExportUI() {
    const { fmt, scale } = exportState;
    $('fmtSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
    $('scaleSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.scale === scale));
    $('scaleRow').hidden = fmt === 'psd';
    $('qualityRow').hidden = fmt !== 'jpg';
    $('jpgQualityVal').textContent = $('jpgQuality').value + '%';
    const w = Math.round(docW() * scale), h = Math.round(docH() * scale);
    $('exportInfo').innerHTML = fmt === 'psd'
      ? `Lưu file <b>${esc(baseName())}-edited.psd</b> giữ nguyên toàn bộ layer, smart object và các thay đổi của bạn.`
      : `Xuất ảnh <b>${w} × ${h}px</b> · ${fmt === 'png' ? 'PNG giữ nền trong suốt' : 'JPG nền trắng'}`;
  }
  $('fmtSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => { exportState.fmt = b.dataset.fmt; refreshExportUI(); }));
  $('scaleSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => { exportState.scale = +b.dataset.scale; refreshExportUI(); }));
  $('jpgQuality').oninput = refreshExportUI;
  document.querySelectorAll('[data-modal-close]').forEach((b) => (b.onclick = () => ($('exportModal').hidden = true)));
  $('exportModal').addEventListener('click', (e) => { if (e.target === $('exportModal')) $('exportModal').hidden = true; });
  $('doExport').onclick = () => {
    $('exportModal').hidden = true;
    if (exportState.fmt === 'psd') savePsd();
    else exportImage(exportState.fmt, exportState.scale, +$('jpgQuality').value);
  };

  // ---------------------------------------------------------------- viewport
  function setZoom(z) {
    if (!state.psd) return;
    state.zoom = Math.min(16, Math.max(0.05, z));
    const h = $('canvasHolder');
    h.style.width = docW() * state.zoom + 'px';
    h.style.height = docH() * state.zoom + 'px';
    $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    updateSelBox();
  }
  // zoom giữ nguyên điểm dưới con trỏ / giữa 2 ngón tay
  function setZoomAt(z, cx, cy) {
    const wrap = $('canvasWrap');
    const r = $('viewCanvas').getBoundingClientRect();
    const px = (cx - r.left) / state.zoom, py = (cy - r.top) / state.zoom;
    setZoom(z);
    state.autoFit = false;
    const r2 = $('viewCanvas').getBoundingClientRect();
    wrap.scrollLeft += r2.left + px * state.zoom - cx;
    wrap.scrollTop += r2.top + py * state.zoom - cy;
  }
  function zoomFit() {
    const wrap = $('canvasWrap');
    const pad = isMobile() ? 24 : 48;
    const z = Math.min((wrap.clientWidth - pad) / docW(), (wrap.clientHeight - pad - 50) / docH(), 4);
    setZoom(z > 0 ? z : 1);
    state.autoFit = true;
  }
  function updateSelBox() {
    const box = $('selBox');
    const l = state.selected;
    const b = l && state.psd && $('showSel').checked && !state.showOriginal ? layerBounds(l) : null;
    if (!b) { box.hidden = true; return; }
    const z = state.zoom;
    Object.assign(box.style, { left: b.left * z + 'px', top: b.top * z + 'px', width: (b.right - b.left) * z + 'px', height: (b.bottom - b.top) * z + 'px' });
    box.hidden = false;
  }

  function visibleLeaves(arr = state.psd.children, out = []) {
    for (const l of arr) { if (l.hidden) continue; if (l.children) visibleLeaves(l.children, out); else out.push(l); }
    return out;
  }
  function hitTest(x, y) {
    const leaves = visibleLeaves();
    for (let i = leaves.length - 1; i >= 0; i--) {
      const l = leaves[i];
      if (!l.canvas || l.adjustment || (l.opacity ?? 1) === 0) continue;
      const lx = Math.floor(x - (l.left || 0)), ly = Math.floor(y - (l.top || 0));
      if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
      const a = l.canvas.getContext('2d').getImageData(lx, ly, 1, 1).data[3];
      if (a > 20) return l;
    }
    return null;
  }
  function toDoc(e) {
    const r = $('viewCanvas').getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * docW(), y: ((e.clientY - r.top) / r.height) * docH() };
  }

  // Pointer events: chuột + cảm ứng (kéo layer, kéo để cuộn, 2 ngón để zoom)
  const holder = $('canvasHolder');
  const pointers = new Map();
  let drag = null, pinch = null;
  function endDrag() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.pan) return;
    if (d.active && (d.ax || d.ay)) {
      pushUndo('Di chuyển layer', () => moveLayer(d.layer, -d.ax, -d.ay));
      buildProps();
    } else if (!d.active && d.pending && d.pending !== state.selected) select(d.pending);
  }
  holder.addEventListener('pointerdown', (e) => {
    if (!state.psd) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    holder.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      endDrag();
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
      return;
    }
    if (pointers.size > 2) return;
    e.preventDefault();
    const wrap = $('canvasWrap');
    if (state.showOriginal) { drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop }; return; }
    const p = toDoc(e);
    const hit = hitTest(p.x, p.y);
    const sel = state.selected;
    const b = sel && layerBounds(sel);
    const inside = b && p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom;
    let target = sel, pending = null;
    if (inside && !e.altKey) pending = hit;
    else { target = hit; if (hit !== sel) select(hit, true); }
    if (!target) { drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop }; return; }
    drag = { layer: target, pending, sx: e.clientX, sy: e.clientY, ax: 0, ay: 0, active: false };
  });
  holder.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      setZoomAt(pinch.zoom * (dist / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!drag) return;
    const cdx = e.clientX - drag.sx, cdy = e.clientY - drag.sy;
    if (drag.pan) {
      const wrap = $('canvasWrap');
      wrap.scrollLeft = drag.sl - cdx;
      wrap.scrollTop = drag.st - cdy;
      return;
    }
    const threshold = e.pointerType === 'mouse' ? 4 : 8;
    if (!drag.active && Math.hypot(cdx, cdy) < threshold) return;
    drag.active = true;
    const tx = Math.round(cdx / state.zoom), ty = Math.round(cdy / state.zoom);
    moveLayer(drag.layer, tx - drag.ax, ty - drag.ay);
    drag.ax = tx; drag.ay = ty;
    scheduleRender();
  });
  const onPointerEnd = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
    endDrag();
  };
  holder.addEventListener('pointerup', onPointerEnd);
  holder.addEventListener('pointercancel', onPointerEnd);

  $('canvasWrap').addEventListener('wheel', (e) => {
    if (!state.psd || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoomAt(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });

  // ---------------------------------------------------------------- toolbar
  function updateButtons() {
    const has = !!state.psd;
    ['exportBtn', 'savePsd', 'propsToggle', 'navExport', 'navSave', 'navProps', 'navLayers', 'aiBtn'].forEach((id) => ($(id).disabled = !has));
    $('compareBtn').disabled = !has || !state.origComposite;
    $('undoBtn').disabled = !state.undo.length;
    $('undoBtn').title = state.undo.length ? 'Hoàn tác: ' + state.undo[state.undo.length - 1].label + ' (Ctrl+Z)' : 'Hoàn tác (Ctrl+Z)';
    $('compareBtn').classList.toggle('active', state.showOriginal);
    $('compareLabel').textContent = state.showOriginal ? 'Bản chỉnh sửa' : 'Bản gốc';
  }

  const onPickPsd = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('fileInput').onchange = onPickPsd;
  $('fileInput2').onchange = onPickPsd;
  $('undoBtn').onclick = undo;
  $('compareBtn').onclick = () => { state.showOriginal = !state.showOriginal; updateButtons(); updateContextBar(); render(); };
  $('exportBtn').onclick = () => openExport(exportState.fmt === 'psd' ? 'png' : exportState.fmt);
  $('navExport').onclick = () => openExport(exportState.fmt === 'psd' ? 'png' : exportState.fmt);
  $('savePsd').onclick = savePsd;
  $('navSave').onclick = savePsd;
  $('zoomIn').onclick = () => { setZoom(state.zoom * 1.25); state.autoFit = false; };
  $('zoomOut').onclick = () => { setZoom(state.zoom / 1.25); state.autoFit = false; };
  $('zoomFit').onclick = zoomFit;
  $('zoomLabel').onclick = () => { setZoom(1); state.autoFit = false; };
  $('showFx').onchange = (e) => { state.showFx = e.target.checked; renderCache = new WeakMap(); scheduleRender(); };
  $('showSel').onchange = updateSelBox;
  $('layerSearch').oninput = buildLayerList;
  $('expandAll').onclick = () => { allLayers().forEach((l) => l.children && state.expanded.add(uid(l))); buildLayerList(); };
  $('collapseAll').onclick = () => { state.expanded.clear(); buildLayerList(); };
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.psd) (state.autoFit ? zoomFit() : updateSelBox()); }, 120);
  });

  // drag & drop file
  const stage = $('stage');
  let dragDepth = 0;
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  stage.addEventListener('dragenter', (e) => { if (!authState.loggedIn) return; if (e.dataTransfer.types.includes('Files')) { dragDepth++; stage.classList.add('dragging'); } });
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; stage.classList.remove('dragging'); } });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    stage.classList.remove('dragging');
    if (!authState.loggedIn) { toast('Vui lòng đăng nhập để sử dụng ứng dụng', true); return; }
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.(psd|psb)$/i.test(f.name)) openFile(f);
    else if (f.type.startsWith('image/')) {
      if (state.psd) addImageLayer(f); else toast('Hãy mở file PSD trước', true);
    } else toast('Định dạng không hỗ trợ: ' + f.name, true);
  });

  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (!authState.loggedIn) return;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePsd(); return; }
    if (e.key === 'Escape') {
      if (!$('aiSettingsModal').hidden) { $('aiSettingsModal').hidden = true; return; }
      if (!$('aiModal').hidden) { $('aiModal').hidden = true; return; }
      if (!$('exportModal').hidden) { $('exportModal').hidden = true; return; } openSheet(null); if (!typing) select(null); return; }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); zoomFit(); return; }
    const l = state.selected;
    if (!l) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteLayer(l); return; }
    const step = e.shiftKey ? 10 : 1;
    const dirs = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (dirs[e.key]) {
      e.preventDefault();
      const [dx, dy] = dirs[e.key];
      moveLayer(l, dx, dy);
      pushUndo('Di chuyển layer', () => moveLayer(l, -dx, -dy));
      scheduleRender();
      clearTimeout(window._propT);
      window._propT = setTimeout(buildProps, 250);
    }
  });

  // ---------------------------------------------------------------- AI (Gemini API: server local + browser online fallback)
  const aiState = { status: null, models: null, target: 'layer', tab: 'bg', result: null };
  const AI_CHIPS = [
    'Tăng độ nét và chất lượng ảnh, giữ nguyên nội dung',
    'Xóa chữ, logo và watermark trên ảnh',
    'Đổi nền thành bầu trời hoàng hôn rực rỡ',
    'Làm ảnh sáng hơn, màu sắc rực rỡ hơn',
    'Xóa các vật thể thừa phía sau, giữ chủ thể chính',
    'Chuyển sang phong cách tranh anime',
  ];
  const AI_RATIOS = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]];
  const nearestRatio = (w, h) => AI_RATIOS.reduce((best, r) => (Math.abs(Math.log(r[1] / (w / h))) < Math.abs(Math.log(best[1] / (w / h))) ? r : best))[0];

  // Fallback Gemini client chạy trực tiếp trên trình duyệt khi deploy online (GitHub Pages)
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
  const IMAGE_MODEL_PREF = ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];
  const SEG_MODEL_PREF = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'];
  const AI_LOCAL_KEY = 'psdstudio-ai-config';

  const browserAi = {
    loadCfg() {
      try { return JSON.parse(localStorage.getItem(AI_LOCAL_KEY) || '{}'); } catch { return {}; }
    },
    saveCfg(cfg) {
      try { localStorage.setItem(AI_LOCAL_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
    },
    keyHint(k) { return k ? `${k.slice(0, 4)}…${k.slice(-4)}` : ''; },
    status() {
      const cfg = this.loadCfg();
      return {
        configured: !!cfg.apiKey,
        keyHint: this.keyHint(cfg.apiKey),
        imageModel: cfg.imageModel || IMAGE_MODEL_PREF[0],
        segModel: cfg.segModel || SEG_MODEL_PREF[0],
      };
    },
    async gfetch(pathname, { method = 'GET', body, key }) {
      const res = await fetch(GEMINI_API + pathname, {
        method,
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json?.error?.message || ('HTTP ' + res.status);
        throw new Error(/API_KEY_INVALID|API key not valid/i.test(msg) ? 'API key không hợp lệ. Hãy kiểm tra lại key trong Google AI Studio.' : `Lỗi Gemini API (${res.status}): ${msg}`);
      }
      return json;
    },
    async listModels(key) {
      const k = key || this.loadCfg().apiKey;
      if (!k) throw new Error('Chưa cài đặt Gemini API key.');
      const r = await this.gfetch('/models?pageSize=1000', { key: k });
      const gen = (r.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
      const image = gen.filter((m) => /image/i.test(m.id) && !/imagen/i.test(m.id));
      const seg = gen.filter((m) => /^gemini-[\d.]+-(flash|pro)/i.test(m.id) && !/image|tts|audio|live|embedding|lite|thinking|computer|robotics/i.test(m.id));
      return { image, seg };
    },
    async setConfig({ apiKey, imageModel, segModel }) {
      const cfg = this.loadCfg();
      if (apiKey !== undefined) {
        if (!apiKey) { delete cfg.apiKey; this.saveCfg(cfg); return { ...this.status(), models: null }; }
        const models = await this.listModels(apiKey.trim());
        const pick = (list, prefs) => prefs.find((p) => list.some((m) => m.id === p)) || list[0]?.id || prefs[0];
        cfg.apiKey = apiKey.trim();
        cfg.imageModel = imageModel || pick(models.image, IMAGE_MODEL_PREF);
        cfg.segModel = segModel || pick(models.seg, SEG_MODEL_PREF);
        this.saveCfg(cfg);
        return { ...this.status(), models };
      }
      if (imageModel) cfg.imageModel = imageModel;
      if (segModel) cfg.segModel = segModel;
      this.saveCfg(cfg);
      return this.status();
    },
    async editImage({ image, mime = 'image/png', prompt, aspectRatio, model }) {
      const cfg = this.loadCfg();
      if (!cfg.apiKey) throw new Error('Chưa cài đặt Gemini API key.');
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: image } }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}) },
      };
      const m = model || cfg.imageModel || IMAGE_MODEL_PREF[0];
      let resp;
      try {
        resp = await this.gfetch(`/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', body, key: cfg.apiKey });
      } catch (err) {
        if (aspectRatio) {
          delete body.generationConfig.imageConfig;
          resp = await this.gfetch(`/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', body, key: cfg.apiKey });
        } else throw err;
      }
      const cand = resp?.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const img = parts.find((p) => p.inlineData || p.inline_data);
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
      if (!img) throw new Error(text || 'Model không trả về ảnh.');
      const d = img.inlineData || img.inline_data;
      return { image: d.data, mime: d.mimeType || d.mime_type || 'image/png', text, model: m };
    },
    async segment({ image, mime = 'image/png', subject, model }) {
      const cfg = this.loadCfg();
      if (!cfg.apiKey) throw new Error('Chưa cài đặt Gemini API key.');
      const m = model || cfg.segModel || SEG_MODEL_PREF[0];
      const what = subject && subject.trim()
        ? `the following subject(s): ${subject.trim()}`
        : 'the main foreground subject(s) of this image (people, characters, products, logos or objects in focus) — everything that is NOT background';
      const prompt = `Give the segmentation masks for ${what}. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label". Use descriptive labels.`;
      const generationConfig = { temperature: 0.4 };
      if (/2\.5/.test(m)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const resp = await this.gfetch(`/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        key: cfg.apiKey,
        body: { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: image } }, { text: prompt }] }], generationConfig },
      });
      const text = (resp?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      let json = text.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim();
      if (!json.startsWith('[')) { const s = text.indexOf('['), e = text.lastIndexOf(']'); json = s >= 0 && e > s ? text.slice(s, e + 1) : '[]'; }
      let masks = [];
      try { masks = JSON.parse(json); } catch { masks = []; }
      masks = (Array.isArray(masks) ? masks : []).filter((x) => Array.isArray(x.box_2d) && typeof x.mask === 'string');
      return { masks, model: m };
    },
  };

  async function api(path, body) {
    const cleanPath = path.replace(/^\//, '');
    try {
      const r = await fetch(cleanPath, {
        method: body ? 'POST' : 'GET',
        headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const ct = r.headers.get('content-type') || '';
      if (r.status === 404 || r.status === 405 || !ct.includes('application/json')) {
        throw Object.assign(new Error('STATIC_HOST_FALLBACK'), { fallback: true });
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      return j;
    } catch (err) {
      if (err.fallback || err.name === 'TypeError') {
        const action = cleanPath.replace(/^api\/ai\//, '');
        if (action === 'status') return browserAi.status();
        if (action === 'models') return browserAi.listModels();
        if (action === 'config') return browserAi.setConfig(body || {});
        if (action === 'edit') return browserAi.editImage(body || {});
        if (action === 'segment') return browserAi.segment(body || {});
      }
      throw err;
    }
  }
  async function aiRefreshStatus() {
    aiState.status = await api('/api/ai/status').catch(() => null);
    return aiState.status;
  }
  async function canvasToB64(c, type = 'image/png', q) {
    const buf = new Uint8Array(await (await canvasToBlob(c, type, q)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBlob(b64, mime) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: mime });
  }
  function scaledCopy(src, max) {
    const s = Math.min(1, max / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
    const c = createCanvas(w, h);
    ctx2d(c).drawImage(s < 1 ? resizeSmooth(src, w, h) : src, 0, 0, w, h);
    return c;
  }
  function hasTransparency(c) {
    const s = scaledCopy(c, 256), d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }

  // Nguồn ảnh cho AI theo lựa chọn (layer đang chọn / toàn bộ ảnh)
  async function aiSource() {
    const l = state.selected;
    if (aiState.target === 'doc' || !l) return { kind: 'doc', canvas: renderComposite(true), name: baseName(), left: 0, top: 0 };
    const k = layerKind(l);
    if (k === 'adjustment') throw new Error('Adjustment layer không có ảnh để xử lý.');
    if (k === 'smart') {
      const lf = findLinked(l.placedLayer.id);
      const t = lf && fileTypeOf(lf.data);
      if (['png', 'jpg', 'webp', 'gif'].includes(t)) {
        const bmp = await createImageBitmap(new Blob([lf.data]));
        return { kind: 'smart', layer: l, canvas: bitmapToCanvas(bmp), name: (lf.name || l.name).replace(/\.[^.]+$/, '') };
      }
    }
    if (k === 'group') {
      const b = layerBounds(l);
      if (!b) throw new Error('Nhóm này đang trống.');
      const r = renderNode(l);
      const c = createCanvas(b.right - b.left, b.bottom - b.top);
      c.getContext('2d').drawImage(r.canvas, r.x - b.left, r.y - b.top);
      return { kind: 'group', layer: l, canvas: c, name: l.name, left: b.left, top: b.top };
    }
    if (!l.canvas) throw new Error('Layer này không có pixel để xử lý.');
    return { kind: 'raster', layer: l, canvas: l.canvas, name: l.name };
  }

  // ---- xóa nền: segmentation mask của Gemini áp lên pixel gốc (giữ nguyên độ nét)
  async function buildMask(masks, W, H) {
    const m = createCanvas(W, H), mx = m.getContext('2d');
    mx.imageSmoothingQuality = 'high';
    for (const it of masks) {
      const [y0, x0, y1, x1] = it.box_2d.map(Number);
      const bx = (x0 / 1000) * W, by = (y0 / 1000) * H, bw = ((x1 - x0) / 1000) * W, bh = ((y1 - y0) / 1000) * H;
      if (bw < 1 || bh < 1) continue;
      const url = it.mask.startsWith('data:') ? it.mask : 'data:image/png;base64,' + it.mask;
      let img;
      try { img = await createImageBitmap(await (await fetch(url)).blob()); } catch { continue; }
      const t = createCanvas(img.width, img.height), tx = t.getContext('2d');
      tx.drawImage(img, 0, 0);
      const id = tx.getImageData(0, 0, t.width, t.height), d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = Math.max(0, Math.min(255, ((v - 80) / 110) * 255));
      }
      tx.putImageData(id, 0, 0);
      mx.globalCompositeOperation = 'lighter';
      mx.drawImage(t, bx, by, bw, bh);
    }
    return m;
  }
  function maskCoverage(m) {
    const s = scaledCopy(m, 128), d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n / (d.length / 4);
  }
  function applyAlpha(src, mask) {
    const out = createCanvas(src.width, src.height), x = out.getContext('2d');
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(mask, 0, 0, src.width, src.height);
    return out;
  }
  function chromaKey(c) {
    const x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, b), gd = g - mx;
      let a = 255;
      if (gd > 70) a = 0;
      else if (gd > 25) a = Math.round(((70 - gd) / 45) * 255);
      if (gd > 0) d[i + 1] = mx; // khử viền xanh
      d[i + 3] = Math.min(d[i + 3], a);
    }
    x.putImageData(id, 0, 0);
    return c;
  }
  // cắt ảnh kết quả về đúng tỉ lệ ảnh nguồn, không phóng to quá kích thước nguồn
  function fitResult(img, src, maxToSrc = true) {
    const ta = src.width / src.height;
    let w = img.width, h = Math.round(img.width / ta);
    if (h > img.height) { h = img.height; w = Math.round(img.height * ta); }
    if (maxToSrc && w > src.width) { w = src.width; h = src.height; }
    const c = createCanvas(w, h);
    drawFit(ctx2d(c), img, w, h, 'cover');
    return c;
  }

  async function aiRemoveBg(src, subject, fallback, step) {
    step('AI đang nhận diện chủ thể…');
    const small = scaledCopy(src, 1024);
    let r = null;
    try { r = await api('/api/ai/segment', { image: await canvasToB64(small, 'image/png'), mime: 'image/png', subject }); } catch (err) { if (!fallback) throw err; console.warn(err); }
    if (r?.masks?.length) {
      step('Đang tách nền trên ảnh gốc…');
      const mask = await buildMask(r.masks, src.width, src.height);
      if (maskCoverage(mask) > 0.002) return { canvas: applyAlpha(src, mask), note: `Đã tách ${r.masks.length} vùng: ${r.masks.map((m) => m.label).filter(Boolean).join(', ')} · giữ nguyên độ phân giải gốc ${src.width}×${src.height}` };
    }
    if (!fallback) throw new Error('AI không tìm thấy chủ thể để tách. Hãy nhập rõ hơn ở ô "Giữ lại".');
    step('Đang tạo nền xanh bằng AI rồi tách…');
    const inp = scaledCopy(src, 1536);
    const subj = subject ? ` (the subject is: ${subject})` : '';
    const e = await api('/api/ai/edit', {
      image: await canvasToB64(inp, 'image/png'), mime: 'image/png', aspectRatio: nearestRatio(inp.width, inp.height),
      prompt: `Keep the main subject${subj} exactly the same (same pose, details, colors, size and position) and replace the entire background with a perfectly flat, solid pure green color (#00FF00). No shadows, no gradients, no green on the subject.`,
    });
    const img = await createImageBitmap(b64ToBlob(e.image, e.mime));
    const c = fitResult(img, src);
    return { canvas: chromaKey(c), note: `Tách bằng nền xanh (model ${e.model}) · ${c.width}×${c.height}` };
  }

  async function aiEdit(src, prompt, keepAlpha, step) {
    step('AI đang chỉnh sửa ảnh… (thường mất 10–60 giây)');
    const inp = scaledCopy(src, 2048);
    const e = await api('/api/ai/edit', {
      image: await canvasToB64(inp, 'image/png'), mime: 'image/png', aspectRatio: nearestRatio(inp.width, inp.height),
      prompt: `${prompt}\n\nKeep the same composition, framing and aspect ratio. Only change what is requested.`,
    });
    const img = await createImageBitmap(b64ToBlob(e.image, e.mime));
    let c = fitResult(img, src);
    if (keepAlpha && hasTransparency(src)) c = applyAlpha(c, src);
    return { canvas: c, note: `Model ${e.model} · ${c.width}×${c.height}${e.text ? ' · ' + e.text.slice(0, 160) : ''}` };
  }

  function addLayerFromCanvas(canvas, left, top, name, above) {
    const layer = { name, canvas, left, top, right: left + canvas.width, bottom: top + canvas.height, opacity: 1, blendMode: 'normal', hidden: false };
    let sib = state.psd.children, idx = sib.length;
    if (above) { sib = siblingsOf(above); idx = sib.indexOf(above) + 1; }
    sib.splice(idx, 0, layer);
    pushUndo('Thêm layer AI', () => { const k = sib.indexOf(layer); if (k >= 0) sib.splice(k, 1); });
    indexParents();
    state.selected = layer;
    buildLayerList();
    buildProps();
    scheduleRender();
  }

  // ---- giao diện AI
  function showModalImage(box, canvas) {
    box.innerHTML = '';
    const c = scaledCopy(canvas, 640);
    box.appendChild(c);
  }
  function refreshAiUI() {
    const l = state.selected;
    const layerOk = !!l && layerKind(l) !== 'adjustment';
    if (!layerOk && aiState.target === 'layer') aiState.target = 'doc';
    $('aiTargetSeg').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.target === aiState.target);
      if (b.dataset.target === 'layer') b.disabled = !layerOk;
    });
    $('aiTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === aiState.tab));
    $('aiTabBg').hidden = aiState.tab !== 'bg';
    $('aiTabEdit').hidden = aiState.tab !== 'edit';
    $('aiRunLabel').textContent = aiState.tab === 'bg' ? 'Xóa nền' : 'Chạy AI';
    const k = l && layerKind(l);
    $('aiTargetInfo').innerHTML = aiState.target === 'layer' && l
      ? `${ic(KIND_ICON[k])}<span><b>${esc(l.name)}</b> · ${KIND_LABEL[k]}${k === 'smart' ? ' (xử lý trên ảnh gốc nhúng bên trong)' : ''}${k === 'text' ? ' (sẽ chuyển thành layer ảnh)' : ''}${k === 'group' ? ' (kết quả thêm thành layer mới)' : ''}</span>`
      : `${ic('image')}<span><b>Toàn bộ ảnh</b> ${docW()}×${docH()} · kết quả được thêm thành <b>layer mới</b> trên cùng</span>`;
    $('aiKeepAlphaRow').hidden = aiState.target === 'doc';
    const has = !!aiState.result;
    $('aiResult').hidden = !has;
    $('aiApply').hidden = !has;
    $('aiRetry').hidden = !has;
    $('aiRun').hidden = has;
    const st = aiState.status;
    $('aiNote').innerHTML = st?.configured
      ? `Gemini API key <b>${esc(st.keyHint)}</b> · chi phí tính vào tài khoản Google AI Studio, không dùng quota gói Pro/Ultra.`
      : 'Chưa có API key. Bấm biểu tượng chìa khóa để cài đặt.';
  }
  async function openAi(tab, target) {
    if (!state.psd) return;
    openSheet(null);
    if (tab) aiState.tab = tab;
    aiState.target = target || (state.selected ? 'layer' : 'doc');
    aiState.result = null;
    if (!$('aiChips').children.length) {
      $('aiChips').innerHTML = AI_CHIPS.map((c) => `<button type="button" class="chip-btn">${esc(c)}</button>`).join('');
      $('aiChips').querySelectorAll('.chip-btn').forEach((b) => (b.onclick = () => { $('aiPrompt').value = b.textContent; $('aiPrompt').focus(); }));
    }
    await aiRefreshStatus();
    refreshAiUI();
    $('aiModal').hidden = false;
    if (!aiState.status?.configured) openAiSettings();
  }
  const closeAi = () => { $('aiModal').hidden = true; aiState.result = null; };

  async function aiRun() {
    if (!aiState.status?.configured) { openAiSettings(); return; }
    const prompt = $('aiPrompt').value.trim();
    if (aiState.tab === 'edit' && !prompt) { toast('Hãy nhập câu lệnh cho AI', true); $('aiPrompt').focus(); return; }
    showOverlay('AI đang xử lý…');
    try {
      const src = await aiSource();
      const step = (t) => { $('overlayText').textContent = t; };
      const r = aiState.tab === 'bg'
        ? await aiRemoveBg(src.canvas, $('aiSubject').value.trim(), $('aiBgFallback').checked, step)
        : await aiEdit(src.canvas, prompt, $('aiKeepAlpha').checked, step);
      aiState.result = { canvas: r.canvas, src };
      showModalImage($('aiBefore'), src.canvas);
      showModalImage($('aiAfter'), r.canvas);
      $('aiResultNote').textContent = r.note || '';
      refreshAiUI();
    } catch (err) {
      console.error(err);
      toast(err.message, 'error', 8000);
      if (/API key|401/.test(err.message)) openAiSettings();
    } finally { hideOverlay(); }
  }

  async function aiApply() {
    const res = aiState.result;
    if (!res) return;
    const { canvas, src } = res;
    closeAi();
    if (src.kind === 'doc' || src.kind === 'group') {
      addLayerFromCanvas(canvas, src.left || 0, src.top || 0, `AI · ${aiState.tab === 'bg' ? 'xóa nền' : 'chỉnh sửa'} · ${src.name}`.slice(0, 100), src.kind === 'group' ? src.layer : null);
      toast('Đã thêm kết quả AI thành layer mới', 'success');
      return;
    }
    const blob = await canvasToBlob(canvas, 'image/png');
    const file = new File([blob], `${String(src.name || 'layer').replace(/[\\/:*?"<>|]/g, '_')}-ai.png`, { type: 'image/png' });
    await replaceLayerImage(src.layer, file, 'stretch', state.applyAllInstances);
  }

  $('aiBtn').onclick = () => openAi();
  $('ctxAi').onclick = () => openAi(null, 'layer');
  $('aiRun').onclick = aiRun;
  $('aiApply').onclick = aiApply;
  $('aiRetry').onclick = () => { aiState.result = null; refreshAiUI(); aiRun(); };
  document.querySelectorAll('[data-ai-close]').forEach((b) => (b.onclick = closeAi));
  $('aiModal').addEventListener('click', (e) => { if (e.target === $('aiModal')) closeAi(); });
  $('aiTargetSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => { aiState.target = b.dataset.target; aiState.result = null; refreshAiUI(); }));
  $('aiTabs').querySelectorAll('button').forEach((b) => (b.onclick = () => { aiState.tab = b.dataset.tab; aiState.result = null; refreshAiUI(); }));
  $('aiPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) aiRun(); });

  // ---- cài đặt AI
  function fillModelSelect(sel, list, current) {
    const ids = (list || []).map((m) => m.id);
    if (current && !ids.includes(current)) ids.unshift(current);
    sel.innerHTML = ids.map((id) => `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`).join('');
  }
  function setKeyStatus(kind, html) {
    const s = $('aiKeyStatus');
    s.hidden = !html;
    s.className = 'font-status ' + (kind || '');
    s.innerHTML = html ? `${ic(kind === 'ok' ? 'check' : kind === 'missing' ? 'alert' : 'refresh')}<span>${html}</span>` : '';
  }
  async function openAiSettings() {
    const st = await aiRefreshStatus();
    $('aiKey').value = '';
    $('aiKey').placeholder = st?.configured ? `Đã lưu: ${st.keyHint} (nhập key mới để thay)` : 'AIza…';
    $('aiKeyDelete').hidden = !st?.configured;
    fillModelSelect($('aiImageModel'), aiState.models?.image, st?.imageModel);
    fillModelSelect($('aiSegModel'), aiState.models?.seg, st?.segModel);
    setKeyStatus(st?.configured ? 'ok' : '', st?.configured ? `Đã có API key <b>${esc(st.keyHint)}</b>` : '');
    $('aiSettingsModal').hidden = false;
    if (st?.configured && !aiState.models) {
      api('/api/ai/models').then((m) => {
        aiState.models = m;
        fillModelSelect($('aiImageModel'), m.image, st.imageModel);
        fillModelSelect($('aiSegModel'), m.seg, st.segModel);
      }).catch((err) => setKeyStatus('missing', esc(err.message)));
    }
  }
  const closeAiSettings = () => { $('aiSettingsModal').hidden = true; };
  $('aiOpenSettings').onclick = openAiSettings;
  document.querySelectorAll('[data-ais-close]').forEach((b) => (b.onclick = closeAiSettings));
  $('aiSettingsModal').addEventListener('click', (e) => { if (e.target === $('aiSettingsModal')) closeAiSettings(); });
  $('aiKeyShow').onclick = () => { const k = $('aiKey'); k.type = k.type === 'password' ? 'text' : 'password'; setIcon($('aiKeyShow').querySelector('i'), k.type === 'password' ? 'eye' : 'eyeoff'); };
  $('aiKeySave').onclick = async () => {
    const key = $('aiKey').value.trim();
    const body = {};
    if (key) body.apiKey = key;
    else if (!aiState.status?.configured) { setKeyStatus('missing', 'Hãy dán Gemini API key.'); return; }
    if (!key) { body.imageModel = $('aiImageModel').value; body.segModel = $('aiSegModel').value; }
    setKeyStatus('', 'Đang kiểm tra key với Google…');
    $('aiKeySave').disabled = true;
    try {
      const r = await api('/api/ai/config', body);
      if (r.models) {
        aiState.models = r.models;
        fillModelSelect($('aiImageModel'), r.models.image, r.imageModel);
        fillModelSelect($('aiSegModel'), r.models.seg, r.segModel);
      }
      aiState.status = r;
      setKeyStatus('ok', `Key hợp lệ <b>${esc(r.keyHint)}</b> · ${r.models ? r.models.image.length + ' model ảnh khả dụng' : 'đã lưu cài đặt'}`);
      $('aiKey').value = '';
      $('aiKeyDelete').hidden = false;
      toast('Đã lưu cài đặt AI', 'success');
      refreshAiUI();
      if (r.models && !r.models.image.length) setKeyStatus('missing', 'Key hợp lệ nhưng không có model sửa ảnh nào khả dụng cho key này.');
    } catch (err) {
      setKeyStatus('missing', esc(err.message));
    } finally { $('aiKeySave').disabled = false; }
  };
  $('aiKeyDelete').onclick = async () => {
    if (!confirm('Xóa Gemini API key đã lưu trên máy này?')) return;
    await api('/api/ai/config', { apiKey: '' }).catch(() => {});
    aiState.models = null;
    await openAiSettings();
    refreshAiUI();
    toast('Đã xóa API key');
  };

  // ---------------------------------------------------------------- init
  hydrateIcons();
  applyTheme(document.documentElement.dataset.theme || 'dark');
  initAuth();
  buildProps();
  updateButtons();
  async function exportCurrentToBlob() {
    if (!state.psd) return null;
    const psd = state.psd;
    const prevCanvas = psd.canvas, prevLinked = psd.linkedFiles, prevImageData = psd.imageData;
    try {
      const comp = renderComposite(true);
      psd.canvas = comp;
      delete psd.imageData;
      const textEdited = allLayers().some((l) => editedText.has(l));
      const buf = writePsd(psd, { generateThumbnail: true, invalidateTextLayers: textEdited });
      let thumb = '';
      try {
        const tc = createCanvas(240, Math.max(1, Math.round((240 * psd.height) / Math.max(1, psd.width))));
        ctx2d(tc).drawImage(comp, 0, 0, tc.width, tc.height);
        thumb = tc.toDataURL('image/jpeg', 0.78);
      } catch {}
      psd.canvas = prevCanvas; psd.linkedFiles = prevLinked; psd.imageData = prevImageData;
      return {
        blob: new Blob([buf], { type: 'image/vnd.adobe.photoshop' }),
        fileName: state.fileName || 'design.psd',
        width: psd.width,
        height: psd.height,
        layerCount: allLayers().length,
        thumb,
      };
    } catch (err) {
      psd.canvas = prevCanvas; psd.linkedFiles = prevLinked; psd.imageData = prevImageData;
      throw err;
    }
  }

  window.__psdStudio = { state, authState, renderComposite, renderNode, fontDB, findFont, applyTextEdit, openFile, exportCurrentToBlob, toast, allLayers }; // tiện debug & kết nối Database
})();
