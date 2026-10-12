'use strict';

/* ============================================================
 * Ashiato — 行った場所の影が晴れていく地図
 * 位置は Q 度刻みのセル（約 11m）に丸めて Set で保持する。
 * ============================================================ */

const Q = 1e-4;                 // セルの大きさ（度）
const LON_SPAN = 3600001;       // キー = latIdx * LON_SPAN + lonIdx
const TILE = 256;
const EARTH_CIRC = 40075016.686;
const INTERP_MAX_DIST = 5000;   // これより離れた連続点は線で結ばない (m)
const INTERP_MAX_GAP = 10 * 60e3; // これより時間が空いた連続点も結ばない (ms)
const INTERP_STEP = 8;          // 補間の間隔 (m)
const GIST_FILE = 'ashiato.json';
const AUTOSYNC_INTERVAL = 10 * 60e3;

const LS = {
  cells: 'ashiato.cells',
  settings: 'ashiato.settings',
  lastFix: 'ashiato.lastFix',
  view: 'ashiato.view',
};

/* ---------- storage helpers ---------- */

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { console.error(e); toast('端末への保存に失敗しました'); return false; }
}

const settings = Object.assign({
  opacity: 0.78,
  radius: 40,
  minPx: 7,        // 縮小しても行った場所がわかるよう、画面上でこの半径(px)より小さくしない
  wakeLock: true,
  maxAccuracy: 100,
  token: '',
  gistId: '',
  autoSync: true,
  lastSync: 0,
}, lsGet(LS.settings, {}));
const saveSettings = () => lsSet(LS.settings, settings);

/* ---------- cell store + spatial index ---------- */

const cells = new Set();
const buckets = new Map(); // 1度区画ごとの [lat, lon, lat, lon, ...]

const bucketKey = (latDeg, lonDeg) => (latDeg + 90) * 400 + (lonDeg + 180);

function addKey(key) {
  if (cells.has(key)) return false;
  cells.add(key);
  const i = Math.round(key / LON_SPAN);
  const j = key - i * LON_SPAN;
  const lat = i * Q, lon = j * Q;
  const bk = bucketKey(Math.floor(lat), Math.floor(lon));
  let arr = buckets.get(bk);
  if (!arr) buckets.set(bk, arr = []);
  arr.push(lat, lon);
  return true;
}

function addLatLon(lat, lon) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return false;
  return addKey(Math.round(lat / Q) * LON_SPAN + Math.round(lon / Q));
}

function clearCells() {
  cells.clear();
  buckets.clear();
}

// ソートした差分を36進数で並べた文字列（コンパクトに保存・同期するため）
function encodeCells() {
  const keys = Array.from(cells).sort((a, b) => a - b);
  const out = new Array(keys.length);
  let prev = 0;
  for (let k = 0; k < keys.length; k++) {
    out[k] = (keys[k] - prev).toString(36);
    prev = keys[k];
  }
  return out.join(',');
}
function decodeCells(str) {
  const keys = [];
  if (!str) return keys;
  let acc = 0;
  for (const part of str.split(',')) {
    acc += parseInt(part, 36);
    keys.push(acc);
  }
  return keys;
}
const serialize = () => JSON.stringify({ app: 'ashiato', v: 1, q: Q, updated: Date.now(), cells: encodeCells() });

function mergeSerialized(text) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'ashiato' || data.q !== Q) throw new Error('形式が違います');
  const keys = decodeCells(data.cells);
  let added = 0;
  for (const k of keys) if (addKey(k)) added++;
  return { added, remoteCount: keys.length };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 2000);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { localStorage.setItem(LS.cells, encodeCells()); }
  catch (e) { console.error(e); toast('端末への保存に失敗しました（容量不足の可能性）'); }
}

/* ---------- geo math ---------- */

