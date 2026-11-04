import { allSessions, getSession, deleteSession } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDate = (ms) => new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));

export const VIEW_NAMES = { side: 'Vista laterale', front: 'Vista frontale', rear: 'Vista posteriore' };
const ROWS = {
  side: [
    ['cadence', 'Cadenza', 'passi/min', 0], ['stepTime', 'Tempo del passo', 'ms', 0], ['contact', 'Tempo di contatto', 'ms', 0], ['flight', 'Tempo di volo', 'ms', 0],
    ['overstride', 'Tallone avanti al bacino al contatto', '% gamba', 1], ['shank', 'Inclinazione tibia al contatto', '°', 1], ['kneeIC', 'Flessione ginocchio al contatto', '°', 1],
    ['kneeStance', 'Flessione massima in appoggio', '°', 1], ['trunk', 'Inclinazione del tronco', '°', 1], ['oscillation', 'Oscillazione verticale', '% gamba', 1],
  ],
  frontal: [
    ['drop', 'Caduta del bacino in appoggio', '°', 1, true], ['valgus', 'Valgo dinamico del ginocchio', '°', 1, true],
    ['lateral', 'Piede rispetto alla linea mediana', '% gamba', 1, true], ['stepTime', 'Tempo del passo', 'ms', 0, true], ['cadence', 'Cadenza', 'passi/min', 0],
  ],
};

function statCell(st, d) {
  return st ? `${num(st.mean, d)} <span class="sd">± ${num(st.sd, d)}</span>` : '–';
}
function deltaCell(a, b, d) {
  if (!a || !b) return '–';
  const x = a.mean - b.mean;
  return `${x > 0 ? '+' : ''}${num(x, d)}`;
}

function viewTable(view, data, prev) {
  const rows = view === 'side' ? ROWS.side : ROWS.frontal;
  const dual = view !== 'side';
  const M = data.metrics, P = prev?.metrics;
  const head = dual
    ? `<th>Misura</th><th class="n"><i class="sw l"></i>Sinistra</th><th class="n"><i class="sw r"></i>Destra</th>${prev ? '<th class="n">Var. sin.</th><th class="n">Var. des.</th>' : ''}`
    : `<th>Misura</th><th class="n">Media ± DS</th>${prev ? '<th class="n">Variazione</th>' : ''}`;
  const body = rows.map(([k, label, unit, d, split]) => {
    if (dual && split) {
      const a = M[`${k}_L`], b = M[`${k}_R`];
      if (!a && !b) return '';
      return `<tr><th scope="row">${label} <span class="u">${unit}</span></th><td class="n">${statCell(a, d)}</td><td class="n">${statCell(b, d)}</td>${prev ? `<td class="n">${deltaCell(a, P?.[`${k}_L`], d)}</td><td class="n">${deltaCell(b, P?.[`${k}_R`], d)}</td>` : ''}</tr>`;
    }
    if (!M[k]) return '';
    return dual
      ? `<tr><th scope="row">${label} <span class="u">${unit}</span></th><td class="n" colspan="2">${statCell(M[k], d)}</td>${prev ? `<td class="n" colspan="2">${deltaCell(M[k], P?.[k], d)}</td>` : ''}</tr>`
      : `<tr><th scope="row">${label} <span class="u">${unit}</span></th><td class="n">${statCell(M[k], d)}</td>${prev ? `<td class="n">${deltaCell(M[k], P?.[k], d)}</td>` : ''}</tr>`;
  }).join('');
  const D = data.derived ?? {};
  const extra = dual ? [
    ['Larghezza del passo', D.stepWidth, '% gamba', 1], ['Passi che incrociano la linea mediana', D.crossover, '%', 0], ['Asimmetria del tempo del passo', D.asymmetry, '%', 1],
  ].filter((r) => r[1] != null).map(([l, v, u, d]) => `<tr><th scope="row">${l} <span class="u">${u}</span></th><td class="n" colspan="2">${num(v, d)}</td>${prev ? '<td colspan="2"></td>' : ''}</tr>`).join('') : '';
  return `<table class="metrics"><thead><tr>${head}</tr></thead><tbody>${body}${extra}</tbody></table>`;
}

