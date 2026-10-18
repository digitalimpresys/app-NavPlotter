// NavPlotter app: wind and currents over the chart, and passage planning on a route.
// App only (the node's firmware does not have it): loaded after the page script (see scripts/sync-web.mjs), it
// uses the page's own map, waypoints and routes, and draws over the chart after the page has drawn it.
// Forecasts come from Open-Meteo (wind: best model for the area; currents and waves: Open-Meteo Marine). They are
// downloaded when the phone has internet and kept on the phone, so at sea, on the node's WiFi with no signal, the
// last forecast and the last plan are still there.
(function () {
  'use strict';
  if (typeof drawMap !== 'function' || typeof map === 'undefined' || typeof ud === 'undefined') return;

  const isIt = () => (typeof lang === 'string' ? lang : document.documentElement.lang || '').startsWith('it');
  const L = (i, e) => (isIt() ? i : e);
  const cap = window.Capacitor, native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const H = 3600;

  // ---------- internet ----------
  // On the node's WiFi the whole app is bound to it (it has no internet): the native side then goes out on
  // mobile data, or on the boat WiFi when that one has internet.
  function getJSON(url) {
    const viaWeb = () => fetch(url).then((r) => r.json().then((j) => { if (!r.ok) throw new Error((j && j.reason) || 'HTTP ' + r.status); return j; }));
    if (!native) return viaWeb();
    return cap.nativePromise('NodeWatch', 'internetGet', { url }).then((r) => {
      const j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      if (r.status !== 200) throw new Error((j && j.reason) || 'HTTP ' + r.status);
      return j;
    }, () => viaWeb());
  }

  // ---------- forecasts ----------
  // For a list of points: hourly wind, gusts, current and waves. Each point keeps vectors (u east, v north, both
  // pointing where the air or the water goes), so that they can be averaged in time and space.
  const TO_KN = { kn: 1, 'km/h': 1 / 1.852, 'm/s': 1 / 0.514444, mph: 0.868976 };
  function forecast(pts, days) {
    const q = '?latitude=' + pts.map((p) => p.lat.toFixed(3)).join(',') + '&longitude=' + pts.map((p) => p.lon.toFixed(3)).join(',') +
      '&timeformat=unixtime&forecast_days=' + days;
    const wind = getJSON('https://api.open-meteo.com/v1/forecast' + q + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn');
    const sea = getJSON('https://marine-api.open-meteo.com/v1/marine' + q + '&hourly=ocean_current_velocity,ocean_current_direction,wave_height').catch(() => null);
    return Promise.all([wind, sea]).then(([w, s]) => {
      const wl = Array.isArray(w) ? w : [w], sl = s ? (Array.isArray(s) ? s : [s]) : [];
      const t0 = wl[0].hourly.time[0], nt = wl[0].hourly.time.length;
      const cells = pts.map((p, i) => {
        const h = wl[i].hourly, wk = TO_KN[(wl[i].hourly_units || {}).wind_speed_10m] || 1;
        const c = { wu: [], wv: [], wg: [], cu: null, cv: null, wh: null };
        for (let k = 0; k < nt; k++) {
          const sp = h.wind_speed_10m[k], d = h.wind_direction_10m[k];
          // Wind direction is where it comes from: the vector goes the other way
          c.wu.push(sp == null || d == null ? null : r1(-sp * wk * Math.sin(d * D2R)));
          c.wv.push(sp == null || d == null ? null : r1(-sp * wk * Math.cos(d * D2R)));
          c.wg.push(h.wind_gusts_10m[k] == null ? null : r1(h.wind_gusts_10m[k] * wk));
        }
        const m = sl[i] && sl[i].hourly;
        if (m && m.time && m.time.length) {
          const ck = TO_KN[(sl[i].hourly_units || {}).ocean_current_velocity] || 1 / 1.852, off = Math.round((m.time[0] - t0) / H);
          c.cu = []; c.cv = []; c.wh = [];
          for (let k = 0; k < nt; k++) {
            const j = k - off, sp = m.ocean_current_velocity[j], d = m.ocean_current_direction[j], wh = m.wave_height[j];
            // Current direction is where it goes
            c.cu.push(sp == null || d == null ? null : Math.round(sp * ck * Math.sin(d * D2R) * 100) / 100);
            c.cv.push(sp == null || d == null ? null : Math.round(sp * ck * Math.cos(d * D2R) * 100) / 100);
            c.wh.push(wh == null ? null : r1(wh));
          }
        }
        return c;
      });
      return { t0, nt, cells, at: Date.now() };
    });
  }
  // Fractional hour index of time t (unix seconds) in a forecast, or null outside it
  function tIdx(d, t) { const f = (t - d.t0) / H; return f < 0 || f > d.nt - 1 ? null : f; }
  function lin(arr, f) {
    if (!arr) return null;
    if (arr.length === 1) return arr[0];
    const i = Math.min(Math.floor(f), arr.length - 2), k = f - i, a = arr[i], b = arr[i + 1];
    if (a == null || b == null) return a != null ? a : b;
    return a + (b - a) * k;
  }
  function cellAt(c, f) {
    const u = lin(c.wu, f), v = lin(c.wv, f);
    if (u == null || v == null) return null;
    const cu = lin(c.cu, f), cv = lin(c.cv, f);
    return { u, v, g: lin(c.wg, f), cu: cu == null || cv == null ? null : cu, cv: cu == null || cv == null ? null : cv, wh: lin(c.wh, f) };
  }
  // Average of a few samples with weights; current and waves only where the sea model has them
  function blend(list) {
    const o = { u: 0, v: 0, g: 0, cu: 0, cv: 0, wh: 0 }, wt = { w: 0, g: 0, c: 0, h: 0 };
    for (const [s, k] of list) {
      if (!s || k <= 0) continue;
      o.u += s.u * k; o.v += s.v * k; wt.w += k;
      if (s.g != null) { o.g += s.g * k; wt.g += k; }
      if (s.cu != null) { o.cu += s.cu * k; o.cv += s.cv * k; wt.c += k; }
      if (s.wh != null) { o.wh += s.wh * k; wt.h += k; }
    }
    if (!wt.w) return null;
    return { u: o.u / wt.w, v: o.v / wt.w, g: wt.g ? o.g / wt.g : null, cu: wt.c ? o.cu / wt.c : null, cv: wt.c ? o.cv / wt.c : null, wh: wt.h ? o.wh / wt.h : null };
  }
  const windKn = (s) => Math.hypot(s.u, s.v);
  const windFrom = (s) => (Math.atan2(-s.u, -s.v) * R2D + 360) % 360;
  const curKn = (s) => (s.cu == null ? null : Math.hypot(s.cu, s.cv));
  const curTo = (s) => (Math.atan2(s.cu, s.cv) * R2D + 360) % 360;
  const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
  const COMPASS_IT = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'], COMPASS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const card8 = (d) => (isIt() ? COMPASS_IT : COMPASS_EN)[Math.round(d / 45) % 8];

  // ---------- time labels ----------
  const loc = () => (isIt() ? 'it-IT' : 'en-GB');
  const fmtWhen = (t) => new Date(t * 1000).toLocaleString(loc(), { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtHM = (t) => new Date(t * 1000).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (s) => { const m = Math.round(s / 60); return (m >= 60 ? Math.floor(m / 60) + ' h ' : '') + (m % 60) + ' min'; };
  const fmtAge = (ms) => new Date(ms).toLocaleString(loc(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nowHour = () => Math.round(Date.now() / 1000 / H) * H;

  // ================= wind and currents over the chart =================
  // grid: forecast for a lattice of points over the area of the chart; lats and lons ascending
  let grid = load('np-mx-grid');
  const mx = { layer: null, last: load('np-mx-layer') || 'wind', time: nowHour(), busy: false, tried: 0, err: null };

  function gridAt(lat, lon, f) {
    const g = grid, nla = g.lats.length, nlo = g.lons.length;
    const fy = (lat - g.lats[0]) / (g.lats[nla - 1] - g.lats[0]) * (nla - 1), fx = (lon - g.lons[0]) / (g.lons[nlo - 1] - g.lons[0]) * (nlo - 1);
    if (!(fy >= 0 && fy <= nla - 1 && fx >= 0 && fx <= nlo - 1)) return null;
    const y0 = Math.min(Math.floor(fy), nla - 2), x0 = Math.min(Math.floor(fx), nlo - 2), ky = fy - y0, kx = fx - x0;
    const c = (y, x) => cellAt(g.cells[y * nlo + x], f);
    return blend([[c(y0, x0), (1 - ky) * (1 - kx)], [c(y0, x0 + 1), (1 - ky) * kx], [c(y0 + 1, x0), ky * (1 - kx)], [c(y0 + 1, x0 + 1), ky * kx]]);
  }
  function view() {
    const cv = $('map'), w = cv.clientWidth, h = cv.clientHeight, z = map.z;
    const ox = Math.round(lonToX(map.lon, z) - w / 2), oy = Math.round(latToY(map.lat, z) - h / 2);
    return { w, h, z, ox, oy, px: (lat, lon) => [lonToX(lon, z) - ox, latToY(lat, z) - oy], ll: (x, y) => ({ lat: yToLat(oy + y, z), lon: xToLon(ox + x, z) }) };
  }
  const covers = (lat, lon) => grid && lat >= grid.lats[0] && lat <= grid.lats[grid.lats.length - 1] && lon >= grid.lons[0] && lon <= grid.lons[grid.lons.length - 1];
  // The whole chart on the screen is inside the grid
  function coversView() {
    const v = view();
    if (!v.w) return true;
    const a = v.ll(0, 0), b = v.ll(v.w, v.h);
    return !!grid && covers(a.lat, a.lon) && covers(b.lat, b.lon);
  }

  // Downloads the forecast for the chart area (a third more on each side), when the chart shows somewhere the
  // grid does not cover or the grid is more than three hours old
  function ensureGrid(force) {
    if (mx.busy) return;
    const v = view();
    if (!v.w) return;
    const fresh = grid && Date.now() - grid.at < 3 * H * 1000 && coversView();
    if (!force && (fresh || Date.now() - mx.tried < 60000)) return;
    const a = v.ll(-v.w / 3, -v.h / 3), b = v.ll(v.w * 4 / 3, v.h * 4 / 3);
    const n = 7, lats = [], lons = [];
    for (let i = 0; i < n; i++) { lats.push(b.lat + (a.lat - b.lat) * i / (n - 1)); lons.push(a.lon + (b.lon - a.lon) * i / (n - 1)); }
    const pts = [];
    for (const la of lats) for (const lo of lons) pts.push({ lat: la, lon: lo });
    mx.busy = true; mx.tried = Date.now(); mx.err = null; renderBar();
    forecast(pts, 4).then((d) => {
      grid = { lats: lats.map((x) => Math.round(x * 1000) / 1000), lons: lons.map((x) => Math.round(x * 1000) / 1000), t0: d.t0, nt: d.nt, cells: d.cells, at: d.at };
      save('np-mx-grid', grid);
      mx.busy = false; clampTime(); renderBar(); drawMap();
    }, (e) => { mx.busy = false; mx.err = String((e && e.message) || e); renderBar(); });
  }
  function clampTime() {
    if (!grid) return;
    const lo = Math.max(grid.t0, nowHour() - H), hi = grid.t0 + (grid.nt - 1) * H;
    mx.time = Math.max(lo, Math.min(hi, mx.time));
  }

  // Wind barb: the staff points where the wind comes from; a long feather is 10 kn, a short one 5, a flag 50
  const windCol = (k) => (k < 8 ? '#2e7d32' : k < 14 ? '#1565c0' : k < 20 ? '#ef6c00' : k < 27 ? '#d32f2f' : '#7b1fa2');
  const curCol = (k) => (k < 0.3 ? '#00838f' : k < 0.6 ? '#1565c0' : k < 1 ? '#6a1b9a' : '#c62828');
  function barb(c, x, y, from, kn) {
    const col = windCol(kn);
    c.save(); c.translate(x, y); c.lineCap = 'round'; c.lineJoin = 'round';
    const path = () => {
      c.beginPath();
      if (kn < 2.5) { c.arc(0, 0, 5, 0, 7); return; }
      c.rotate(from * D2R);
      const len = 26; c.moveTo(0, 0); c.lineTo(0, -len);
      let r = Math.round(kn / 5) * 5, pos = -len;
      if (r < 10) pos += 4; // a lone short feather sits a little in from the end
      while (r >= 50) { c.moveTo(0, pos); c.lineTo(11, pos - 3); c.lineTo(0, pos + 6); pos += 8; r -= 50; }
      while (r >= 10) { c.moveTo(0, pos); c.lineTo(11, pos - 5); pos += 4.5; r -= 10; }
      if (r >= 5) { c.moveTo(0, pos); c.lineTo(6, pos - 2.7); }
    };
    path(); c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 4.5; c.stroke();
    c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    c.restore();
    c.fillStyle = col; c.beginPath(); c.arc(x, y, 2.2, 0, 7); c.fill();
  }
  function arrow(c, x, y, to, kn) {
    const col = curCol(kn), len = Math.min(38, 10 + kn * 26);
    c.save(); c.translate(x, y); c.rotate(to * D2R); c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(0, len / 2); c.lineTo(0, -len / 2); c.moveTo(-5, -len / 2 + 7); c.lineTo(0, -len / 2); c.lineTo(5, -len / 2 + 7);
    c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 5; c.stroke(); c.strokeStyle = col; c.lineWidth = 2.4; c.stroke();
    c.restore();
  }

  function drawOverlay() {
    const v = view(), c = $('map').getContext('2d');
    if (plan.show && plan.res) drawPlan(c, v);
    if (!mx.layer || !grid) return;
    const f = tIdx(grid, mx.time);
    if (f == null) return;
    const step = 72;
    for (let y = step / 2; y < v.h; y += step) {
      for (let x = step / 2; x < v.w; x += step) {
        const p = v.ll(x, y), s = gridAt(p.lat, p.lon, f);
        if (!s) continue;
        if (mx.layer === 'wind') barb(c, x, y, windFrom(s), windKn(s));
        else if (s.cu != null && curKn(s) >= 0.05) arrow(c, x, y, curTo(s), curKn(s));
      }
    }
  }
  const pageDraw = window.drawMap;
  window.drawMap = function () {
    pageDraw.apply(this, arguments);
    if (!$('pMap').classList.contains('on')) return;
    try { drawOverlay(); } catch (e) { console.warn('meteo', e); }
    if (mx.layer && !coversView()) ensureGrid(false);
  };

  // ---------- map button and time bar ----------
  const css = document.createElement('style');
  css.textContent =
    '#mxBar{position:absolute;left:10px;right:66px;top:10px;max-width:420px;background:rgba(18,41,74,.94);border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:none;font-size:13px}' +
    '#mxBar.on{display:block}#mxBar .seg{margin-bottom:6px}#mxBar .seg button{padding:6px;font-size:14px}' +
    '#mxTime{display:flex;align-items:center;gap:6px}#mxTime b{flex:1;text-align:center;font-size:15px}' +
    '#mxTime button{width:38px;height:32px;border-radius:8px;border:1px solid var(--line);background:none;color:var(--text);font-size:15px}' +
    '#mxSlide{width:100%;margin:6px 0 2px}#mxLeg{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;color:var(--dim)}' +
    '#mxLeg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}' +
    '#mxNote{color:var(--dim);margin-top:4px;display:flex;gap:8px;align-items:center}#mxNote span{flex:1}' +
    '#mxNote button{border:1px solid var(--line);background:none;color:var(--text);border-radius:8px;padding:4px 9px;font-size:13px}' +
    '#mxPlan{margin-top:4px;color:#ffb74d;display:none}#mxPlan.on{display:flex;gap:8px;align-items:center}#mxPlan span{flex:1}' +
    '#mxPlan button{border:1px solid var(--line);background:none;color:var(--text);border-radius:8px;padding:2px 8px}' +
    '#planPane input{width:100%;padding:11px;border-radius:9px;border:1px solid var(--line);background:#0b1d33;color:var(--text);font-size:16px;color-scheme:dark}' +
    '.plWarn{margin-top:6px;font-size:14px}.plWarn.w1{color:#ffb74d}.plWarn.w2{color:#ff6b6b;font-weight:700}' +
    '.card.w1{border-color:#ef6c00}.card.w2{border-color:var(--red);box-shadow:0 0 0 1px var(--red) inset}' +
    '.plAlt{display:flex;gap:8px;align-items:center;width:100%;text-align:left;margin-top:6px;padding:9px 10px;border-radius:9px;border:1px solid var(--line);background:none;color:var(--text);font-size:14px}' +
    '.plAlt.on{border-color:var(--accent);background:rgba(61,165,255,.16)}.plAlt span{flex:1}.plAlt b.w1{color:#ffb74d}.plAlt b.w2{color:#ff6b6b}';
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'mxBtn'; btn.innerHTML = '&#8779;';
  $('mapBtns').appendChild(btn);
  const bar = document.createElement('div');
  bar.id = 'mxBar';
  bar.innerHTML = '<div class="seg"><button id="mxWind"></button><button id="mxCur"></button></div>' +
    '<div id="mxTime"><button id="mxPrev">&#9664;</button><b id="mxWhen"></b><button id="mxNext">&#9654;</button></div>' +
    '<input type="range" id="mxSlide" step="3600"><div id="mxLeg"></div>' +
    '<div id="mxPlan"><span id="mxPlanTxt"></span><button id="mxPlanOff">&times;</button></div>' +
    '<div id="mxNote"><span id="mxNoteTxt"></span><button id="mxRefresh">&#8635;</button></div>';
  $('pMap').appendChild(bar);
  // Touches on the bar must not reach the chart under it
  ['pointerdown', 'wheel'].forEach((ev) => bar.addEventListener(ev, (e) => e.stopPropagation()));

  function setLayer(k) {
    mx.layer = k;
    if (k) { mx.last = k; save('np-mx-layer', k); clampTime(); ensureGrid(false); }
    renderBar(); drawMap();
  }
  btn.onclick = () => setLayer(mx.layer ? null : mx.last);
  $('mxWind').onclick = () => setLayer('wind');
  $('mxCur').onclick = () => setLayer('current');
  $('mxPrev').onclick = () => { mx.time -= H; clampTime(); renderBar(); drawMap(); };
  $('mxNext').onclick = () => { mx.time += H; clampTime(); renderBar(); drawMap(); };
  $('mxSlide').oninput = (e) => { mx.time = +e.target.value; renderBar(true); drawMap(); };
  $('mxRefresh').onclick = () => ensureGrid(true);
  $('mxPlanOff').onclick = () => { plan.show = false; renderBar(); drawMap(); };

  function renderBar(sliding) {
    btn.classList.toggle('on', !!mx.layer);
    bar.classList.toggle('on', !!mx.layer || (plan.show && !!plan.res));
    $('mxWind').textContent = L('Vento', 'Wind'); $('mxCur').textContent = L('Corrente', 'Current');
    $('mxWind').classList.toggle('on', mx.layer === 'wind'); $('mxCur').classList.toggle('on', mx.layer === 'current');
    $('mxWhen').textContent = fmtWhen(mx.time);
    const sl = $('mxSlide');
    if (grid && !sliding) { sl.min = Math.max(grid.t0, nowHour() - H); sl.max = grid.t0 + (grid.nt - 1) * H; sl.value = mx.time; }
    sl.style.display = grid ? '' : 'none';
    $('mxLeg').innerHTML = mx.layer === 'current'
      ? [[0.2, '< 0,3'], [0.4, '0,3-0,6'], [0.8, '0,6-1'], [1.2, '> 1']].map((x) => '<span><i style="background:' + curCol(x[0]) + '"></i>' + x[1] + '</span>').join('') + '<span>kn</span>'
      : mx.layer === 'wind' ? [[5, '< 8'], [10, '8-14'], [16, '14-20'], [22, '20-27'], [30, '> 27']].map((x) => '<span><i style="background:' + windCol(x[0]) + '"></i>' + x[1] + '</span>').join('') + '<span>kn</span>' : '';
    const p = plan.show && plan.res;
    $('mxPlan').classList.toggle('on', !!p);
    if (p) {
      const r = plan.res, pos = r && mx.time >= r.dep && mx.time <= r.end;
      $('mxPlanTxt').textContent = L('Piano: ', 'Plan: ') + plan.name + ' · ' + (pos ? L('barca alla posizione stimata', 'boat at the estimated position') : mx.time < r.dep ? L('prima della partenza', 'before departure') : L('arrivata', 'arrived'));
    }
    const out = grid && !coversView();
    $('mxNoteTxt').textContent = mx.busy ? L('Scarico le previsioni...', 'Downloading the forecast...')
      : mx.err ? (grid ? L('Senza internet: previsioni del ', 'No internet: forecast of ') + fmtAge(grid.at) : L('Nessuna previsione: serve internet', 'No forecast yet: internet needed'))
      : grid ? (out ? L('Parte della carta è fuori dall\'area scaricata: tocca ↻', 'Part of the chart is outside the downloaded area: tap ↻') : 'Open-Meteo · ' + fmtAge(grid.at)) : '';
  }

  // Tap on open water with the layer on: wind, current and waves at that point
  const pageTap = window.tapAt;
  window.tapAt = function (p) {
    const was = $('sheet').classList.contains('on');
    pageTap(p);
    if (!mx.layer || !grid || was || $('sheet').classList.contains('on')) return;
    const v = view(), q = v.ll(p.x, p.y), f = tIdx(grid, mx.time), s = f == null ? null : gridAt(q.lat, q.lon, f);
    if (!s) return;
    const lines = [L('Vento ', 'Wind ') + windKn(s).toFixed(0) + ' kn ' + L('da ', 'from ') + card8(windFrom(s)) + ' (' + pad3(windFrom(s)) + '&deg;)' + (s.g != null ? ' &middot; ' + L('raffiche ', 'gusts ') + s.g.toFixed(0) + ' kn' : '')];
    if (s.cu != null) lines.push(L('Corrente ', 'Current ') + curKn(s).toFixed(1) + ' kn ' + L('verso ', 'towards ') + card8(curTo(s)) + ' (' + pad3(curTo(s)) + '&deg;)');
    if (s.wh != null) lines.push(L('Onda ', 'Waves ') + s.wh.toFixed(1) + ' m');
    $('sheet')._html = null;
    $('sheet').innerHTML = '<h3>' + esc(fmtWhen(mx.time)) + '</h3>' + lines.map((x) => '<div class="sub">' + x + '</div>').join('') +
      '<div class="sub">' + q.lat.toFixed(4) + ', ' + q.lon.toFixed(4) + '</div><div class="row"><button class="btn sec" onclick="closeSheet()">' + esc(t('close')) + '</button></div>';
    $('sheet').classList.add('on');
  };

  // ================= passage planning =================
  // A route is cut into pieces of a few miles; the forecast is asked for each piece; then the boat is moved along
  // the route at its speed through the water plus the current along the course, hour after hour, reading the
  // wind where and when it is.
  const plan = Object.assign({ route: null, dep: null, stw: 5, sail: false, beat: 45, corr: 1, show: false }, load('np-plan') || {});
  plan.show = false; plan.res = null; plan.name = '';
  let planData = load('np-plan-data'); // {key, samples, t0, nt, cells, at}

  function routeKey(pts) { return pts.map((p) => p.lat.toFixed(4) + ',' + p.lon.toFixed(4)).join(';'); }
  function samplesOf(pts) {
    const total = pathNm(pts), step = Math.max(3, total / 60), out = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1], n = Math.max(1, Math.ceil(distBrg(a.lat, a.lon, b.lat, b.lon).nm / step));
      for (let j = 0; j < n; j++) out.push({ lat: a.lat + (b.lat - a.lat) * j / n, lon: a.lon + (b.lon - a.lon) * j / n, leg: k });
    }
    const z = pts[pts.length - 1];
    out.push({ lat: z.lat, lon: z.lon, leg: pts.length - 1 });
    return out;
  }

  const SAIL_IT = ['in prua', 'bolina', 'traverso', 'lasco', 'poppa'], SAIL_EN = ['on the nose', 'close-hauled', 'beam reach', 'broad reach', 'running'];
  const pointOfSail = (twa) => (isIt() ? SAIL_IT : SAIL_EN)[twa < 40 ? 0 : twa < 70 ? 1 : twa < 110 ? 2 : twa < 150 ? 3 : 4];

  // Speed through the water for an angle to the true wind: the average speed given is the one on a reach
  const polar = (twa) => (twa < 60 ? 0.85 : twa < 120 ? 1 : twa < 160 ? 0.95 : 0.85);
  const sgn180 = (a) => ((((a % 360) + 540) % 360) - 180);
  function nearestCell(pd, lat, lon) {
    const k = Math.cos(lat * D2R);
    let best = 0, bd = Infinity;
    pd.samples.forEach((q, i) => { const d = (q.lat - lat) ** 2 + ((q.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }

  // The boat is moved in steps of three minutes: heading for the next waypoint, or, under sail with the waypoint
  // inside the no-go cone (closer than the beating angle to the wind, or straight downwind), on one tack until
  // the waypoint can be fetched on the other (the layline) or the boat is too far off the direct line. Wind and
  // current are read where the boat is and when it is there; the current carries the boat over the ground.
  // o: {stw, sail, beat, corr}
  function simulate(pd, pts, dep, o) {
    const stw = o.stw, DT = 0.05;
    const legs = pts.slice(0, -1).map((a, k) => {
      const b = pts[k + 1], d = distBrg(a.lat, a.lon, b.lat, b.lon);
      return { from: a.name, to: b.name, nm: d.nm, brg: d.brg, start: null, end: null, maxWs: 0, maxG: 0, minTwa: 180, along: 0, hours: 0,
        maxWh: 0, mid: null, beyond: false, warn: [], info: [], sailed: 0, tacks: 0, gybes: 0, motor: 0, stuck: false };
    });
    let t = dep;
    const track = [{ t, lat: pts[0].lat, lon: pts[0].lon }];
    legs.forEach((leg, k) => {
      const A = pts[k], B = pts[k + 1];
      const P = { lat: A.lat, lon: A.lon };
      let side = 0, lastHead = null, n = 0;
      leg.start = t;
      while (n++ < 20000) {
        const db = distBrg(P.lat, P.lon, B.lat, B.lon);
        if (db.nm < 0.02) break;
        const f = tIdx(pd, t), s = f == null ? null : cellAt(pd.cells[nearestCell(pd, P.lat, P.lon)], f);
        let head = db.brg, sp = stw, cu = 0, cv = 0, ws = 0, from = 0, turn = null;
        if (s) {
          ws = windKn(s); from = windFrom(s);
          leg.maxWs = Math.max(leg.maxWs, ws);
          if (s.g != null) leg.maxG = Math.max(leg.maxG, s.g);
          if (ws >= 8) leg.minTwa = Math.min(leg.minTwa, angDiff(from, db.brg));
          if (s.wh != null) leg.maxWh = Math.max(leg.maxWh, s.wh);
          if (s.cu != null) { cu = s.cu; cv = s.cv; }
          if (1 - db.nm / leg.nm <= 0.5 || !leg.mid) leg.mid = { ws, from, g: s.g, twa: angDiff(from, db.brg) };
        } else leg.beyond = true;
        // Close to the waypoint the boat just goes there
        if (db.nm < 0.3) { /* direct */ } else if (o.sail && s && ws < 5) leg.motor += DT;
        else if (o.sail && s) {
          let cone = null;
          for (const c of [{ c: from, half: o.beat, up: true }, { c: from + 180, half: 20, up: false }]) {
            const rel = sgn180(db.brg - c.c);
            if (Math.abs(rel) < c.half) { cone = c; if (!side) side = rel >= 0 ? 1 : -1; break; }
          }
          if (cone) {
            head = cone.c + side * cone.half;
            // Cross-track distance from the direct line, positive to its right
            const fromA = distBrg(A.lat, A.lon, P.lat, P.lon), xte = fromA.nm * Math.sin((fromA.brg - leg.brg) * D2R);
            if (o.corr > 0 && xte * Math.sign(Math.sin((head - leg.brg) * D2R)) >= o.corr) { side = -side; head = cone.c + side * cone.half; }
            turn = cone.up ? 'tack' : 'gybe';
          } else side = 0;
          sp = stw * polar(angDiff(from, head));
        }
        head = (head + 360) % 360;
        // A turn of more than 50 degrees on a tack or a gybe is counted, and marked on the track
        if (lastHead != null && angDiff(head, lastHead) > 50 && o.sail) {
          const up = angDiff(from, head) < 90 || angDiff(from, lastHead) < 90;
          if (up) leg.tacks++; else leg.gybes++;
          track.push({ t, lat: P.lat, lon: P.lon, turn: up ? 'tack' : 'gybe' });
        }
        lastHead = head;
        const vx = sp * Math.sin(head * D2R) + cu, vy = sp * Math.cos(head * D2R) + cv;
        const sog = Math.max(0.3, Math.hypot(vx, vy));
        let dt = DT;
        const direct = head === (db.brg + 360) % 360;
        if (direct && db.nm <= sog * dt) {
          dt = db.nm / sog; P.lat = B.lat; P.lon = B.lon;
        } else {
          P.lat += vy * dt / 60; P.lon += vx * dt / (60 * Math.cos(P.lat * D2R));
        }
        leg.along += (cu * Math.sin(leg.brg * D2R) + cv * Math.cos(leg.brg * D2R)) * dt; leg.hours += dt;
        leg.sailed += sog * dt;
        t += dt * H;
        if (n % 3 === 0 || P.lat === B.lat) track.push({ t, lat: P.lat, lon: P.lon });
      }
      if (n >= 20000) leg.stuck = true;
      leg.end = t;
      const last = track[track.length - 1];
      if (last.lat !== B.lat || last.lon !== B.lon) track.push({ t, lat: B.lat, lon: B.lon });
    });
    let maxWs = 0, maxG = 0, w = 0;
    for (const g of legs) {
      g.along = g.hours ? g.along / g.hours : 0;
      if (g.maxG >= 25 || g.maxWs >= 22) g.warn.push([2, L('Vento forte: ', 'Strong wind: ') + g.maxWs.toFixed(0) + ' kn, ' + L('raffiche ', 'gusts ') + g.maxG.toFixed(0)]);
      else if (g.maxWs >= 16 || g.maxG >= 20) g.warn.push([1, L('Vento fresco: ', 'Fresh wind: ') + g.maxWs.toFixed(0) + ' kn, ' + L('raffiche ', 'gusts ') + g.maxG.toFixed(0)]);
      if (!o.sail && g.minTwa < 40) g.warn.push([1, L('Vento in prua: a vela si bordeggia, ci vuole più tempo', 'Wind on the nose: under sail you tack, it takes longer')]);
      if (o.sail && (g.tacks || g.gybes)) {
        g.info.push((g.tacks ? g.tacks + ' ' + L(g.tacks === 1 ? 'virata' : 'virate', g.tacks === 1 ? 'tack' : 'tacks') : '') + (g.tacks && g.gybes ? ', ' : '') +
          (g.gybes ? g.gybes + ' ' + L(g.gybes === 1 ? 'strambata' : 'strambate', g.gybes === 1 ? 'gybe' : 'gybes') : '') + ' &middot; ' +
          L('percorse ', 'sailed ') + fmtNm(g.sailed) + ' NM (+' + Math.round((g.sailed / g.nm - 1) * 100) + '%)');
      }
      if (o.sail && g.motor >= 0.5) g.warn.push([1, L('Vento debole per ', 'Light wind for ') + fmtDur(g.motor * H) + L(': a motore', ': motoring')]);
      if (g.along <= -0.8) g.warn.push([1, L('Corrente contraria ', 'Foul current ') + (-g.along).toFixed(1) + ' kn']);
      if (g.maxWh >= 2) g.warn.push([2, L('Mare formato: onda ', 'Rough sea: waves ') + g.maxWh.toFixed(1) + ' m']);
      else if (g.maxWh >= 1.25) g.warn.push([1, L('Mare mosso: onda ', 'Moderate sea: waves ') + g.maxWh.toFixed(1) + ' m']);
      if (g.beyond) g.warn.push([1, L('Oltre la previsione: dati incompleti', 'Beyond the forecast: data missing')]);
      if (g.stuck) g.warn.push([2, L('La barca non avanza contro vento e corrente', 'The boat makes no headway against wind and current')]);
      g.level = g.warn.reduce((m, x) => Math.max(m, x[0]), 0);
      maxWs = Math.max(maxWs, g.maxWs); maxG = Math.max(maxG, g.maxG); w = Math.max(w, g.level);
    }
    return { dep, end: t, legs, track, maxWs, maxG, level: w, nm: legs.reduce((s, g) => s + g.nm, 0), sailed: legs.reduce((s, g) => s + g.sailed, 0),
      tacks: legs.reduce((s, g) => s + g.tacks, 0), gybes: legs.reduce((s, g) => s + g.gybes, 0) };
  }

  // Position on the planned track at time t
  function planPos(r, t) {
    const tr = r.track;
    if (t <= tr[0].t || t > tr[tr.length - 1].t) return null;
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].t >= t) { const a = tr[i - 1], b = tr[i], k = (t - a.t) / (b.t - a.t || 1); return { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }; }
    }
    return null;
  }
  function drawPlan(c, v) {
    const r = plan.res, pts = r.track.map((q) => v.px(q.lat, q.lon));
    c.save(); c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 6; c.stroke();
    c.setLineDash([10, 7]); c.strokeStyle = '#ff8f00'; c.lineWidth = 3; c.stroke(); c.setLineDash([]);
    // Tacks and gybes: a small ring where the boat turns
    for (const q of r.track) {
      if (!q.turn) continue;
      const [x, y] = v.px(q.lat, q.lon);
      c.beginPath(); c.arc(x, y, 4, 0, 7); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 2; c.strokeStyle = q.turn === 'tack' ? '#ff8f00' : '#00838f'; c.stroke();
    }
    // Estimated time at each waypoint
    c.font = '600 12px sans-serif'; c.textAlign = 'left';
    const wpTimes = [{ t: r.dep }].concat(r.legs.map((g) => ({ t: g.end })));
    const route = ud.routes.find((x) => x.id === plan.route), wps = route ? routeWps(route) : [];
    wps.forEach((p, i) => {
      if (!wpTimes[i]) return;
      const [x, y] = v.px(p.lat, p.lon), s = fmtHM(wpTimes[i].t);
      c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.95)'; c.strokeText(s, x + 13, y + 16); c.fillStyle = '#b35c00'; c.fillText(s, x + 13, y + 16);
    });
    const at = planPos(r, mx.time);
    if (at) { const [x, y] = v.px(at.lat, at.lon); c.fillStyle = '#ff8f00'; c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.arc(x, y, 8, 0, 7); c.fill(); c.stroke(); }
    c.restore();
  }

  // ---------- planning pane, a fourth tab next to Waypoints, Routes and Track ----------
  const seg = $('segWp').parentNode, segBtn = document.createElement('button');
  segBtn.id = 'segPlan'; seg.appendChild(segBtn);
  const pane = document.createElement('div');
  pane.id = 'planPane'; pane.style.display = 'none';
  $('rtPane').parentNode.appendChild(pane);
  const pageSeg = window.showSeg;
  window.showSeg = function (s) { segBtn.classList.remove('on'); pane.style.display = 'none'; pageSeg(s); };
  segBtn.onclick = () => {
    ['segWp', 'segRt', 'segTrk'].forEach((id) => $(id).classList.remove('on'));
    ['wpPane', 'rtPane', 'trkPane'].forEach((id) => { $(id).style.display = 'none'; });
    segBtn.classList.add('on'); pane.style.display = ''; renderPlan();
  };

  const localInput = (t) => { const d = new Date(t * 1000 - new Date(t * 1000).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  let planMsg = '', planBusy = false;

  function renderPlan() {
    const routes = ud.routes.filter((r) => routeWps(r).length >= 2);
    if (!routes.find((r) => r.id === plan.route)) plan.route = routes.length ? routes[0].id : null;
    if (!plan.dep || plan.dep < nowHour() - 6 * H) plan.dep = nowHour() + H;
    let h = '<div class="card"><div class="title">' + L('Pianifica la traversata', 'Plan the passage') + '</div>';
    if (!routes.length) {
      h += '<div class="sub">' + L('Prima crea una rotta con almeno due waypoint, nella scheda Rotte. Per i waypoint: tocco lungo sulla carta.',
        'First make a route with at least two waypoints, in the Routes tab. For waypoints: long press on the chart.') + '</div></div>';
      pane.innerHTML = h; return;
    }
    h += '<label>' + L('Rotta', 'Route') + '</label><select id="plRoute">' + routes.map((r) => '<option value="' + r.id + '"' + (r.id === plan.route ? ' selected' : '') + '>' + esc(r.name) + ' (' + fmtNm(pathNm(routeWps(r))) + ' NM)</option>').join('') + '</select>' +
      '<label>' + L('Partenza', 'Departure') + '</label><input type="datetime-local" id="plDep" value="' + localInput(plan.dep) + '">' +
      '<label>' + L('Velocità media sull\'acqua (nodi)', 'Average speed through the water (knots)') + '</label><input type="text" inputmode="decimal" id="plStw" value="' + String(plan.stw).replace('.', isIt() ? ',' : '.') + '">' +
      '<div class="check"><input type="checkbox" id="plSail"' + (plan.sail ? ' checked' : '') + '><span>' + L('A vela: simula i bordi', 'Under sail: simulate tacking') + '</span></div>' +
      '<div id="plSailBox" style="display:' + (plan.sail ? '' : 'none') + '">' +
      '<label>' + L('Angolo di bolina dal vento (gradi)', 'Beating angle to the wind (degrees)') + '</label><input type="text" inputmode="numeric" id="plBeat" value="' + plan.beat + '">' +
      '<label>' + L('Allontanamento massimo dalla rotta diretta (miglia, 0 = nessun limite)', 'Furthest off the direct line (miles, 0 = no limit)') + '</label><input type="text" inputmode="decimal" id="plCorr" value="' + String(plan.corr).replace('.', isIt() ? ',' : '.') + '">' +
      '<div class="hint">' + L("Col vento in prua la barca bordeggia: vira quando può arrivare al waypoint sull'altro bordo o quando si allontana troppo dalla rotta. Con vento in poppa piena stramba. La velocità media è quella al traverso: di bolina e in poppa conta un po' meno; sotto i 5 nodi di vento va a motore.",
        'With the wind on the nose the boat tacks: when it can fetch the waypoint on the other tack, or when it gets too far off the route. Dead downwind it gybes. The average speed is the one on a reach: close-hauled and running it is a little less; under 5 knots of wind it motors.') + '</div></div>' +
      '<div class="btns"><button class="btn" id="plGo">' + L('Calcola', 'Compute') + '</button></div>' +
      '<div class="hint">' + (planBusy ? L('Scarico le previsioni...', 'Downloading the forecast...') : planMsg ||
        L('Vento, corrente e onde da Open-Meteo lungo la rotta. La corrente cambia la velocità sul fondo e quindi gli orari.', 'Wind, current and waves from Open-Meteo along the route. The current changes the speed over ground, and so the times.')) + '</div></div>';
    h += '<div id="plOut"></div>';
    pane.innerHTML = h;
    $('plRoute').onchange = (e) => { plan.route = +e.target.value; plan.res = null; savePlan(); renderPlan(); };
    $('plDep').onchange = (e) => { const d = new Date(e.target.value); if (!isNaN(d)) { plan.dep = Math.round(d.getTime() / 1000); savePlan(); if (plan.res) compute(false); } };
    $('plStw').onchange = (e) => { const v = parseFloat(e.target.value.replace(',', '.')); if (v > 0 && v < 40) { plan.stw = v; savePlan(); if (plan.res) compute(false); } };
    $('plSail').onchange = (e) => { plan.sail = e.target.checked; $('plSailBox').style.display = plan.sail ? '' : 'none'; savePlan(); if (plan.res) compute(false); };
    $('plBeat').onchange = (e) => { const v = parseFloat(e.target.value.replace(',', '.')); if (v >= 25 && v <= 80) { plan.beat = v; savePlan(); if (plan.res) compute(false); } else e.target.value = plan.beat; };
    $('plCorr').onchange = (e) => { const v = parseFloat(e.target.value.replace(',', '.')); if (v >= 0 && v <= 50) { plan.corr = v; savePlan(); if (plan.res) compute(false); } else e.target.value = plan.corr; };
    $('plGo').onclick = () => compute(true);
    renderResult();
  }
  function savePlan() { save('np-plan', { route: plan.route, dep: plan.dep, stw: plan.stw, sail: plan.sail, beat: plan.beat, corr: plan.corr }); }

  function compute(download) {
    const r = ud.routes.find((x) => x.id === plan.route);
    if (!r) return;
    const pts = routeWps(r), key = routeKey(pts);
    const dep = $('plDep') ? new Date($('plDep').value) : null;
    if (dep && !isNaN(dep)) plan.dep = Math.round(dep.getTime() / 1000);
    const sv = $('plStw') ? parseFloat($('plStw').value.replace(',', '.')) : plan.stw;
    if (sv > 0 && sv < 40) plan.stw = sv;
    savePlan();
    const have = planData && planData.key === key;
    const run = () => {
      plan.name = r.name;
      const o = { stw: plan.stw, sail: plan.sail, beat: plan.beat, corr: plan.corr };
      plan.res = simulate(planData, pts, plan.dep, o);
      plan.alts = [0, 3, 6, 12, 24, 48].map((x) => simulate(planData, pts, plan.dep + x * H, o)).map((x, i) => Object.assign(x, { off: [0, 3, 6, 12, 24, 48][i] }));
      renderResult(); renderBar(); drawMap();
    };
    // A forecast less than three hours old for this same route is used again without downloading
    if (have && (!download || Date.now() - planData.at < 3 * H * 1000)) { planMsg = L('Previsioni del ', 'Forecast of ') + fmtAge(planData.at); run(); renderPlan(); return; }
    if (!download && !have) return;
    planBusy = true; renderPlan();
    const samples = samplesOf(pts);
    forecast(samples, 7).then((d) => {
      planData = Object.assign(d, { key, samples: samples.map((s) => ({ lat: s.lat, lon: s.lon, leg: s.leg })) });
      save('np-plan-data', planData);
      planBusy = false; planMsg = L('Previsioni del ', 'Forecast of ') + fmtAge(planData.at); run(); renderPlan();
    }, (e) => {
      planBusy = false;
      planMsg = have ? L('Senza internet: uso le previsioni del ', 'No internet: using the forecast of ') + fmtAge(planData.at)
        : L('Previsioni non scaricate: serve internet (WiFi con internet o dati mobili).', 'Forecast not downloaded: internet needed (WiFi with internet or mobile data).');
      console.warn('meteo', e);
      if (have) run();
      renderPlan();
    });
  }

  function renderResult() {
    const out = $('plOut'), r = plan.res;
    if (!out || !r || plan.name !== (ud.routes.find((x) => x.id === plan.route) || {}).name) { if (out) out.innerHTML = ''; return; }
    const lv = (g) => (g.level ? ' w' + g.level : '');
    let h = '<div class="card' + lv(r) + '"><div class="title">' + esc(plan.name) + '</div>' +
      '<div class="kv" style="margin-top:8px"><span>' + L('Distanza', 'Distance') + '</span><span>' + fmtNm(r.nm) + ' NM</span>' +
      '<span>' + L('Partenza', 'Departure') + '</span><span>' + esc(fmtWhen(r.dep)) + '</span>' +
      '<span>' + L('Arrivo stimato', 'Estimated arrival') + '</span><span><b>' + esc(fmtWhen(r.end)) + '</b></span>' +
      (plan.sail && (r.tacks || r.gybes) ? '<span>' + L('Percorse', 'Sailed') + '</span><span>' + fmtNm(r.sailed) + ' NM' +
        (r.tacks ? ', ' + r.tacks + ' ' + L(r.tacks === 1 ? 'virata' : 'virate', r.tacks === 1 ? 'tack' : 'tacks') : '') +
        (r.gybes ? ', ' + r.gybes + ' ' + L(r.gybes === 1 ? 'strambata' : 'strambate', r.gybes === 1 ? 'gybe' : 'gybes') : '') + '</span>' : '') +
      '<span>' + L('Durata', 'Time') + '</span><span>' + fmtDur(r.end - r.dep) + '</span>' +
      '<span>' + L('Vento massimo', 'Strongest wind') + '</span><span>' + r.maxWs.toFixed(0) + ' kn, ' + L('raffiche ', 'gusts ') + r.maxG.toFixed(0) + ' kn</span></div>' +
      '<div class="btns"><button class="btn" id="plMap">' + L('Mostra sulla carta', 'Show on the chart') + '</button>' +
      '<button class="btn sec" id="plFollow">' + (ud.route === plan.route ? L('Rotta già seguita', 'Route being followed') : L('Segui la rotta', 'Follow the route')) + '</button></div></div>';
    r.legs.forEach((g, i) => {
      const m = g.mid;
      h += '<div class="card' + lv(g) + '"><div class="title">' + (i + 1) + '. ' + esc(g.from) + ' &rarr; ' + esc(g.to) + '</div>' +
        '<div class="sub">' + fmtNm(g.nm) + ' NM &middot; ' + L('rotta ', 'course ') + pad3(g.brg) + '&deg; &middot; ' + esc(fmtHM(g.start)) + ' &rarr; ' + esc(fmtHM(g.end)) + '</div>' +
        (m ? '<div class="sub">' + L('Vento ', 'Wind ') + m.ws.toFixed(0) + ' kn ' + L('da ', 'from ') + card8(m.from) + ' (' + pad3(m.from) + '&deg;)' +
          (m.g != null ? ', ' + L('raffiche ', 'gusts ') + m.g.toFixed(0) : '') + ' &middot; ' + pointOfSail(m.twa) +
          (g.maxWs > m.ws + 3 ? ' &middot; ' + L('fino a ', 'up to ') + g.maxWs.toFixed(0) + ' kn' : '') + '</div>' : '') +
        (Math.abs(g.along) >= 0.1 ? '<div class="sub">' + L('Corrente ', 'Current ') + Math.abs(g.along).toFixed(1) + ' kn ' + (g.along > 0 ? L('a favore', 'with you') : L('contro', 'against')) + '</div>' : '') +
        (g.maxWh ? '<div class="sub">' + L('Onda fino a ', 'Waves up to ') + g.maxWh.toFixed(1) + ' m</div>' : '') +
        g.info.map((x) => '<div class="sub">' + x + '</div>').join('') +
        g.warn.map((w) => '<div class="plWarn w' + w[0] + '">&#9888; ' + esc(w[1]) + '</div>').join('') + '</div>';
    });
    if (plan.alts) {
      h += '<div class="card"><div class="title">' + L('Altri orari di partenza', 'Other departure times') + '</div>' +
        plan.alts.map((a) => '<button class="plAlt' + (a.off === 0 ? ' on' : '') + '" data-off="' + a.off + '"><span>' + (a.off ? '+' + a.off + ' h &middot; ' : '') + esc(fmtWhen(a.dep)) + ' &rarr; ' + esc(fmtHM(a.end)) +
          '<br>' + L('vento max ', 'max wind ') + a.maxWs.toFixed(0) + ' kn, ' + L('raffiche ', 'gusts ') + a.maxG.toFixed(0) + ' &middot; ' + fmtDur(a.end - a.dep) + '</span>' +
          (a.level ? '<b class="w' + a.level + '">&#9888;</b>' : '') + '</button>').join('') +
        '<div class="hint">' + L('Tocca un orario per sceglierlo come partenza.', 'Tap a time to make it the departure.') + '</div></div>';
    }
    out.innerHTML = h;
    $('plMap').onclick = showPlanOnMap;
    $('plFollow').onclick = () => { if (ud.route !== plan.route) rtFollow(plan.route); renderResult(); };
    out.querySelectorAll('.plAlt').forEach((b) => { b.onclick = () => { const o = +b.dataset.off; if (!o) return; plan.dep += o * H; savePlan(); renderPlan(); compute(false); }; });
  }

  // The chart framed on the route, the wind at departure time, the boat moving along the plan with the time bar
  function showPlanOnMap() {
    const r = plan.res, tr = r.track;
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const q of tr) { la0 = Math.min(la0, q.lat); la1 = Math.max(la1, q.lat); lo0 = Math.min(lo0, q.lon); lo1 = Math.max(lo1, q.lon); }
    plan.show = true;
    showPage('pMap');
    const cv = $('map'), w = cv.clientWidth || 360, h = cv.clientHeight || 600;
    let z = 16;
    while (z > 4 && (lonToX(lo1, z) - lonToX(lo0, z) > w * 0.8 || latToY(la0, z) - latToY(la1, z) > h * 0.6)) z--;
    setFollow(false);
    map.lat = (la0 + la1) / 2; map.lon = (lo0 + lo1) / 2;
    mx.time = Math.round(r.dep / H) * H;
    if (!mx.layer) mx.layer = mx.last;
    setZoom(z);
    clampTime(); renderBar();
    ensureGrid(!coversView());
  }

  // Texts follow the page language
  const pageLang = window.applyLang;
  window.applyLang = function () { pageLang.apply(this, arguments); segBtn.textContent = L('Pianifica', 'Plan'); renderBar(); if (pane.style.display !== 'none') renderPlan(); };
  segBtn.textContent = L('Pianifica', 'Plan');
  renderBar();
})();