const toRad = d => d * Math.PI / 180;
function distance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const lonToX = (lon, world) => (lon + 180) / 360 * world;
function latToY(lat, world) {
  const s = Math.sin(toRad(Math.max(-85.0511, Math.min(85.0511, lat))));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
}
const xToLon = (x, world) => x / world * 360 - 180;
const yToLat = (y, world) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / world))) * 180 / Math.PI;

/* ---------- recording points / tracks ---------- */

// prev: {lat, lon, t} | null — 直前の点。近ければ間を補間して「通った道」も晴らす
function ingestPoint(prev, lat, lon, t) {
  let added = 0;
  const dt = prev ? t - prev.t : Infinity;
  if (prev && dt >= 0 && dt <= INTERP_MAX_GAP && Math.abs(lon - prev.lon) < 180) {
    const d = distance(prev.lat, prev.lon, lat, lon);
    if (d <= INTERP_MAX_DIST) {
      const steps = Math.max(1, Math.ceil(d / INTERP_STEP));
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        if (addLatLon(prev.lat + (lat - prev.lat) * f, prev.lon + (lon - prev.lon) * f)) added++;
      }
      return added;
    }
  }
  return addLatLon(lat, lon) ? 1 : 0;
}

/* ---------- fog layer ---------- */

// 縁をぼかした「消しゴム」スプライト
const brush = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
})();

function forEachPointIn(latMin, latMax, lonMin, lonMax, fn) {
  const a0 = Math.floor(Math.max(-90, latMin)), a1 = Math.floor(Math.min(89.9999, latMax));
  const o0 = Math.floor(Math.max(-180, lonMin)), o1 = Math.floor(Math.min(179.9999, lonMax));
  const visit = arr => {
    for (let k = 0; k < arr.length; k += 2) {
      const lat = arr[k], lon = arr[k + 1];
      if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) fn(lat, lon);
    }
  };
  if ((a1 - a0 + 1) * (o1 - o0 + 1) > buckets.size) {
    for (const arr of buckets.values()) visit(arr);
  } else {
    for (let a = a0; a <= a1; a++) for (let o = o0; o <= o1; o++) {
      const arr = buckets.get(bucketKey(a, o));
      if (arr) visit(arr);
    }
  }
}

function drawFogTile(canvas, coords) {
  const dpr = canvas._dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.fillStyle = `rgba(8, 10, 20, ${settings.opacity})`;
  ctx.fillRect(0, 0, TILE, TILE);

  const n = 2 ** coords.z;
  const world = TILE * n;
  const tx = ((coords.x % n) + n) % n;
  const ox = tx * TILE, oy = coords.y * TILE;
  const mpp = EARTH_CIRC / world; // 赤道での m/px
  const rOf = lat => Math.max(settings.minPx, settings.radius / (mpp * Math.cos(toRad(lat))));

  const latTop = yToLat(oy, world), latBot = yToLat(oy + TILE, world);
  const margin = rOf(Math.min(85, Math.max(Math.abs(latTop), Math.abs(latBot)))) + 1;
  const latMax = yToLat(oy - margin, world), latMin = yToLat(oy + TILE + margin, world);
  const lonMin = xToLon(ox - margin, world), lonMax = xToLon(ox + TILE + margin, world);

  ctx.globalCompositeOperation = 'destination-out';
  forEachPointIn(latMin, latMax, lonMin, lonMax, (lat, lon) => {
    const r = rOf(lat);
    ctx.drawImage(brush, lonToX(lon, world) - ox - r, latToY(lat, world) - oy - r, r * 2, r * 2);
  });
}

const FogLayer = L.GridLayer.extend({
  createTile(coords) {
    const c = L.DomUtil.create('canvas', 'fog-tile');
    c._dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.height = TILE * c._dpr;
    drawFogTile(c, coords);
    return c;
  },
  redrawAll() {
    for (const key in this._tiles) {
      const t = this._tiles[key];
      drawFogTile(t.el, t.coords);
    }
  },
});

/* ---------- map ---------- */

