// Calcolo delle metriche di corsa dai landmark 2D. Modulo puro: nessun accesso a DOM o video.
// Vista laterale: eventi di appoggio con metodo a coordinate (piede rispetto al bacino, Zeni 2008),
// applicato all'inviluppo dei due piedi cosi' gli scambi sinistra/destra non creano errori.
// Vista frontale/posteriore: appoggio assegnato al piede piu' basso nell'immagine.

export const I = { lSh: 11, rSh: 12, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const REQUIRED = [23, 24, 25, 26, 27, 28];
const DEG = 180 / Math.PI;
const BUFFER_MS = 8000;
const MIN_STEP_MS = 180;
const MAX_STEP_MS = 700;

export const median = (a) => quantile(a, 0.5);
export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function jointFlexion(a, b, c) { // 0 = arto esteso
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
  return 180 - Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}

function smooth(values, radius) {
  if (radius <= 0) return values.slice();
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) { sum += values[k]; n++; }
    return sum / n;
  });
}

// Scarto robusto degli outlier (passi mancati, salti del tracking) prima delle statistiche di sessione.
export function trimOutliers(values) {
  if (values.length < 5) return values;
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m))) * 1.4826;
  if (mad < 1e-9) return values;
  return values.filter((v) => Math.abs(v - m) <= 3.5 * mad);
}

export function statsOf(values) {
  const clean = trimOutliers(values);
  if (!clean.length) return null;
  const m = mean(clean);
  const sd = clean.length > 1 ? Math.sqrt(clean.reduce((s, v) => s + (v - m) ** 2, 0) / (clean.length - 1)) : 0;
  return { mean: m, sd, median: median(clean), n: clean.length, excluded: values.length - clean.length };
}

export function prepareFrame(landmarks, { aspect, mirror = false, view }) {
  const p = landmarks.map((l) => ({ x: (mirror ? 1 - l.x : l.x) * aspect, y: l.y, v: l.visibility ?? 1 }));
  const minVis = view === 'side' ? 0.2 : 0.4; // di lato l'arto lontano ha sempre visibilita' piu' bassa
  if (REQUIRED.some((i) => p[i].v < minVis)) return null;
  if (view !== 'side') {
    // Da dietro il modello confonde spesso le etichette: i lati si assegnano dalla geometria.
    // Dietro: sinistra del corridore = sinistra immagine. Davanti: il contrario.
    const dx = p[I.rHip].x - p[I.lHip].x;
    const wrong = view === 'rear' ? dx < 0 : dx > 0;
    if (wrong && Math.abs(dx) > 0.005) for (const [a, b] of PAIRS) { const t = p[a]; p[a] = p[b]; p[b] = t; }
  }
  return p;
}

export class RunAnalyzer {
  constructor({ view, aspect = 16 / 9, mirror = false, baselineTilt = null, onEvent = null }) {
    Object.assign(this, { view, aspect, mirror, baselineTilt, onEvent });
    this.frames = [];
    this.series = {};
    this.events = [];
    this.lastEventT = -Infinity;
    this.lastAnalysis = -Infinity;
    this.total = 0;
    this.validTotal = 0;
    this.validRecent = [];
    this.leg = NaN;
    this.direction = 1;
    this.fps = 0;
  }

  push(landmarks, t) {
    this.total++;
    this.validRecent.push({ t, ok: !!landmarks });
    while (this.validRecent.length && this.validRecent[0].t < t - 3000) this.validRecent.shift();
    if (this.validRecent.length > 1) {
      const span = t - this.validRecent[0].t;
      if (span > 0) this.fps = (this.validRecent.length - 1) * 1000 / span;
    }
    const p = landmarks ? prepareFrame(landmarks, this) : null;
    if (landmarks && !p) this.validRecent[this.validRecent.length - 1].ok = false;
    if (p) { this.frames.push({ t, p }); this.validTotal++; }
    while (this.frames.length && this.frames[0].t < t - BUFFER_MS) this.frames.shift();
    if (t - this.lastAnalysis >= 200) { this.lastAnalysis = t; this.analyze(); }
  }