// Grafico a linee: un solo asse, griglia discreta, tooltip al passaggio del mouse.
function chart(title, unit, series, d = 1) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 3) return '';
  const W = 460, H = 150, L = 38, R = 10, T = 10, B = 24;
  const xs = all.map((p) => p.s), ys = all.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max((y1 - y0) * 0.15, d === 0 ? 3 : 0.5); y0 -= pad; y1 += pad;
  const X = (v) => L + (v - x0) / (x1 - x0 || 1) * (W - L - R), Y = (v) => H - B - (v - y0) / (y1 - y0) * (H - T - B);
  const ticks = [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1];
  const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="tick">${num(v, d)}</text>`).join('');
  const lines = series.map((s) => `<polyline fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="line ${s.cls}" points="${s.points.map((p) => `${X(p.s).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')}"/>`).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i class="sw ${s.cls}"></i>${s.name}</span>`).join('')}</div>` : '';
  const payload = esc(JSON.stringify({ series: series.map((s) => ({ name: s.name, points: s.points })), x0, x1, L, R, W, d, unit }));
  return `<figure class="chart" data-chart="${payload}"><figcaption>${title} <span class="u">${unit}</span></figcaption>${legend}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title} nel corso della sessione">${grid}${lines}
    <line class="cross" y1="${T}" y2="${H - B}" x1="0" x2="0" hidden/>
    <text x="${L}" y="${H - 6}" class="tick">${Math.round(x0)} s</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="tick">${Math.round(x1)} s</text></svg>
    <div class="tip" hidden></div></figure>`;
}

function bindCharts(root) {
  root.querySelectorAll('[data-chart]').forEach((fig) => {
    const c = JSON.parse(fig.dataset.chart), svg = fig.querySelector('svg'), cross = fig.querySelector('.cross'), tip = fig.querySelector('.tip');
    const pts = [...new Set(c.series.flatMap((s) => s.points.map((p) => p.s)))].sort((a, b) => a - b);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = (e.clientX - r.left) / r.width * c.W;
      const sx = c.x0 + (vx - c.L) / (c.W - c.L - c.R) * (c.x1 - c.x0);
      const s = pts.reduce((a, b) => (Math.abs(b - sx) < Math.abs(a - sx) ? b : a));
      const px = c.L + (s - c.x0) / (c.x1 - c.x0 || 1) * (c.W - c.L - c.R);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.removeAttribute('hidden');
      const lines = c.series.map((se) => { const p = se.points.find((q) => q.s === s); return p ? `${se.name}: ${num(p.v, c.d)} ${c.unit}` : null; }).filter(Boolean);
      tip.innerHTML = `<b>${Math.round(s)} s</b><br>${lines.map(esc).join('<br>')}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(px / c.W * r.width + 10, r.width - 170)}px`;
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('hidden', ''); tip.hidden = true; });
  });
}

const pts = (data, key) => data.metrics[key]?.series?.map((p) => ({ s: p.s, v: p.v })) ?? [];

export async function renderReport(root, id, compareId = null) {
  const s = await getSession(id);
  if (!s) { root.innerHTML = '<p class="empty">Questa sessione non è più in archivio. <a href="#archivio">Apri l’archivio</a></p>'; return; }
  const others = (await allSessions()).filter((o) => o.id !== id && (o.person || '') === (s.person || ''));
  const prev = compareId ? await getSession(Number(compareId)) : null;
  const facts = [
    ['Persona', s.person || 'Non indicata'], ['Velocità', s.speed ? `${s.speed} km/h` : null], ['Pendenza', s.incline ? `${s.incline}%` : null],
    ['Scarpe', s.shoes], ['Durata', `${Math.round(s.durationS)} s`], ['Riferimento bacino', s.calibrated ? 'Calibrato in piedi' : 'Media della corsa'],
  ].filter((f) => f[1]);

  const sections = Object.keys(VIEW_NAMES).filter((v) => s.views[v]).map((v) => {
    const data = s.views[v];
    const keys = (data.keyframes ?? []).map((k) => `<figure><img src="${k.src}" alt="${esc(k.label)}, ${esc(VIEW_NAMES[v])}"><figcaption>${esc(k.label)}</figcaption></figure>`).join('');
    const charts = v === 'side'
      ? chart('Cadenza', 'passi/min', [{ name: 'Cadenza', cls: 'n1', points: pts(data, 'cadence') }], 0) + chart('Tallone avanti al bacino', '% gamba', [{ name: 'Tallone', cls: 'n1', points: pts(data, 'overstride') }])
      : chart('Caduta del bacino in appoggio', '°', [{ name: 'Sinistra', cls: 'l', points: pts(data, 'drop_L') }, { name: 'Destra', cls: 'r', points: pts(data, 'drop_R') }]) + chart('Valgo dinamico', '°', [{ name: 'Sinistra', cls: 'l', points: pts(data, 'valgus_L') }, { name: 'Destra', cls: 'r', points: pts(data, 'valgus_R') }]);
    return `<section class="rep-view"><h2>${VIEW_NAMES[v]}</h2>
      <p class="fine">${data.steps} passi analizzati, ${num(data.fps, 0)} fotogrammi al secondo, corpo riconosciuto nel ${num(data.quality * 100, 0)}% dei fotogrammi${data.sourceName ? `, da ${esc(data.sourceName)}` : ''}.</p>
      ${v === 'side' && data.fps ? `<p class="fine">Ogni istante di contatto o stacco è noto con una tolleranza di almeno ±${num(1000 / data.fps, 0)} ms.</p>` : ''}
      ${viewTable(v, data, prev?.views?.[v])}
      ${keys ? `<div class="keys">${keys}</div>` : ''}
      ${charts ? `<div class="charts">${charts}</div>` : ''}</section>`;
  }).join('');

  root.innerHTML = `<div class="report">
    <header class="rep-head">
      <div><h1>${esc(s.person || 'Sessione di corsa')}</h1><p>${fmtDate(s.createdAt)}</p></div>
      <div class="rep-actions no-print">
        <label>Confronta con <select id="cmp"><option value="">Nessuna sessione</option>${others.map((o) => `<option value="${o.id}" ${String(o.id) === String(compareId) ? 'selected' : ''}>${fmtDate(o.createdAt)}${o.simulated ? ' (simulata)' : ''}</option>`).join('')}</select></label>
        <button id="print" class="primary">Stampa o salva PDF</button>
        <a class="btn" href="#archivio">Archivio</a>
      </div>
    </header>
    ${s.simulated ? '<p class="sim-banner">Sessione simulata: i dati vengono da un corridore virtuale, non da una persona.</p>' : ''}
    <dl class="facts">${facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
    ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
    ${prev ? `<p class="fine">Variazioni rispetto alla sessione del ${fmtDate(prev.createdAt)}.</p>` : ''}
    ${sections || '<p class="empty">Nessun passo è stato rilevato in questa sessione. Controlla inquadratura e luce, poi ripeti la ripresa.</p>'}
    <p class="fine disclaimer">Stime da video 2D, utili per confrontare le sessioni della stessa persona con la stessa ripresa. Non sono misure di laboratorio e non costituiscono una diagnosi.</p>
  </div>`;
  root.querySelector('#print').onclick = () => print();
  root.querySelector('#cmp').onchange = (e) => { location.hash = `#report/${id}${e.target.value ? `/${e.target.value}` : ''}`; };
  bindCharts(root);
}

