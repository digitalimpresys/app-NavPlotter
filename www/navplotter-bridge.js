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
      url: base + url, method, headers, data, dataType: 'text', responseType: 'text',
      connectTimeout: 3000, readTimeout: 5000
    }).then((r) => {
      let d = r.data;
      if (d != null && typeof d !== 'string') d = JSON.stringify(d);
      return new Response(r.status === 204 ? null : d, { status: r.status, headers: r.headers });
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
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() { return srcDesc.get.call(this); },
    set(v) { srcDesc.set.call(this, nodePath(v) ? base + v : v); },
    configurable: true, enumerable: true
  });

  // ---------- native watch service (alarm and messages with the screen off) ----------
  function startWatch() {
    plugin('NodeWatch', 'start', { url: base }).catch((e) => console.warn('NodeWatch', e));
  }
  // The silence button on the alarm banner also silences the phone's own alarm
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'mute') setTimeout(() => plugin('NodeWatch', 'mute', {}).catch(() => {}), 0);
  }, true);
  // While the app is on screen, the page shows the alarm; the service plays it anyway, so the page's beep is
  // left as it is (it only plays when the page has been touched once).

  // The GPX link cannot download inside the app: it opens in the browser, which saves the file
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href^="/api/"]');
    if (!a) return;
    ev.preventDefault();
    plugin('NodeWatch', 'shareFromNode', { url: base + a.getAttribute('href') }).catch(() => {});
  }, true);

  // ---------- "App" card at the end of Setup: node address and service state ----------
  function addSetupCard() {
    const wrap = document.querySelector('#pSetup .wrap');
    if (!wrap || document.getElementById('appCard')) return;
    const it = (document.documentElement.lang || '').startsWith('it') || (navigator.language || '').startsWith('it');
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'appCard';
    card.innerHTML = '<div class="title">' + (it ? 'App' : 'App') + '</div>' +
      '<label>' + (it ? 'Indirizzo del nodo' : 'Node address') + '</label>' +
      '<input type="text" id="appNode" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="hint">' + (it ? 'Di solito http://192.168.4.1 (WiFi del nodo). Con il nodo sulla WiFi di bordo, l\'indirizzo che mostra il nodo.'
        : 'Usually http://192.168.4.1 (the node\'s WiFi). With the node on the boat WiFi, the address the node shows.') + '</div>' +
      '<div class="btns"><button class="btn" id="appNodeSave">' + (it ? 'Salva' : 'Save') + '</button>' +
      '<button class="btn sec" id="appBattery">' + (it ? 'Non ottimizzare la batteria' : 'Ignore battery optimisation') + '</button>' +
      '<button class="btn sec" id="appStop">' + (it ? 'Ferma la guardia' : 'Stop watching') + '</button></div>' +
      '<div class="hint">' + (it ? 'La guardia resta attiva a schermo spento e suona l\'allarme di abbordo e i messaggi. Si ferma dalla notifica o da qui.'
        : 'The watch keeps running with the screen off and sounds the collision alarm and messages. Stop it from the notification or here.') + '</div>';
    wrap.appendChild(card);
    document.getElementById('appNode').value = base;
    document.getElementById('appNodeSave').onclick = () => { window.NavPlotterApp.setNode(document.getElementById('appNode').value); location.reload(); };
    document.getElementById('appBattery').onclick = () => plugin('NodeWatch', 'ignoreBatteryOptimizations', {}).catch(() => {});
    document.getElementById('appStop').onclick = () => plugin('NodeWatch', 'stop', {}).catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => { addSetupCard(); startWatch(); });
})();
