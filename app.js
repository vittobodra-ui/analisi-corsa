import { RunAnalyzer, I, prepareFrame } from './metrics.js';
import { simulate, DEFAULT_PARAMS } from './sim.js';
import { createPose } from './engine.js';
import { saveSession, allSessions, getSession } from './store.js';
import { renderArchive, renderReport, VIEW_NAMES } from './report.js';

const $ = (id) => document.getElementById(id);
const NOTE = (m, err = false) => { const s = $('status'); s.textContent = m; s.classList.toggle('err', err); };
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* preferenza non salvata */ } },
};
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
const VIEWS = ['side', 'front', 'rear'];
const BONES = { c: [[11, 12], [11, 23], [12, 24], [23, 24]], l: [[11, 13], [13, 15], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31]], r: [[12, 14], [14, 16], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32]] };
const RING = 12, KEY_W = 480;
const SIDE = [['cadence', 'Cadenza', 'passi/min', 0, 'hero'], ['contact', 'Contatto', 'ms', 0], ['flight', 'Volo', 'ms', 0], ['overstride', 'Tallone avanti', '% gamba', 0], ['kneeIC', 'Ginocchio al contatto', '°', 0], ['trunk', 'Tronco', '°', 0], ['oscillation', 'Oscillazione', '% gamba', 0]];
const FRONT = [['cadence', 'Cadenza', 'passi/min', 0, 'hero'], ['drop', 'Caduta bacino', '°', 1, 'dual'], ['valgus', 'Valgo', '°', 1, 'dual'], ['lateral', 'Piede dalla mediana', '%', 0, 'dual'], ['stepWidth', 'Larghezza passo', '% gamba', 0, 'der'], ['crossover', 'Passi che incrociano', '%', 0, 'der'], ['asymmetry', 'Asimmetria tempi', '%', 1, 'der']];

let doc = null;            // analisi in corso, salvata dopo ogni passaggio
let P = null;              // passaggio aperto
let pose = null, poseKind = null, installEvent = null, metronome = null, wakeLock = null, audio = null;

/* ---------- impostazioni ---------- */
for (const id of ['s_count', 's_dur', 's_model', 's_metro', 's_rate']) {
  const el = $(id), v = ls.get(`ac_${id}`, null);
  if (v !== null) el.value = v;
  el.addEventListener('change', () => ls.set(`ac_${id}`, el.value));
}

/* ---------- analisi e home ---------- */
const newDoc = () => ({ id: Date.now(), createdAt: Date.now(), durationS: 0, simulated: false, calibrated: false, calibratedViews: {}, draft: true, views: {}, person: '', speed: '', incline: '', shoes: '', notes: '' });
function formToDoc() {
  if (!doc) return;
  for (const k of ['person', 'speed', 'incline', 'shoes', 'notes']) doc[k] = $(k).value.trim();
}
function docToForm() { for (const k of ['person', 'speed', 'incline', 'shoes', 'notes']) $(k).value = doc?.[k] ?? ''; }
function renderHome() {
  $('passes').innerHTML = VIEWS.map((v) => {
    const d = doc?.views[v];
    const cad = d?.metrics?.cadence?.mean;
    const info = d ? `${num(cad)} passi/min, ${d.steps} passi` : v === 'side' ? 'Cadenza, contatto, tallone, ginocchio, tronco' : 'Bacino, valgo, posizione del piede';
    return `<div class="pass-row ${d ? 'done' : ''}"><div><b>${VIEW_NAMES[v]}</b><small>${info}</small></div><a class="btn" href="#pass/${v}">${d ? 'Ripeti' : 'Riprendi'}</a></div>`;
  }).join('');
  const n = doc ? Object.keys(doc.views).length : 0;
  $('finish').disabled = n === 0;
  $('restart').hidden = n === 0;
  $('restart').textContent = 'Inizia una nuova analisi';
  delete $('restart').dataset.armed;
}
async function fillPeople() {
  const names = [...new Set((await allSessions()).map((s) => s.person).filter(Boolean))];
  $('people').innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
}