const savedView = lsGet(LS.view, null);
const map = L.map('map', {
  zoomControl: false,
  worldCopyJump: true,
  minZoom: 2,
  maxZoom: 19,
}).setView(savedView ? [savedView.lat, savedView.lng] : [35.68, 139.76], savedView ? savedView.zoom : 3);

L.control.zoom({ position: 'topleft' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

map.createPane('fog');
map.getPane('fog').style.zIndex = 350;
map.getPane('fog').style.pointerEvents = 'none';
const fog = new FogLayer({ pane: 'fog', tileSize: TILE, updateWhenZooming: false, keepBuffer: 2 }).addTo(map);

map.on('moveend', () => {
  const c = map.getCenter();
  lsSet(LS.view, { lat: c.lat, lng: c.wrap().lng, zoom: map.getZoom() });
});

let redrawTimer = null;
function scheduleRedraw() {
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => { redrawTimer = null; fog.redrawAll(); }, 500);
}

/* ---------- UI helpers ---------- */

const $ = id => document.getElementById(id);
let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const fmtTime = t => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function updateStatus() {
  const parts = [];
  if (tracking) parts.push('記録中');
  parts.push(`${cells.size.toLocaleString()} セル`);
  // 1セル ≈ 半径分の円が晴れるが、重なりが多いので「セル数」のまま出す
  if (settings.lastSync) parts.push(`同期 ${fmtTime(settings.lastSync)}`);
  $('stat-text').textContent = parts.join(' · ');
  $('rec-dot').classList.toggle('on', tracking);
}

function afterAdded(added) {
  if (!added) return;
  scheduleSave();
  scheduleRedraw();
  updateStatus();
}

/* ---------- tracking ---------- */

let tracking = false;
let watchId = null;
let follow = true;
let lastFix = lsGet(LS.lastFix, null);
let posMarker = null, accCircle = null;
let wakeLock = null;

function showPosition(lat, lon, acc) {
  const ll = [lat, lon];
  if (!posMarker) {
    accCircle = L.circle(ll, { radius: acc, color: '#5fb3ff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    posMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#5fb3ff', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    posMarker.setLatLng(ll);
    accCircle.setLatLng(ll).setRadius(acc);
  }
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  showPosition(lat, lon, accuracy);
  if (follow) map.panTo([lat, lon], { animate: true });
  if (!tracking || accuracy > settings.maxAccuracy) return;
  const t = pos.timestamp || Date.now();
  const added = ingestPoint(lastFix, lat, lon, t);
  lastFix = { lat, lon, t };
  lsSet(LS.lastFix, lastFix);
  afterAdded(added);
}

function onPosError(err) {
  const msg = {
    1: '位置情報の利用が許可されていません。ブラウザ/OSの設定で許可してください。',
    2: '位置情報を取得できません',
    3: '位置情報の取得がタイムアウトしました',
  }[err.code] || err.message;
  toast(msg, 5000);
  if (err.code === 1) stopTracking();
}

async function acquireWakeLock() {
  if (!settings.wakeLock || !tracking || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { console.warn('wakeLock', e); }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

function startWatch() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) { toast('この端末では位置情報が使えません'); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
    timeout: 30000,
  });
}
function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function startTracking() {
  tracking = true;
  lsSet('ashiato.tracking', true);
  follow = true;
  $('btn-locate').classList.add('follow');
  startWatch();
  acquireWakeLock();
  $('btn-rec').classList.add('on');
  updateStatus();
  toast('記録を開始しました');
}
function stopTracking() {
  tracking = false;
  lsSet('ashiato.tracking', false);
  stopWatch();
  releaseWakeLock();
  $('btn-rec').classList.remove('on');
  saveNow();
  updateStatus();
}

$('btn-rec').onclick = () => (tracking ? stopTracking() : startTracking());

$('btn-locate').onclick = () => {
  follow = true;
  $('btn-locate').classList.add('follow');
  if (posMarker) map.setView(posMarker.getLatLng(), Math.max(map.getZoom(), 15));
  if (watchId == null) {
    if (!('geolocation' in navigator)) return toast('この端末では位置情報が使えません');
    navigator.geolocation.getCurrentPosition(p => {
      showPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
      map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), 15));
    }, onPosError, { enableHighAccuracy: true, timeout: 20000 });
  }
};
map.on('dragstart', () => {
  follow = false;
  $('btn-locate').classList.remove('follow');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    acquireWakeLock();
    if (settings.autoSync) syncSafe(true);
  } else {
    saveNow();
    if (settings.autoSync && settings.token) syncSafe(true);
  }
});
window.addEventListener('pagehide', saveNow);