export async function renderArchive(root) {
  const list = await allSessions();
  root.innerHTML = `<div class="archive">
    <header class="rep-head"><h1>Archivio</h1>
      <div class="rep-actions"><button id="exp">Esporta in un file</button><label class="btn">Importa da file<input id="imp" type="file" accept="application/json" hidden></label></div></header>
    ${list.length ? `<table class="metrics"><thead><tr><th>Persona</th><th>Data</th><th class="n">Velocità</th><th class="n">Durata</th><th></th></tr></thead><tbody>
      ${list.map((s) => `<tr><th scope="row"><a href="#report/${s.id}">${esc(s.person || 'Non indicata')}</a>${s.simulated ? ' <span class="u">simulata</span>' : ''}</th><td>${fmtDate(s.createdAt)}</td><td class="n">${s.speed ? `${esc(s.speed)} km/h` : '–'}</td><td class="n">${Math.round(s.durationS)} s</td><td class="n"><button class="quiet" data-del="${s.id}">Elimina</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Le analisi salvate compariranno qui. <a href="#home">Inizia un’analisi</a></p>'}
    <p class="fine">Le sessioni restano solo in questo browser su questo telefono. Esportale in un file per farne una copia di sicurezza o per aprirle nel programma per PC.</p></div>`;
  root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
    if (b.dataset.armed) { await deleteSession(Number(b.dataset.del)); renderArchive(root); return; }
    b.dataset.armed = '1'; b.textContent = 'Conferma eliminazione';
  }; });
  root.querySelector('#exp').onclick = async () => {
    const blob = new Blob([JSON.stringify(await allSessions())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `analisi-corsa-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  root.querySelector('#imp').onchange = async (e) => {
    const { saveSession } = await import('./store.js');
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data)) throw new Error();
      for (const s of data) if (s.id && s.views) await saveSession(s);
      renderArchive(root);
    } catch { alert('Questo file non è un archivio di Analisi Corsa.'); }
  };
}