/* ---------- ripresa ---------- */
function liveMarkup(view) {
  return (view === 'side' ? SIDE : FRONT).map(([k, label, , , mode]) => `<div class="m ${mode === 'hero' ? 'hero' : ''}"><span>${label}</span><b id="m_${k}">–</b></div>`).join('');
}
function newAnalyzer() {
  const v = $('video');
  const aspect = P.kind === 'demo' ? 9 / 16 : (v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 9 / 16);
  P.analyzer = new RunAnalyzer({ view: P.view, aspect, baselineTilt: P.baseline, onEvent });
  P.keyframes = {}; P.keyTimes = {};
}
async function openPass(view) {
  formToDoc();
  P = { view, state: 'preview', kind: 'none', baseline: null, ring: [], ringAt: 0, lastTs: 0, errors: 0, rvfc: false, keyframes: {}, keyTimes: {}, facing: 'environment' };
  $('shot').hidden = false;
  $('shotTitle').textContent = VIEW_NAMES[view];
  $('liveBox').innerHTML = liveMarkup(view);
  $('calib').hidden = view === 'side';
  $('tools').hidden = false;
  setGo();
  newAnalyzer();
  acquireWakeLock();
  await startCamera();
}
function closePass() {
  if (!P) return;
  clearInterval(P.countTimer); clearInterval(P.clockTimer); clearInterval(P.calibTimer);
  stopSource();
  P = null;
  $('shot').hidden = true; $('count').hidden = true; $('clock').hidden = true;
  stopMetronome();
  releaseWakeLock();
}
function stopSource() {
  const v = $('video');
  P.stream?.getTracks().forEach((t) => t.stop());
  P.stream = null;
  v.pause(); v.srcObject = null; v.onended = null;
  if (P.fileUrl) { URL.revokeObjectURL(P.fileUrl); P.fileUrl = null; v.removeAttribute('src'); v.load(); }
  v.hidden = true;
  P.demo = false; cancelAnimationFrame(P.raf);
  P.kind = 'none';
  $('demo').setAttribute('aria-pressed', 'false');
  const c = $('overlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  setGo();
}
async function startCamera(deviceId = null) {
  if (!navigator.mediaDevices?.getUserMedia) { hint('La fotocamera qui non è disponibile: apri l’app da un indirizzo https, con Chrome.', true); return; }
  stopSource();
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
  if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { ideal: 'environment' };
  try {
    P.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    const msg = e.name === 'NotAllowedError' ? 'Accesso alla fotocamera negato. Consentilo dall’icona accanto all’indirizzo, poi riapri la ripresa.'
      : e.name === 'NotFoundError' ? 'Nessuna fotocamera trovata. Puoi scegliere un file video.'
        : 'La fotocamera è usata da un’altra app o non si avvia. Chiudi le altre app e riapri la ripresa.';
    hint(msg, true);
    return;
  }
  if (!P) { return; }
  P.kind = 'camera'; P.sourceName = P.stream.getVideoTracks()[0]?.label ?? '';
  const v = $('video');
  v.srcObject = P.stream;
  await afterSource();
  await v.play().catch(() => {});
  fillCameras();
}
async function fillCameras() {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const cur = P?.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  $('camera').innerHTML = all.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === cur ? 'selected' : ''}>${(c.label || `Fotocamera ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
}
async function afterSource() {
  const v = $('video');
  v.hidden = false;
  await new Promise((res) => { if (v.readyState >= 1) res(); else { v.onloadedmetadata = res; v.onerror = res; } });
  if (!P) return;
  if (v.error) { hint('Questo video non si apre nel browser. Registralo in H.264 anziché HEVC, poi riprova.', true); stopSource(); return; }
  sizeOverlay();
  newAnalyzer();
  allocRing();
  await ensurePose();
  if (!P.rvfc && P.kind !== 'demo') { P.rvfc = true; v.requestVideoFrameCallback(onFrame); }
  setGo();
}
function sizeOverlay() {
  const v = $('video'), c = $('overlay');
  c.width = v.videoWidth || 720; c.height = v.videoHeight || 1280;
}
function allocRing() {
  const c = $('overlay'), h = Math.round(KEY_W * c.height / c.width);
  P.ring = Array.from({ length: RING }, () => { const k = document.createElement('canvas'); k.width = KEY_W; k.height = h; return { c: k, t: -1, lm: null }; });
}
async function ensurePose() {
  const kind = $('s_model').value;
  if (pose && poseKind === kind) return;
  try {
    pose?.close?.();
    hint('Carico il riconoscimento della posa: la prima volta serve Internet…');
    pose = await createPose(kind); poseKind = kind;
    hint(pose.delegate === 'CPU' ? 'Riconoscimento sul processore: i fotogrammi analizzati saranno pochi.' : '', pose.delegate === 'CPU');
  } catch (e) {
    pose = null; console.error(e);
    hint('Riconoscimento non caricato. Controlla la connessione e riapri la ripresa.', true);
  }
}
// Gli esiti importanti restano visibili qualche secondo, prima delle indicazioni automatiche.
function hint(m, warn = false, keepMs = 0) {
  const h = $('hint'); h.textContent = m; h.classList.toggle('warn', warn);
  if (P) P.hintUntil = keepMs ? performance.now() + keepMs : 0;
}

function onFrame(now, meta) {
  if (!P || (P.kind !== 'camera' && P.kind !== 'file')) { if (P) P.rvfc = false; return; }
  const v = $('video');
  v.requestVideoFrameCallback(onFrame);
  if (!pose) return;
  if (P.kind === 'file' && P.state !== 'recording') return;
  const t = P.kind === 'file' ? meta.mediaTime * 1000 : (meta.captureTime ?? now);
  let lm = null;
  try {
    P.lastTs = Math.max(P.lastTs + 1, Math.round(performance.now()));
    lm = pose.detect(v, P.lastTs);
    P.errors = 0;
  } catch (e) {
    if (++P.errors === 5) { hint(`Errore nel riconoscimento: ${e.message}`, true); console.error(e); }
    return;
  }
  handleFrame(lm, t);
  if (P.state === 'recording') stash(v, lm, t);
}
function handleFrame(lm, t) {
  P.analyzer.push(lm, t);
  draw($('overlay'), lm);
  if (P.calibTilts && lm) {
    const p = prepareFrame(lm, P.analyzer);
    if (p) { const dx = Math.abs(p[I.rHip].x - p[I.lHip].x); if (dx > 0.005) P.calibTilts.push(Math.atan2(p[I.rHip].y - p[I.lHip].y, dx) * 180 / Math.PI); }
  }
}
function draw(canvas, lm, clear = true) {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  if (clear) ctx.clearRect(0, 0, w, h);
  if (clear && P.kind === 'demo') { ctx.fillStyle = '#0d1b2b'; ctx.fillRect(0, 0, w, h); }
  if (lm) skeleton(ctx, lm, w, h);
}
function skeleton(ctx, lm, w, h) {
  const p = lm.map((l) => ({ x: l.x * w, y: l.y * h }));
  if (P.view !== 'side') {
    const dx = p[24].x - p[23].x;
    if (P.view === 'rear' ? dx < 0 : dx > 0) for (const [a, b] of [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]) { const t = p[a]; p[a] = p[b]; p[b] = t; }
  }
  const lw = Math.max(2.5, Math.max(w, h) / 320), side = P.view === 'side';
  const line = (b, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath(); for (const [x, y] of b) { ctx.moveTo(p[x].x, p[x].y); ctx.lineTo(p[y].x, p[y].y); } ctx.stroke(); };
  line(BONES.c, '#fff'); line(BONES.l, side ? '#e6edf3' : '#4d9df0'); line(BONES.r, side ? '#e6edf3' : '#f58a55');
}
function stash(source, lm, t) {
  const f = P.ring[P.ringAt = (P.ringAt + 1) % RING];
  if (!f) return;
  f.c.getContext('2d').drawImage(source, 0, 0, f.c.width, f.c.height);
  f.t = t; f.lm = lm;
}
function onEvent(ev) {
  if (!P || P.state !== 'recording' || !P.ring.length) return;
  const metric = P.view === 'side' ? 'overstride' : `drop_${ev.side}`, v = ev.values[metric];
  if (!Number.isFinite(v)) return;
  const key = P.view === 'side' ? 'ic' : ev.side;
  const score = Math.abs(v - P.analyzer.live(metric, 60));
  const prior = P.keyframes[key];
  if (prior && (score >= prior.score || ev.t - (P.keyTimes[key] ?? 0) < 1500)) return;
  let best = null;
  for (const f of P.ring) if (f.t >= 0 && (!best || Math.abs(f.t - ev.t) < Math.abs(best.t - ev.t))) best = f;
  if (!best) return;
  const out = document.createElement('canvas'); out.width = best.c.width; out.height = best.c.height;
  const c = out.getContext('2d'); c.drawImage(best.c, 0, 0);
  if (best.lm) skeleton(c, best.lm, out.width, out.height);
  P.keyTimes[key] = ev.t;
  P.keyframes[key] = { score, src: out.toDataURL('image/jpeg', 0.7), label: key === 'ic' ? 'Contatto iniziale, passo tipico' : `Appoggio ${key === 'L' ? 'sinistro' : 'destro'}, passo tipico` };
}

/* ---------- letture ---------- */
function renderLive() {
  if (!P) return;
  const a = P.analyzer, der = a.derived(40);
  const auto = performance.now() >= (P.hintUntil ?? 0);
  for (const [k, , unit, d, mode] of P.view === 'side' ? SIDE : FRONT) {
    const el = $(`m_${k}`);
    if (!el) continue;
    if (mode === 'dual') el.innerHTML = `<span class="lv">${num(a.live(`${k}_L`), d)}</span><span class="rv">${num(a.live(`${k}_R`), d)}</span> <small>${unit}</small>`;
    else {
      const val = mode === 'der' ? der[k] : a.live(k);
      el.innerHTML = `${num(val, d)} <small>${unit}</small>`;
    }
  }
  if (!auto) { /* resta il messaggio corrente */ } else if (P.state === 'preview' && P.kind === 'camera' && pose && a.total > 15 && !P.calibTilts) {
    const q = a.quality;
    if (q < 0.7) hint('Non vedo tutto il corpo: allontana il telefono o migliora la luce.', true);
    else hint(`Corpo riconosciuto, ${Math.round(a.fps)} fps di analisi.`);
  } else if (P.state === 'recording' && a.total > 30) {
    const q = a.quality;
    if (q < 0.7) hint(`Corpo riconosciuto solo nel ${Math.round(q * 100)}% dei fotogrammi: controlla l’inquadratura.`, true);
    else hint(a.fps > 0 && a.fps < 20 ? `Analisi lenta, ${Math.round(a.fps)} fps: i tempi di contatto non saranno affidabili.` : '', a.fps > 0 && a.fps < 20);
  }
}
function setGo() {
  const g = $('go');
  if (!P) return;
  g.disabled = P.kind === 'none' || (P.kind !== 'demo' && !pose);
  if (P.state === 'recording') { g.textContent = 'Termina e salva'; g.className = 'stop'; g.disabled = false; }
  else if (P.state === 'countdown') { g.textContent = 'Annulla'; g.className = ''; g.disabled = false; }
  else { g.textContent = P.kind === 'file' ? 'Analizza il video' : 'Avvia il passaggio'; g.className = 'go'; }
}

/* ---------- passaggio ---------- */
function beep(freq = 880, ms = 140) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = freq; g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
  } catch { /* audio non disponibile */ }
}
function startPass() {
  beep(600, 40); // sblocca l'audio con il tocco
  let n = P.kind === 'file' ? 0 : parseInt($('s_count').value, 10);
  $('tools').hidden = true;
  if (!n) { record(); return; }
  P.state = 'countdown'; setGo();
  const c = $('count'); c.hidden = false; c.textContent = n;
  P.countTimer = setInterval(() => {
    n--;
    if (n > 0) { c.textContent = n; if (n <= 3) beep(660); return; }
    clearInterval(P.countTimer); c.hidden = true; record();
  }, 1000);
}
function cancelCountdown() {
  clearInterval(P.countTimer);
  $('count').hidden = true; $('tools').hidden = false;
  P.state = 'preview'; setGo();
}
function record() {
  beep(1100, 300);
  P.ring.forEach((f) => { f.t = -1; }); P.ringAt = 0;
  newAnalyzer();
  P.state = 'recording';
  P.startPerf = performance.now();
  setGo();
  const clock = $('clock'); clock.hidden = false; clock.textContent = '0:00';
  const dur = P.kind === 'file' ? 0 : parseInt($('s_dur').value, 10);
  P.clockTimer = setInterval(() => {
    const s = Math.floor((performance.now() - P.startPerf) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (dur && s >= dur) finishPass();
  }, 250);
  if (P.kind === 'file') {
    const v = $('video');
    v.currentTime = 0; v.playbackRate = parseFloat($('s_rate').value);
    v.onended = finishPass;
    v.play().catch(() => hint('Il video non parte: riprova.', true));
  }
}
async function finishPass() {
  if (!P || P.state !== 'recording') return;
  clearInterval(P.clockTimer); $('clock').hidden = true;
  beep(800, 500);
  const a = P.analyzer;
  if ($('video').src) $('video').pause();
  P.state = 'preview';
  if (a.events.length < 5) {
    $('tools').hidden = false; setGo();
    hint('Passaggio non salvato: ho rilevato troppo pochi passi. Controlla che tutto il corpo sia inquadrato e riprova.', true, 8000);
    return;
  }
  doc ??= newDoc();
  formToDoc();
  doc.views[P.view] = {
    ...a.summary(), fps: a.fps, quality: a.sessionQuality, sourceName: P.kind === 'file' ? P.sourceName : '',
    keyframes: Object.values(P.keyframes).map(({ label, src }) => ({ label, src })),
  };
  doc.durationS += (performance.now() - P.startPerf) / 1000;
  if (P.kind === 'demo') doc.simulated = true;
  doc.calibratedViews[P.view] = P.baseline != null;
  const frontal = VIEWS.filter((v) => v !== 'side' && doc.views[v]);
  doc.calibrated = frontal.length > 0 && frontal.every((v) => doc.calibratedViews[v]);
  try {
    await saveSession(doc);
    location.hash = '#home';
  } catch (e) {
    $('tools').hidden = false; setGo();
    hint(`Passaggio non salvato: ${e.message}. Lo spazio del telefono potrebbe essere esaurito.`, true, 8000);
  }
}
function calibrate() {
  if (P.calibTilts || P.kind === 'none' || P.kind === 'file') { if (P.kind === 'file') hint('La calibrazione funziona solo dal vivo.', true); return; }
  P.calibTilts = [];
  let left = 3;
  hint(`La persona resta ferma in piedi: ${left}…`);
  P.calibTimer = setInterval(() => {
    left--;
    if (left > 0) { hint(`La persona resta ferma in piedi: ${left}…`); return; }
    clearInterval(P.calibTimer);
    const tilts = P.calibTilts.sort((a, b) => a - b); P.calibTilts = null;
    if (tilts.length < 8) { hint('Calibrazione non riuscita: corpo non riconosciuto. Controlla l’inquadratura e riprova.', true, 6000); return; }
    P.baseline = tilts[Math.floor(tilts.length / 2)];
    P.analyzer.baselineTilt = P.baseline;
    hint(`Calibrazione eseguita: bacino a riposo ${num(P.baseline, 1)}°.`, false, 5000);
    beep(990, 200);
  }, 1000);
}
function startDemo() {
  stopSource();
  P.kind = 'demo'; P.demo = true;
  const c = $('overlay'); c.width = 720; c.height = 1280;
  $('demo').setAttribute('aria-pressed', 'true');
  newAnalyzer(); allocRing(); setGo();
  hint('Simulazione: corridore virtuale con valori noti.');
  const start = performance.now();
  let last = -100;
  const tick = (now) => {
    if (!P?.demo) return;
    const t = now - start;
    if (t - last >= 16) {
      last = t;
      const lm = simulate(P.view, t, DEFAULT_PARAMS, 9 / 16);
      handleFrame(lm, t);
      if (P.state === 'recording') stash(c, null, t);
    }
    P.raf = requestAnimationFrame(tick);
  };
  P.raf = requestAnimationFrame(tick);
}

/* ---------- sveglia dello schermo e metronomo ---------- */
async function acquireWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* lo schermo puo' spegnersi */ } }
function releaseWakeLock() { wakeLock?.release?.().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !P) return;
  acquireWakeLock();
  if (P.kind === 'camera' && P.stream?.getVideoTracks()[0]?.readyState === 'ended') {
    if (P.state === 'recording') { clearInterval(P.clockTimer); $('clock').hidden = true; P.state = 'preview'; $('tools').hidden = false; hint('Ripresa interrotta perché l’app è andata in secondo piano. Ripeti il passaggio.', true, 8000); }
    startCamera();
  }
});
function stopMetronome() {
  if (!metronome) return;
  clearTimeout(metronome.timer); metronome = null;
  $('metro').setAttribute('aria-pressed', 'false'); $('metro').textContent = 'Metronomo';
}
function toggleMetronome() {
  if (metronome) { stopMetronome(); return; }
  audio ??= new AudioContext();
  audio.resume?.();
  const spm = parseFloat($('s_metro').value) || 170;
  metronome = { next: audio.currentTime + 0.05 };
  $('metro').setAttribute('aria-pressed', 'true'); $('metro').textContent = `${spm}`;
  const loop = () => {
    if (!metronome) return;
    while (metronome.next < audio.currentTime + 0.2) {
      const o = audio.createOscillator(), g = audio.createGain(), t = metronome.next;
      o.frequency.value = 1100; g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.06);
      metronome.next += 60 / spm;
    }
    metronome.timer = setTimeout(loop, 50);
  };
  loop();
}

/* ---------- comandi ---------- */
$('go').onclick = () => {
  if (P.state === 'recording') finishPass();
  else if (P.state === 'countdown') cancelCountdown();
  else startPass();
};
$('shotClose').onclick = () => { location.hash = '#home'; };
$('calib').onclick = calibrate;
$('metro').onclick = toggleMetronome;
$('demo').onclick = () => { if (P.demo) startCamera(); else startDemo(); };
$('camera').onchange = (e) => startCamera(e.target.value);
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  stopSource();
  P.kind = 'file'; P.sourceName = f.name; P.fileUrl = URL.createObjectURL(f);
  const v = $('video'); v.src = P.fileUrl;
  hint('');
  await afterSource();
  e.target.value = '';
};
$('video').addEventListener('resize', () => {
  if (!P) return;
  sizeOverlay();
  const v = $('video');
  if (v.videoWidth && v.videoHeight) { P.analyzer.aspect = v.videoWidth / v.videoHeight; if (P.state !== 'recording') { newAnalyzer(); allocRing(); } }
});
$('form').onsubmit = (e) => e.preventDefault();
$('form').addEventListener('change', () => { if (doc) { formToDoc(); saveSession(doc).catch(() => {}); } });
$('finish').onclick = async () => {
  formToDoc(); doc.draft = false;
  await saveSession(doc);
  const id = doc.id; doc = null; docToForm(); fillPeople();
  location.hash = `#report/${id}`;
};
$('restart').onclick = async (e) => {
  const b = e.target;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Conferma: l’analisi attuale resta in archivio'; return; }
  doc.draft = false; await saveSession(doc); doc = null; docToForm(); renderHome();
};
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBox').hidden = false; });
addEventListener('appinstalled', () => { $('installBox').hidden = true; });
$('install').onclick = async () => { await installEvent?.prompt(); installEvent = null; $('installBox').hidden = true; };

/* ---------- navigazione ---------- */
async function route() {
  const [page, id, cmp] = (location.hash.slice(1) || 'home').split('/');
  closePass();
  const known = ['home', 'archivio', 'report', 'guida'];
  const showing = page === 'pass' ? 'home' : known.includes(page) ? page : 'home';
  for (const p of known) $(p).hidden = p !== showing;
  document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === showing) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (showing === 'home') renderHome();
  if (showing === 'archivio') renderArchive($('archivio'));
  if (showing === 'report') renderReport($('report'), Number(id), cmp);
  if (page === 'pass' && VIEWS.includes(id)) await openPass(id);
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
setInterval(renderLive, 250);

(async () => {
  const drafts = (await allSessions().catch(() => [])).filter((s) => s.draft);
  if (drafts[0]) { doc = drafts[0]; doc.calibratedViews ??= {}; docToForm(); }
  fillPeople();
  route();
  if (!isSecureContext) NOTE('Per usare la fotocamera l’app va aperta da un indirizzo https.', true);
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