/* ---------- sync (GitHub Gist) ---------- */

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? '（トークンが無効です）'
      : res.status === 404 ? '（Gist が見つからないか、トークンに権限がありません）' : '';
    throw new Error(`GitHub ${res.status}${hint} ${body.slice(0, 120)}`);
  }
  return res.json();
}

let syncing = false;
async function sync() {
  if (!settings.token) throw new Error('GitHubトークンが未設定です');
  if (syncing) return null;
  syncing = true;
  try {
    let added = 0, uploaded = false;
    if (!settings.gistId) {
      const g = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({ description: 'Ashiato data', public: false, files: { [GIST_FILE]: { content: serialize() } } }),
      });
      settings.gistId = g.id;
      $('opt-gist').value = g.id;
      uploaded = true;
    } else {
      const g = await gh('/gists/' + encodeURIComponent(settings.gistId));
      const f = g.files && g.files[GIST_FILE];
      let remoteCount = 0;
      if (f) {
        const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
        const r = mergeSerialized(text);
        added = r.added;
        remoteCount = r.remoteCount;
      }
      // 和集合をとっているので、件数がリモートより多ければこちらにしかないセルがある
      if (cells.size > remoteCount) {
        await gh('/gists/' + encodeURIComponent(settings.gistId), {
          method: 'PATCH',
          body: JSON.stringify({ files: { [GIST_FILE]: { content: serialize() } } }),
        });
        uploaded = true;
      }
    }
    settings.lastSync = Date.now();
    saveSettings();
    if (added) { saveNow(); fog.redrawAll(); }
    updateStatus();
    return { added, uploaded };
  } finally {
    syncing = false;
  }
}

async function syncSafe(quiet) {
  if (!settings.token) return;
  try {
    const r = await sync();
    if (!r) return;
    const msg = `同期しました（取り込み ${r.added.toLocaleString()} セル${r.uploaded ? '・アップロード済み' : ''}）`;
    $('sync-msg').textContent = msg + ` — ${fmtTime(Date.now())}`;
    if (!quiet || r.added) toast(msg);
  } catch (e) {
    console.error(e);
    $('sync-msg').textContent = '同期エラー: ' + e.message;
    if (!quiet) toast('同期に失敗しました');
  }
}

setInterval(() => { if (settings.autoSync) syncSafe(true); }, AUTOSYNC_INTERVAL);