  // Quota di fotogrammi con il corpo riconosciuto negli ultimi 3 secondi (0-1).
  get quality() {
    if (!this.validRecent.length) return 0;
    return this.validRecent.filter((f) => f.ok).length / this.validRecent.length;
  }

  get sessionQuality() { return this.total ? this.validTotal / this.total : 0; }

  // Tolleranza temporale di un singolo evento: un fotogramma.
  get eventToleranceMs() { return this.fps > 0 ? 1000 / this.fps : NaN; }

  analyze() {
    if (this.frames.length < 15) return;
    this.leg = quantile(this.frames.flatMap(({ p }) => [dist(p[I.lHip], p[I.lAnk]), dist(p[I.rHip], p[I.rAnk])]), 0.9);
    if (!(this.leg > 0)) return;
    if (this.view === 'side') this.analyzeSide(); else this.analyzeFrontal();
  }

  emit(tStart, duration, side, values, keyLandmarks, contact = null) {
    this.lastEventT = tStart;
    for (const [k, v] of Object.entries(values)) {
      if (v == null || !Number.isFinite(v)) continue;
      (this.series[k] ??= []).push({ t: tStart, v });
    }
    const ev = { view: this.view, t: tStart, duration, contact, side, values, keyLandmarks };
    this.events.push(ev);
    this.onEvent?.(ev);
  }

