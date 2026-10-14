// NavPlotter app bridge.
// Loaded before the node's web app (see scripts/sync-web.mjs). The web app is written to be served by the node
// itself, so it asks for /api/... and /tiles/... on its own origin. Inside the app the page comes from the phone,
// so here those addresses are sent to the node (http://192.168.4.1 unless changed), through Capacitor's native
// HTTP so the node needs no CORS headers. The bridge also starts the native watch service that sounds the
// collision alarm and the message alert with the screen off.
(function () {
  'use strict';
  const cap = window.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const DEFAULT_NODE = 'http://192.168.4.1';
  let base = DEFAULT_NODE;
  try { base = localStorage.getItem('np-node') || DEFAULT_NODE; } catch (e) {}
  const nodePath = (u) => typeof u === 'string' && (u.startsWith('/api/') || u.startsWith('/tiles/'));

  window.NavPlotterApp = {
    native,
    get node() { return base; },
    setNode(url) {
      url = (url || '').trim().replace(/\/+$/, '');
      if (!url) url = DEFAULT_NODE;
      if (!/^https?:\/\//.test(url)) url = 'http://' + url;
      base = url;
      try { localStorage.setItem('np-node', url); } catch (e) {}
      startWatch();
    }
  };
  if (!native) return; // in a normal browser the page is served by the node: nothing to do

  const plugin = (name, method, opts) => cap.nativePromise(name, method, opts || {});

  // A node on the boat WiFi is set as <name>.local, which Android does not always resolve: once the node has
  // answered and given its address on the boat WiFi, that address is used instead
  let nodeIp = null, failures = 0;
  const target = () => nodeIp || base;
  const isLocal = () => /^https?:\/\/[^/:]+\.local(:|\/|$)/.test(base);

  // ---------- pairing: the app follows one node by its id, whatever its name or address ----------
  // The first node the app talks to is paired. When it stops answering, or another node answers at the same
  // address, the app looks for the paired one: on its own WiFi (192.168.4.1), at its last address on the boat
  // WiFi, and among the nodes announced on the network (mDNS, by id).
  const store = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  const load = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  let paired = { id: load('np-pair-id'), name: load('np-pair-name') };
  let otherNode = null, lastSearch = 0, searching = false;

  function pair(id, name) {
    paired = { id, name };
    store('np-pair-id', id); store('np-pair-name', name);
    otherNode = null;
    renderAppCard();
  }
  function useNode(url) {
    if (url === base) return;
    base = url; nodeIp = null; failures = 0;
    store('np-node', url);
    startWatch();
    renderAppCard();
  }
  const http = (url, ms) => plugin('CapacitorHttp', 'request', { url, method: 'GET', responseType: 'json', connectTimeout: ms, readTimeout: ms })
    .then((r) => { let d = r.data; if (typeof d === 'string') d = JSON.parse(d); return d; });
  const idAt = (url) => http(url + '/api/config', 2500).then((c) => (c && c.id) || null, () => null);

  function findPaired(manual) {
    if (!paired.id || searching || (!manual && Date.now() - lastSearch < 20000)) return Promise.resolve(false);
    searching = true; lastSearch = Date.now(); renderAppCard();
    const tried = new Set();
    const check = (url) => {
      if (!url || tried.has(url)) return Promise.resolve(false);
      tried.add(url);
      return idAt(url).then((id) => { if (id !== paired.id) return false; useNode(url); return true; });
    };
    const lastSta = load('np-pair-sta');
    return check(base)
      .then((ok) => ok || check(DEFAULT_NODE))
      .then((ok) => ok || check(lastSta))
      .then((ok) => ok || plugin('NodeWatch', 'discover', { timeout: 3000 }).then((r) => {
        const nodes = (r && r.nodes) || [];
        const hit = nodes.find((n) => n.id === paired.id) || null;
        return hit ? check('http://' + hit.host + (hit.port && hit.port !== 80 ? ':' + hit.port : '')) : false;
      }, () => false))
      .then((ok) => { searching = false; renderAppCard(); return ok; });
  }

  // ---------- fetch to the node through native HTTP ----------
  const webFetch = window.fetch.bind(window);
  window.fetch = function (resource, options) {
    const url = typeof resource === 'string' ? resource : null;
    if (!nodePath(url)) return webFetch(resource, options);
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, options.headers || {});
    let data;
    const body = options.body;
    if (body instanceof URLSearchParams) {
      data = body.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body != null) {
      data = String(body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain';
    }
    const req = plugin('CapacitorHttp', 'request', {
      url: target() + url, method, headers, data, dataType: 'text', responseType: 'text',
      connectTimeout: 3000, readTimeout: 5000
    }).then((r) => {
      let d = r.data;
      if (url === '/api/state' && r.status === 200) {
        let o = d;
        if (typeof o === 'string') try { o = JSON.parse(o); } catch (e) { o = null; }
        failures = 0;
        nodeIp = o && isLocal() && o.sta && o.staIp ? 'http://' + o.staIp : null;
        if (o && o.sta && o.staIp && !otherNode) store('np-pair-sta', 'http://' + o.staIp);
      }
      if (url === '/api/config' && r.status === 200) {
        let o = d;
        if (typeof o === 'string') try { o = JSON.parse(o); } catch (e) { o = null; }
        if (o && o.id) {
          if (!paired.id) pair(o.id, o.name || '');
          else if (o.id === paired.id) { otherNode = null; if (o.name && o.name !== paired.name) pair(o.id, o.name); }
          else { otherNode = { id: o.id, name: o.name || '' }; findPaired(false); }
          renderAppCard();
        }
      }
      if (d != null && typeof d !== 'string') d = JSON.stringify(d);
      return new Response(r.status === 204 ? null : d, { status: r.status, headers: r.headers });
    }, (e) => {
      if (url === '/api/state' && ++failures >= 3) { nodeIp = null; findPaired(false); } // the address may have changed
      throw e;
    });
    const signal = options.signal;
    if (!signal) return req;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      req.then(resolve, reject);
    });
  };

  // ---------- chart tiles: <img>/Image() with /tiles/... go to the node ----------
  // The page never asks again for a tile that failed, and a tile can fail while the app is being bound to the
  // node's WiFi (Android drops the requests in flight). So a failed tile is asked again a few times, unless the
  // node says it does not have it (open sea has no tiles).
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  function retryTile() {
    const img = this, url = img._npUrl, n = (img._npTries || 0) + 1;
    if (n > 5 || !url) return;
    img._npTries = n;
    const again = () => setTimeout(() => { if (img._npUrl === url) srcDesc.set.call(img, url + '?r=' + n); }, 1000 * n);
    plugin('CapacitorHttp', 'request', { url, method: 'HEAD', connectTimeout: 3000, readTimeout: 3000 })
      .then((r) => { if (r.status !== 404) again(); }, again);
  }
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() { return srcDesc.get.call(this); },
    set(v) {
      if (!nodePath(v)) { this._npUrl = null; return srcDesc.set.call(this, v); }
      this._npUrl = target() + v; this._npTries = 0;
      if (!this._npRetry) { this._npRetry = true; this.addEventListener('error', retryTile); }
      srcDesc.set.call(this, this._npUrl);
    },
    configurable: true, enumerable: true
  });

  // ---------- native watch service (alarm and messages with the screen off) ----------
  let watching = false;
  function startWatch() {
    plugin('NodeWatch', 'start', { url: base }).then(() => { watching = true; }, (e) => console.warn('NodeWatch', e));
  }
  // The silence button on the alarm banner also silences the phone's own alarm
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'mute') setTimeout(() => plugin('NodeWatch', 'mute', {}).catch(() => {}), 0);
  }, true);
  // While the watch runs, the phone's alarm and the message notification are the sound: the page's own beeps
  // for the collision alarm (3) and for messages (2) would only add to them. The test button and the
  // waypoint-reached beep (1) still play.
  let testing = false;
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'testSound') { testing = true; setTimeout(() => { testing = false; }, 0); }
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const pageBeep = window.beep;
    if (typeof pageBeep !== 'function') return;
    window.beep = (n) => { if (!watching || testing || n === 1) pageBeep(n); };
  });

  // The GPX link cannot download inside the app: it opens in the browser, which saves the file
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href^="/api/"]');
    if (!a) return;
    ev.preventDefault();
    plugin('NodeWatch', 'shareFromNode', { url: target() + a.getAttribute('href') }).catch(() => {});
  }, true);

  // ---------- "App" card at the end of Setup: paired node, address, watch ----------
  const it = () => (window.lang || document.documentElement.lang || navigator.language || '').startsWith('it');
  const T = (i, e) => (it() ? i : e);
  const escH = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function addSetupCard() {
    const wrap = document.querySelector('#pSetup .wrap');
    if (!wrap || document.getElementById('appCard')) return;
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'appCard';
    wrap.appendChild(card);
    renderAppCard();
  }
  function renderAppCard() {
    const card = document.getElementById('appCard');
    if (!card) return;
    const editing = document.activeElement && document.activeElement.id === 'appNode';
    if (editing) return;
    const node = paired.id ? '<b>' + escH(paired.name || '?') + '</b> <span class="tag">ID ' + escH(paired.id) + '</span>' : T('nessuno', 'none');
    card.innerHTML = '<div class="title">App</div>' +
      '<div class="kv" style="margin-top:8px"><span>' + T('Nodo abbinato', 'Paired node') + '</span><span>' + node + '</span>' +
      '<span>' + T('Indirizzo', 'Address') + '</span><span>' + escH(target()) + (searching ? ' · ' + T('cerco...', 'searching...') : '') + '</span></div>' +
      (otherNode ? '<div class="hint" style="color:var(--red)">' + T('A questo indirizzo risponde ', 'This address answers as ') + '<b>' + escH(otherNode.name) + '</b> (ID ' + escH(otherNode.id) + T('), non il nodo abbinato.', '), not the paired node.') + '</div>' : '') +
      '<div class="btns"><button class="btn" id="appFind">' + T('Cerca il nodo abbinato', 'Find the paired node') + '</button>' +
      (otherNode ? '<button class="btn sec" id="appPairOther">' + T('Abbina ', 'Pair ') + escH(otherNode.name) + '</button>' : '') +
      (paired.id ? '<button class="btn sec" id="appForget">' + T('Dimentica il nodo', 'Forget the node') + '</button>' : '') + '</div>' +
      '<div class="hint">' + T("L'app segue il nodo abbinato col suo ID, anche se cambia nome o passa dalla sua WiFi a quella di bordo. Per abbinarne un altro collegati alla sua WiFi NavPlotter-… e tocca Abbina.",
        'The app follows the paired node by its ID, even when its name changes or it moves from its own WiFi to the boat WiFi. To pair another one, join its NavPlotter-… WiFi and tap Pair.') + '</div>' +
      '<details style="margin-top:10px"><summary class="hint">' + T('Indirizzo a mano', 'Address by hand') + '</summary>' +
      '<input type="text" id="appNode" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="margin-top:8px">' +
      '<div class="btns"><button class="btn sec" id="appNodeSave">' + T('Usa questo indirizzo', 'Use this address') + '</button></div></details>' +
      '<div class="btns"><button class="btn sec" id="appBattery">' + T('Non ottimizzare la batteria', 'Ignore battery optimisation') + '</button>' +
      '<button class="btn sec" id="appStop">' + T('Ferma la guardia', 'Stop watching') + '</button></div>' +
      '<div class="hint">' + T("La guardia resta attiva a schermo spento e suona l'allarme di abbordo e i messaggi. Si ferma dalla notifica o da qui.",
        'The watch keeps running with the screen off and sounds the collision alarm and messages. Stop it from the notification or here.') + '</div>';
    document.getElementById('appNode').value = base;
    document.getElementById('appFind').onclick = () => findPaired(true).then((ok) => { if (!ok) alert(T('Nodo abbinato non trovato. Il telefono è sulla sua WiFi o su quella di bordo?', 'Paired node not found. Is the phone on its WiFi or on the boat WiFi?')); });
    const fg = document.getElementById('appForget');
    if (fg) fg.onclick = () => {
      if (!confirm(T("Dimenticare il nodo abbinato? L'app si abbinerà al prossimo nodo a cui ti colleghi.", 'Forget the paired node? The app will pair with the next node you connect to.'))) return;
      ['np-pair-id', 'np-pair-name', 'np-pair-sta', 'np-node'].forEach((k) => store(k, null));
      location.reload();
    };
    const po = document.getElementById('appPairOther');
    if (po) po.onclick = () => { pair(otherNode.id, otherNode.name); location.reload(); };
    document.getElementById('appNodeSave').onclick = () => { window.NavPlotterApp.setNode(document.getElementById('appNode').value); location.reload(); };
    document.getElementById('appBattery').onclick = () => plugin('NodeWatch', 'ignoreBatteryOptimizations', {}).catch(() => {});
    document.getElementById('appStop').onclick = () => { watching = false; plugin('NodeWatch', 'stop', {}).catch(() => {}); };
  }

  // ---------- boat WiFi: what was typed once is offered to the next node ----------
  // Android does not let an app read the password of a saved WiFi, so it is typed once; the app remembers it
  // (on this phone only) and fills it in when another node is set up for the same boat.
  document.addEventListener('click', (ev) => {
    if (!ev.target || ev.target.id !== 'save') return;
    const ss = document.getElementById('fStaSsid'), pw = document.getElementById('fStaPass'), net = document.getElementById('fNet');
    if (net && net.value === '2' && ss && ss.value) { store('np-boat-ssid', ss.value); if (pw && pw.value) store('np-boat-pass', pw.value); }
  }, true);
  document.addEventListener('change', (ev) => {
    if (!ev.target || ev.target.id !== 'fNet' || ev.target.value !== '2') return;
    const ss = document.getElementById('fStaSsid'), pw = document.getElementById('fStaPass');
    const s1 = load('np-boat-ssid'), p1 = load('np-boat-pass');
    if (ss && !ss.value && s1) ss.value = s1;
    if (pw && !pw.value && p1 && ss && ss.value === s1) pw.value = p1;
  });

  document.addEventListener('DOMContentLoaded', () => { addSetupCard(); startWatch(); });
})();
