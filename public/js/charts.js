// Gráficos SVG livianos: líneas con crosshair, columnas, barras horizontales y sparklines.
import { esc, showTip, hideTip } from './ui.js';

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

const observers = new WeakMap();
function responsive(el, draw) {
  draw();
  if (observers.has(el)) observers.get(el).disconnect();
  let w = el.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 4) { w = el.clientWidth; draw(); } });
  ro.observe(el);
  observers.set(el, ro);
}

// series: [{ name, color, values: [number|null] }], labels: [string]
export function lineChart(el, { series, labels, yFmt = (v) => v, height = 220, yMin, yMax, refs = [], legend = true, area = false }) {
  el.classList.add('chart');
  const draw = () => {
    const W = Math.max(el.clientWidth, 280), H = height;
    const m = { l: 48, r: 14, t: 12, b: 26 };
    const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
    refs.forEach((r) => all.push(r.y));
    const { lo, hi, ticks } = niceTicks(yMin ?? Math.min(...all), yMax ?? Math.max(...all));
    const n = labels.length;
    const x = (i) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const every = Math.ceil(n / Math.max(2, Math.floor((W - m.l) / 70)));
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(series.map((x) => x.name).join(', '))}">`;
    ticks.forEach((t) => { s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`; });
    labels.forEach((l, i) => { if ((i % every === 0 && n - 1 - i >= every * 0.6) || i === n - 1) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(l)}</text>`; });
    refs.forEach((r) => { s += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(r.y)}" y2="${y(r.y)}"/><text class="ref-t" x="${W - m.r}" y="${y(r.y) - 5}" text-anchor="end">${esc(r.label)}</text>`; });
    series.forEach((se) => {
      let d = '';
      se.values.forEach((v, i) => { if (v === null || v === undefined) return; d += `${d && se.values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
      if (area && series.length === 1) s += `<path d="${d}L${x(n - 1)},${y(lo)}L${x(0)},${y(lo)}Z" fill="${se.color}" opacity=".10"/>`;
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    s += `<g class="hover" style="display:none"><line class="xh" y1="${m.t}" y2="${H - m.b}"/>${series.map((se) => `<circle r="4.5" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`).join('')}</g>`;
    s += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/></svg>`;
    if (legend && series.length > 1) s += `<div class="legend">${series.map((se) => `<span><i class="line" style="background:${se.color}"></i>${esc(se.name)}</span>`).join('')}</div>`;
    el.innerHTML = s;
    const svg = el.querySelector('svg');
    const g = svg.querySelector('.hover');
    svg.querySelector('.hit').addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
      g.style.display = '';
      g.querySelector('line').setAttribute('x1', x(i));
      g.querySelector('line').setAttribute('x2', x(i));
      g.querySelectorAll('circle').forEach((c, k) => {
        const v = series[k].values[i];
        c.style.display = v == null ? 'none' : '';
        if (v != null) { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(v)); }
      });
      showTip(`<b>${esc(labels[i])}</b>${series.map((se) => `<div class="r"><span><i style="background:${se.color}"></i>${esc(se.name)}</span><b>${se.values[i] == null ? '—' : esc(yFmt(se.values[i]))}</b></div>`).join('')}`, e.clientX, e.clientY);
    });
    svg.querySelector('.hit').addEventListener('mouseleave', () => { g.style.display = 'none'; hideTip(); });
  };
  responsive(el, draw);
}

// Columnas verticales: items [{ label, value, color?, tip? }]
export function columnChart(el, { items, yFmt = (v) => v, height = 200, refs = [], color = 'var(--s1)' }) {
  el.classList.add('chart');
  const draw = () => {
    const W = Math.max(el.clientWidth, 260), H = height;
    const m = { l: 48, r: 10, t: 16, b: 26 };
    const vals = items.map((i) => i.value || 0).concat(refs.map((r) => r.y));
    const { hi, ticks } = niceTicks(0, Math.max(...vals, 1));
    const lo = 0;
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const bw = (W - m.l - m.r) / items.length;
    const barW = Math.min(46, bw - 8);
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">`;
    ticks.forEach((t) => { s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`; });
    items.forEach((it, i) => {
      const cx = m.l + bw * i + bw / 2;
      const v = it.value || 0;
      const top = y(v), base = y(0);
      const r = Math.min(4, (base - top) / 2);
      const x0 = cx - barW / 2, x1 = cx + barW / 2;
      const tip = it.tip || `<b>${esc(it.label)}</b><div>${esc(yFmt(v))}</div>`;
      if (it.value !== null && it.value !== undefined) {
        s += `<path d="M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z" fill="${it.color || color}" ${it.faded ? 'opacity=".45"' : ''}/>`;
      }
      s += `<rect x="${cx - bw / 2}" y="${m.t}" width="${bw}" height="${H - m.t - m.b}" fill="transparent" data-tip="${esc(tip)}"/>`;
      s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(it.label)}</text>`;
    });
    s += `<line class="ax" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    refs.forEach((r) => { s += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(r.y)}" y2="${y(r.y)}"/><text class="ref-t" x="${W - m.r}" y="${y(r.y) - 5}" text-anchor="end">${esc(r.label)}</text>`; });
    el.innerHTML = s + '</svg>';
  };
  responsive(el, draw);
}

// Barras horizontales (HTML): items [{ label, value, color?, cls?, tip?, text? }]
export function hbars(items, { fmt = (v) => v, max } = {}) {
  const mx = max || Math.max(...items.map((i) => i.value || 0), 1);
  return `<div class="hbars">${items.map((it) => `
    <div class="hbar ${it.cls || ''}" data-tip="${esc(it.tip || `<b>${esc(it.label)}</b><div>${esc(fmt(it.value))}</div>`)}">
      <span class="lab">${esc(it.label)}</span>
      <span class="track"><span class="fill" style="display:block;width:${Math.max(0.5, ((it.value || 0) / mx) * 100)}%;${it.color ? `background:${it.color}` : ''}"></span></span>
      <span class="val">${esc(it.text ?? fmt(it.value))}</span>
    </div>`).join('')}</div>`;
}

// Sparkline con umbral de advertencia
export function sparkline(values, { warn, crit, dir = 'up', w = 86, h = 20, level = 'ok' } = {}) {
  if (!values || values.length < 2) return '';
  const lo0 = Math.min(...values), hi0 = Math.max(...values);
  const lo = Math.min(lo0, dir === 'down' ? warn : lo0), hi = Math.max(hi0, dir === 'up' ? warn : hi0);
  const pad = (hi - lo) * 0.08 || 1;
  const y = (v) => h - 2 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (h - 4);
  const x = (i) => (i / (values.length - 1)) * (w - 2) + 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const color = level === 'crit' ? 'var(--critical)' : level === 'warn' ? 'var(--s4)' : 'var(--s1)';
  void crit;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${y(warn)}" y2="${y(warn)}" stroke="var(--axis)" stroke-dasharray="3 3"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}