  analyzeSide() {
    const F = this.frames, leg = this.leg, t = F.map((f) => f.t);
    this.direction = median(F.flatMap(({ p }) => [p[I.lToe].x - p[I.lHeel].x, p[I.rToe].x - p[I.rHeel].x])) >= 0 ? 1 : -1;
    const dir = this.direction;
    const radius = this.fps >= 90 ? 2 : 1;
    const hips = F.map(({ p }) => mid(p[I.lHip], p[I.rHip]));
    const frontRaw = F.map(({ p }, i) => Math.max(dir * (p[I.lHeel].x - hips[i].x), dir * (p[I.rHeel].x - hips[i].x)) / leg);
    const backRaw = F.map(({ p }, i) => Math.min(dir * (p[I.lToe].x - hips[i].x), dir * (p[I.rToe].x - hips[i].x)) / leg);
    const front = smooth(frontRaw, radius), back = smooth(backRaw, radius);
    // La media mobile trova i picchi senza farsi ingannare dal rumore, ma sposta il picco verso il lato piu'
    // piatto: l'istante finale si rilegge quindi sul segnale grezzo, attorno al picco trovato.
    const refine = (raw, i, sign) => {
      let best = i;
      for (let k = Math.max(0, i - radius); k <= Math.min(raw.length - 1, i + radius); k++) if (sign * raw[k] > sign * raw[best]) best = k;
      return best;
    };
    const hipY = smooth(hips.map((h) => h.y), radius);
    const m = median(front), top = quantile(front, 0.95), threshold = m + 0.25 * (top - m);
    if (top - quantile(front, 0.05) < 0.1) return; // piedi quasi fermi: la persona non sta correndo
    const end = t[t.length - 1];
    const peaks = [];
    for (let i = 0; i < F.length; i++) {
      if (front[i] < threshold || t[i] > end - MIN_STEP_MS) continue;
      let isMax = true;
      for (let k = i - 1; k >= 0 && t[i] - t[k] <= MIN_STEP_MS; k--) if (front[k] > front[i]) { isMax = false; break; }
      for (let k = i + 1; isMax && k < F.length && t[k] - t[i] <= MIN_STEP_MS; k++) if (front[k] >= front[i]) isMax = false;
      if (isMax) peaks.push(refine(frontRaw, i, 1));
    }
    for (let n = 0; n + 1 < peaks.length; n++) {
      const a = peaks[n], b = peaks[n + 1];
      if (t[a] <= this.lastEventT) continue;
      const stepT = t[b] - t[a];
      if (stepT > MAX_STEP_MS) { this.lastEventT = t[a]; continue; }

      // Stacco: minimo interno piu' profondo del piede arretrato; si ignora l'inizio della finestra
      // perche' li' il piede precedente sta ancora risalendo.
      let toe = -1;
      for (let i = a + 1; i < b; i++) {
        if (t[i] - t[a] < 80) continue;
        if (back[i] <= back[i - 1] && back[i] <= back[i + 1] && (toe < 0 || back[i] < back[toe])) toe = i;
      }
      if (toe >= 0) toe = Math.max(a + 1, Math.min(b - 1, refine(backRaw, toe, -1)));
      const contact = toe >= 0 ? t[toe] - t[a] : null;

      // Gamba in appoggio: al contatto e' quella col tallone piu' avanti; poi si segue per continuita'.
      const pa = F[a].p, ha = hips[a];
      const leftLeads = dir * (pa[I.lHeel].x - ha.x) >= dir * (pa[I.rHeel].x - ha.x);
      const chain = (left, p) => left
        ? { hip: p[I.lHip], knee: p[I.lKnee], ank: p[I.lAnk] }
        : { hip: p[I.rHip], knee: p[I.rKnee], ank: p[I.rAnk] };
      const ic = chain(leftLeads, pa);
      const kneeIC = jointFlexion(ic.hip, ic.knee, ic.ank);
      const shank = Math.atan2(dir * (ic.ank.x - ic.knee.x), ic.ank.y - ic.knee.y) * DEG;

      let kneeStance = kneeIC, left = leftLeads, prev = { x: ic.ank.x - ha.x, y: ic.ank.y };
      for (let i = a + 1; toe >= 0 && i <= toe; i++) {
        const l = chain(true, F[i].p), r = chain(false, F[i].p), h = hips[i];
        const dl = Math.hypot(l.ank.x - h.x - prev.x, l.ank.y - prev.y), dr = Math.hypot(r.ank.x - h.x - prev.x, r.ank.y - prev.y);
        left = dl <= dr;
        const c = left ? l : r;
        prev = { x: c.ank.x - h.x, y: c.ank.y };
        kneeStance = Math.max(kneeStance, jointFlexion(c.hip, c.knee, c.ank));
      }
      const window = F.slice(a, b + 1);
      const trunk = mean(window.map(({ p }) => {
        const s = mid(p[I.lSh], p[I.rSh]), h = mid(p[I.lHip], p[I.rHip]);
        return Math.atan2(dir * (s.x - h.x), h.y - s.y) * DEG;
      }));
      const ys = hipY.slice(a, b + 1);
      this.emit(t[a], stepT, null, {
        cadence: 60000 / stepT, stepTime: stepT, contact,
        flight: contact != null ? stepT - contact : null,
        overstride: frontRaw[a] * 100, shank, kneeIC, kneeStance, trunk,
        oscillation: (Math.max(...ys) - Math.min(...ys)) / leg * 100,
      }, F[a].p, contact);
    }
  }