/* ---------- import / export ---------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX を読み込めません');
  let added = 0;
  const segs = [...doc.querySelectorAll('trkseg'), ...doc.querySelectorAll('rte')];
  const groups = segs.length ? segs.map(s => s.querySelectorAll('trkpt, rtept')) : [doc.querySelectorAll('wpt')];
  for (const pts of groups) {
    let prev = null;
    pts.forEach((p, idx) => {
      const lat = parseFloat(p.getAttribute('lat')), lon = parseFloat(p.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) return;
      const timeEl = p.querySelector('time');
      const t = timeEl ? Date.parse(timeEl.textContent) : idx * 1000;
      added += ingestPoint(prev, lat, lon, isFinite(t) ? t : idx * 1000);
      prev = { lat, lon, t: isFinite(t) ? t : idx * 1000 };
    });
  }
  return added;
}

$('btn-export').onclick = () => {
  saveNow();
  download(`ashiato-${new Date().toISOString().slice(0, 10)}.json`, serialize(), 'application/json');
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').onchange = async e => {
  let added = 0;
  for (const file of e.target.files) {
    try {
      const text = await file.text();
      added += /\.gpx$/i.test(file.name) || text.trimStart().startsWith('<') ? importGpx(text) : mergeSerialized(text).added;
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 5000);
    }
  }
  e.target.value = '';
  if (added) { saveNow(); fog.redrawAll(); updateStatus(); }
  toast(`${added.toLocaleString()} セルを取り込みました`);
};

$('btn-clear').onclick = () => {
  if (!confirm('この端末に保存された記録をすべて消去します。よろしいですか？\n（Gist 上のデータは消えないため、次の同期で戻ります）')) return;
  clearCells();
  lastFix = null;
  localStorage.removeItem(LS.lastFix);
  saveNow();
  fog.redrawAll();
  updateStatus();
  toast('消去しました');
};

/* ---------- settings panel ---------- */

function bindSettings() {
  const op = $('opt-opacity'), rad = $('opt-radius'), mp = $('opt-minpx'), wl = $('opt-wakelock'), acc = $('opt-accuracy');
  const tok = $('opt-token'), gist = $('opt-gist'), as = $('opt-autosync');
  op.value = settings.opacity;
  rad.value = settings.radius;
  mp.value = settings.minPx;
  wl.checked = settings.wakeLock;
  acc.value = settings.maxAccuracy;
  tok.value = settings.token;
  gist.value = settings.gistId;
  as.checked = settings.autoSync;

  op.oninput = () => { settings.opacity = +op.value; saveSettings(); scheduleRedraw(); };
  rad.onchange = () => {
    settings.radius = Math.min(500, Math.max(10, +rad.value || 40));
    rad.value = settings.radius;
    saveSettings();
    fog.redrawAll();
  };
  mp.oninput = () => { settings.minPx = +mp.value; saveSettings(); scheduleRedraw(); };
  wl.onchange = () => { settings.wakeLock = wl.checked; saveSettings(); wl.checked ? acquireWakeLock() : releaseWakeLock(); };
  acc.onchange = () => { settings.maxAccuracy = Math.max(10, +acc.value || 100); acc.value = settings.maxAccuracy; saveSettings(); };
  tok.onchange = () => { settings.token = tok.value.trim(); saveSettings(); };
  gist.onchange = () => {
    // URL を貼られても ID だけ取り出す
    const m = gist.value.trim().match(/([0-9a-f]{20,})\/?$/i);
    settings.gistId = m ? m[1] : gist.value.trim();
    gist.value = settings.gistId;
    saveSettings();
  };
  as.onchange = () => { settings.autoSync = as.checked; saveSettings(); };

  $('btn-sync').onclick = async () => {
    tok.onchange(); gist.onchange();
    const b = $('btn-sync');
    b.disabled = true;
    $('sync-msg').textContent = '同期中…';
    await syncSafe(false);
    b.disabled = false;
  };
  $('btn-settings').onclick = () => { $('panel').hidden = false; };
  $('btn-close').onclick = () => { $('panel').hidden = true; };
  if (settings.lastSync) $('sync-msg').textContent = `最終同期: ${fmtTime(settings.lastSync)}`;
}

/* ---------- boot ---------- */

(function boot() {
  try {
    for (const k of decodeCells(localStorage.getItem(LS.cells) || '')) addKey(k);
  } catch (e) {
    console.error(e);
    toast('保存データの読み込みに失敗しました');
  }
  bindSettings();
  fog.redrawAll();
  updateStatus();
  if (lsGet('ashiato.tracking', false)) startTracking();
  if (settings.autoSync) syncSafe(true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }
})();
