// Corridore simulato con parametri noti: serve per la modalita' dimostrativa e per i test delle metriche.
export const DEFAULT_PARAMS = {
  cadence: 172, contactMs: 245, overstride: 26, backSwing: 42, trunk: 7, oscillation: 11,
  dropL: 4, dropR: 8, valgusL: 3, valgusR: 7, lateralL: 5, lateralR: -1, staticTilt: 0,
  noise: 0.0012, direction: 1, perspective: 0.03, swapRearLabels: false,
};
const LEG = 0.40, THIGH = 0.205, SHANK = 0.205;
const rad = Math.PI / 180;

let seed = 1;
export const reseed = (s) => { seed = s; };
function gauss() {
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function legState(time, P, offset) {
  const stride = 120000 / P.cadence;
  const phase = (((time / stride + offset) % 1) + 1) % 1;
  const stance = P.contactMs / stride;
  if (phase < stance) {
    const u = phase / stance;
    return { stance: true, u, fwd: P.overstride / 100 + (-P.backSwing / 100 - P.overstride / 100) * u, lift: 0 };
  }
  const u = (phase - stance) / (1 - stance);
  const ease = (1 - Math.cos(Math.PI * u)) / 2;
  return { stance: false, u, fwd: -P.backSwing / 100 + (P.overstride + P.backSwing) / 100 * ease, lift: Math.sin(Math.PI * u) * 0.32 };
}

function hipHeight(time, P) { // piu' basso a meta' appoggio
  const stride = 120000 / P.cadence, stance = P.contactMs / stride;
  const phase = (((time / (stride / 2)) % 1) + 1) % 1;
  return -Math.cos(2 * Math.PI * (phase - stance)) * (P.oscillation / 100 * LEG) / 2;
}

function kneeOf(hip, ank, forward) {
  const dx = ank.x - hip.x, dy = ank.y - hip.y;
  const d = Math.min(Math.hypot(dx, dy), THIGH + SHANK - 1e-4);
  const a = d / 2, h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
  const n = Math.hypot(dx, dy) || 1;
  return { x: hip.x + dx / 2 + (-dy / n) * h * -forward, y: hip.y + dy / 2 + (dx / n) * h * -forward };
}

export function simulate(view, time, params = {}, aspect = 16 / 9) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
  const L = legState(time, P, 0), R = legState(time, P, 0.5);
  const cx = aspect / 2, hipY = 0.46 - hipHeight(time, P), groundOffset = 0.46 + 0.385;
  const set = (i, x, y) => { pts[i] = { x, y }; };

  if (view === 'side') {
    const dir = P.direction, lean = P.trunk * rad;
    const hip = { x: cx, y: hipY };
    const placeLeg = (S, iHip, iKnee, iAnk, iHeel, iToe) => {
      const footX = hip.x + dir * S.fwd * LEG;
      const groundY = groundOffset - S.lift * LEG;
      // tallone sull'asse del tallone riferito all'overstriding: la caviglia sta poco avanti
      const heel = { x: footX, y: groundY + 0.012 };
      const ank = { x: footX + dir * 0.012, y: groundY - 0.012 };
      const toe = { x: footX + dir * 0.06, y: groundY + 0.014 };
      const knee = kneeOf(hip, ank, dir);
      set(iHip, hip.x, hip.y); set(iKnee, knee.x, knee.y); set(iAnk, ank.x, ank.y); set(iHeel, heel.x, heel.y); set(iToe, toe.x, toe.y);
    };
    placeLeg(L, 23, 25, 27, 29, 31);
    placeLeg(R, 24, 26, 28, 30, 32);
    const torso = 0.27;
    const sh = { x: hip.x + dir * Math.sin(lean) * torso, y: hip.y - Math.cos(lean) * torso };
    set(11, sh.x, sh.y); set(12, sh.x, sh.y);
    set(0, sh.x + dir * 0.03, sh.y - 0.09);
    const arm = (S, a, b) => {
      const sw = -S.fwd * 0.14;
      set(a, sh.x + dir * sw, sh.y + 0.11); set(b, sh.x + dir * (sw + 0.08), sh.y + 0.13);
    };
    arm(L, 13, 15); arm(R, 14, 16);
  } else {
    // sinistra del corridore: a sinistra immagine se ripreso da dietro, a destra se da davanti
    const leftSign = view === 'rear' ? -1 : 1;
    const hw = 0.045;
    const stride = 120000 / P.cadence;
    const stanceFrac = P.contactMs / stride;
    let tilt = P.staticTilt; // positivo: anca destra piu' bassa
    if (L.stance) tilt += P.dropL * Math.sin(Math.PI * L.u);
    if (R.stance) tilt -= P.dropR * Math.sin(Math.PI * R.u);
    const dy = Math.tan(tilt * rad) * hw;
    const hipL = { x: cx + leftSign * hw, y: hipY - dy }, hipR = { x: cx - leftSign * hw, y: hipY + dy };
    const midHip = { x: cx, y: hipY };
    const place = (S, side, sign, hip, valgus, lateral, iHip, iKnee, iAnk, iHeel, iToe) => {
      // il piede vicino alla camera appare piu' basso: componente prospettica
      const near = (view === 'front' ? 1 : -1) * S.fwd;
      const groundY = groundOffset - S.lift * LEG + near * P.perspective;
      const ankX = midHip.x + sign * (lateral / 100) * LEG;
      const ank = { x: ankX, y: groundY - 0.012 };
      const peak = S.stance ? Math.sin(Math.PI * Math.min(1, S.u / 0.7)) : 0;
      const dev = valgus * peak * rad;
      const my = (hip.y + ank.y) / 2, mx = (hip.x + ank.x) / 2;
      const half = Math.hypot(ank.x - hip.x, ank.y - hip.y) / 2;
      const knee = { x: mx - sign * Math.tan(dev / 2) * half, y: my };
      set(iHip, hip.x, hip.y); set(iKnee, knee.x, knee.y); set(iAnk, ank.x, ank.y);
      set(iHeel, ank.x, ank.y + 0.024); set(iToe, ank.x + sign * 0.012, ank.y + 0.026);
    };
    place(L, 'L', leftSign, hipL, P.valgusL, P.lateralL, 23, 25, 27, 29, 31);
    place(R, 'R', -leftSign, hipR, P.valgusR, P.lateralR, 24, 26, 28, 30, 32);
    const shY = hipY - 0.27;
    set(11, cx + leftSign * 0.07, shY); set(12, cx - leftSign * 0.07, shY);
    set(0, cx, shY - 0.09);
    set(13, cx + leftSign * 0.085, shY + 0.12); set(14, cx - leftSign * 0.085, shY + 0.12);
    set(15, cx + leftSign * 0.06, shY + 0.2); set(16, cx - leftSign * 0.06, shY + 0.2);
    void stanceFrac; void hipR;
    if (view === 'rear' && P.swapRearLabels) {
      for (const [a, b] of [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]) { const t = pts[a]; pts[a] = pts[b]; pts[b] = t; }
    }
  }
  return pts.map((p) => ({
    x: (p.x + gauss() * P.noise) / aspect,
    y: p.y + gauss() * P.noise,
    z: 0, visibility: 0.98,
  }));
}
