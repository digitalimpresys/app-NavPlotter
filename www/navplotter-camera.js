// NavPlotter app: the camera page of the Raspberry Pi node (Navplotter-Linux, service navplotter-camera).
// Loaded after the page script (see scripts/sync-web.mjs). It asks the node for /camera/status: only a node with a
// camera answers, and only then the Camera tab appears. The video is the node's MJPEG (/camera/stream.mjpg), with
// the boxes of the objects recognised by the Hailo AI HAT already drawn on it; it is asked for only while the
// page is shown. The bridge sends /camera/... to the node, as it does with /api/... and /tiles/...
(function () {
  'use strict';
  if (typeof showPage !== 'function') return;

  const isIt = () => (typeof lang === 'string' ? lang : document.documentElement.lang || '').startsWith('it');
  const L = (i, e) => (isIt() ? i : e);
  const escH = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (id) => document.getElementById(id);

  const css = document.createElement('style');
  css.textContent = `
#pCam .wrap{max-width:none}
#camBox{position:relative;background:#000;border-radius:10px;overflow:hidden;min-height:120px}
#camImg{display:block;width:100%;max-height:calc(100vh - 230px);object-fit:contain;margin:0 auto}
#camBox:fullscreen #camImg,#camBox:-webkit-full-screen #camImg{max-height:100vh;height:100vh}
#camMsg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9fb3c8;font-size:14px;text-align:center;padding:12px}
#camObjs .obj{display:inline-block;margin:6px 6px 0 0;padding:4px 9px;border-radius:12px;background:var(--panel);border:1px solid var(--line);font-size:14px}
#camObjs .obj.imp{background:var(--red);color:#fff;border-color:var(--red)}
#pCam .btn.sec.on{background:var(--accent);color:#04121f;border-color:var(--accent)}`;
  document.head.appendChild(css);

  const page = document.createElement('section');
  page.className = 'page';
  page.id = 'pCam';
  page.innerHTML = '<div class="wrap"><h2 id="camTitle"></h2>' +
    '<div id="camBox"><img id="camImg" alt=""><div id="camMsg"></div></div><div id="camObjs"></div>' +
    '<div class="btns" style="margin-top:12px"><button class="btn sec" id="camNight"></button>' +
    '<button class="btn sec" id="camDetect"></button><button class="btn sec" id="camFull"></button></div>' +
    '<p class="hint" id="camInfo"></p></div>';
  document.querySelector('main').appendChild(page);

  const btn = document.createElement('button');
  btn.dataset.p = 'pCam';
  btn.id = 'navCam';
  btn.style.display = 'none';
  btn.innerHTML = '<i>&#9673;</i><span id="navCamLabel"></span>';
  const setupBtn = document.querySelector('#nav button[data-p="pSetup"]');
  setupBtn.parentNode.insertBefore(btn, setupBtn);
  btn.onclick = () => showPage('pCam');

  let cam = null, timer = null;
  const shown = () => page.classList.contains('on');
  const img = el('camImg');

  function status() {
    return fetch('/camera/status').then((r) => (r.ok ? r.json() : null)).then((j) => j, () => null)
      .then((j) => { cam = j; btn.style.display = j ? '' : 'none'; render(); return j; });
  }
  function startVideo(j) {
    if (shown() && j && j.ok && !img.getAttribute('src')) img.src = '/camera/stream.mjpg?' + Date.now();
  }
  function onPage(on) {
    clearInterval(timer); timer = null;
    if (!on) { img.removeAttribute('src'); return; }   // no video while the page is not shown
    status().then(startVideo);
    timer = setInterval(() => status().then(startVideo), 1000);
  }
  function render() {
    el('camTitle').textContent = L('Telecamera', 'Camera');
    el('navCamLabel').textContent = L('Telecamera', 'Camera');
    el('camNight').textContent = L('Vista notturna', 'Night view');
    el('camDetect').textContent = L('Riconoscimento', 'Recognition');
    el('camFull').textContent = L('Schermo intero', 'Full screen');
    if (!shown()) return;
    const c = cam;
    el('camMsg').textContent = !c ? L('Telecamera non trovata', 'Camera not found')
      : !c.ok ? (c.error && c.error !== 'starting' ? L('Telecamera non trovata', 'Camera not found') + ' (' + c.error + ')' : L('Avvio della telecamera...', 'Starting the camera...')) : '';
    el('camMsg').style.display = c && c.ok ? 'none' : 'flex';
    if (!c || !c.ok) img.removeAttribute('src');
    el('camNight').classList.toggle('on', !!(c && c.night));
    el('camDetect').classList.toggle('on', !!(c && c.detect && c.detector));
    el('camDetect').style.display = c && c.detector ? '' : 'none';
    const objs = c && c.ok && c.detector && c.detect ? c.objects : [];
    const html = objs.length
      ? objs.map((o) => '<span class="obj' + (o.important ? ' imp' : '') + '">' + escH(isIt() ? o.name : o.label) + ' ' + Math.round(o.score * 100) + '%</span>').join('')
      : (c && c.ok && c.detector && c.detect ? '<p class="hint">' + L('Nessun oggetto riconosciuto', 'Nothing recognised') + '</p>' : '');
    if (el('camObjs')._html !== html) { el('camObjs').innerHTML = html; el('camObjs')._html = html; }
    el('camInfo').textContent = !c ? '' : [c.fps ? c.fps + ' fps' : '',
      c.detector ? 'Hailo ' + c.detector : L('Riconoscimento non disponibile', 'Recognition not available') + (c.detectorError ? ': ' + c.detectorError : '')].filter(Boolean).join(' · ');
  }
  function set(k) {
    fetch('/camera/settings', { method: 'POST', body: new URLSearchParams({ [k]: cam && cam[k] ? '0' : '1' }) })
      .then((r) => r.json()).then((j) => { cam = j; render(); }).catch(() => {});
  }
  function full() {
    const box = el('camBox'), fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (box.requestFullscreen || box.webkitRequestFullscreen || (() => {})).call(box);
  }
  el('camNight').onclick = () => set('night');
  el('camDetect').onclick = () => set('detect');
  el('camFull').onclick = full;
  img.ondblclick = full;

  const pageShow = showPage;
  window.showPage = function (id) { pageShow(id); onPage(id === 'pCam'); };

  render();
  // The node can be changed from the app card, and a camera can be plugged in later: asked again now and then
  status();
  setInterval(() => { if (!shown()) status(); }, 30000);
})();