  analyzeFrontal() {
    const F = this.frames, leg = this.leg, t = F.map((f) => f.t);
    const radius = this.fps >= 90 ? 2 : 1;
    const footY = (p, h, a, o) => (p[h].y + p[a].y + p[o].y) / 3;
    const diff = smooth(F.map(({ p }) => footY(p, I.lHeel, I.lAnk, I.lToe) - footY(p, I.rHeel, I.rAnk, I.rToe)), radius);
    const hyst = 0.03 * leg;
    const tilt = smooth(F.map(({ p }) => Math.atan2(p[I.rHip].y - p[I.lHip].y, Math.abs(p[I.rHip].x - p[I.lHip].x)) * DEG), radius);
    const base = this.baselineTilt ?? mean(tilt);

    let state = null;
    const switches = [];
    diff.forEach((d, i) => {
      const next = d > hyst ? 'L' : d < -hyst ? 'R' : state;
      if (next !== state) { if (state !== null) switches.push({ i, side: next }); state = next; }
    });
    const fppa = (p, side) => {
      const [h, k, a, oh] = side === 'L' ? [I.lHip, I.lKnee, I.lAnk, I.rHip] : [I.rHip, I.rKnee, I.rAnk, I.lHip];
      const medial = Math.sign(p[oh].x - p[h].x) || 1;
      const span = p[a].y - p[h].y;
      const u = span ? (p[k].y - p[h].y) / span : 0.5;
      const lineX = p[h].x + (p[a].x - p[h].x) * u;
      return jointFlexion(p[h], p[k], p[a]) * (((p[k].x - lineX) * medial) >= 0 ? 1 : -1);
    };
    for (let n = 0; n + 1 < switches.length; n++) {
      const { i: a, side } = switches[n], b = switches[n + 1].i;
      if (t[a] <= this.lastEventT) continue;
      const dur = t[b] - t[a];
      if (dur < 100 || dur > MAX_STEP_MS) { this.lastEventT = t[a]; continue; }
      let drop = -Infinity, dropIdx = a;
      for (let i = a; i < b; i++) {
        const d = side === 'L' ? tilt[i] - base : base - tilt[i];
        if (d > drop) { drop = d; dropIdx = i; }
      }
      const lastValgus = Math.max(a + 1, a + Math.ceil((b - a) * 0.7));
      let valgus = -Infinity;
      for (let i = a; i < lastValgus; i++) valgus = Math.max(valgus, fppa(F[i].p, side));
      const lateral = median(F.slice(a, b).map(({ p }) => {
        const h = mid(p[I.lHip], p[I.rHip]);
        const [ownHip, ank] = side === 'L' ? [p[I.lHip], p[I.lAnk]] : [p[I.rHip], p[I.rAnk]];
        return (ank.x - h.x) * (Math.sign(ownHip.x - h.x) || 1) / leg * 100;
      }));
      this.emit(t[a], dur, side, {
        cadence: 60000 / dur, stepTime: dur, [`stepTime_${side}`]: dur,
        [`drop_${side}`]: drop, [`valgus_${side}`]: valgus, [`lateral_${side}`]: lateral,
      }, F[dropIdx].p);
    }
  }

  values(key, lastN = Infinity) {
    const s = this.series[key] ?? [];
    return (lastN === Infinity ? s : s.slice(-lastN)).map((e) => e.v);
  }

  // Valore corrente: mediana degli ultimi passi, resistente ai singoli errori del tracking.
  live(key, lastN = 10) {
    const v = this.values(key, lastN);
    return v.length ? median(v) : null;
  }

  derived(lastN = Infinity) {
    const l = this.values('lateral_L', lastN), r = this.values('lateral_R', lastN);
    const tl = this.values('stepTime_L', lastN), tr = this.values('stepTime_R', lastN);
    const out = {};
    if (l.length && r.length) {
      out.stepWidth = median(l) + median(r);
      out.crossover = [...l, ...r].filter((v) => v < 0).length / (l.length + r.length) * 100;
    }
    if (tl.length && tr.length) {
      const a = median(tl), b = median(tr);
      out.asymmetry = Math.abs(a - b) / ((a + b) / 2) * 100;
    }
    return out;
  }

  // Riepilogo della sessione: statistiche e andamento in blocchi da 10 secondi.
  summary(startT = null) {
    const metrics = {};
    const t0 = startT ?? this.events[0]?.t ?? 0;
    for (const [key, entries] of Object.entries(this.series)) {
      const stats = statsOf(entries.map((e) => e.v));
      if (!stats) continue;
      const bins = new Map();
      for (const e of entries) {
        const b = Math.floor((e.t - t0) / 10000);
        if (!bins.has(b)) bins.set(b, []);
        bins.get(b).push(e.v);
      }
      stats.series = [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([b, v]) => ({ s: b * 10 + 5, v: median(v) }));
      metrics[key] = stats;
    }
    return { metrics, derived: this.derived(), steps: this.events.length };
  }
}
