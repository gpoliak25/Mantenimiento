import { api, esc, num, pct, hrs, unitStatus, pmStatus } from '../ui.js';
import { hbars } from '../charts.js';

export default {
  title: 'Mantenimiento predictivo',
  crumb: 'Ciencia de datos sobre historial, kilometraje, costos y telemetría: predecir fallas y optimizar el plan',
  async render(view, _, ctx) {
    const draw = async () => {
      const d = await api('/predictive');
      if (!ctx.alive()) return;
      const high = d.rows.filter((r) => r.score >= 50).length;
      const trends = d.rows.reduce((s, r) => s + r.trends.length, 0);
      const brake = d.rows.filter((r) => r.brakeRul !== null && r.brakeRul < 5000).length;
      const recurrent = d.rows.flatMap((r) => r.recurrent.map((x) => ({ ...x, unit: r.unit })));
      const riskCls = (s) => (s >= 70 ? 'crit' : s >= 45 ? 'warn' : s >= 25 ? 'info' : 'good');
      view.innerHTML = `
        <div class="tiles">
          <div class="tile"><div class="k">Unidades con riesgo alto</div><div class="v">${high}</div><div class="d">puntaje de riesgo ≥ 50</div></div>
          <div class="tile"><div class="k">Tendencias detectadas</div><div class="v">${trends}</div><div class="d">variables que se acercan al umbral</div></div>
          <div class="tile"><div class="k">Pastillas &lt; 5.000 km</div><div class="v">${brake}</div><div class="d">vida útil restante estimada</div></div>
          <div class="tile"><div class="k">OTs predictivas y por condición</div><div class="v">${d.predictiveWo}</div><div class="d">últimos 180 días</div></div>
        </div>
        <div class="grid mt" style="grid-template-columns:minmax(0,2.4fr) minmax(0,1fr);align-items:start">
          <div class="card">
            <header><h2>Ranking de riesgo por unidad</h2><span class="sub">probabilidad estimada de falla en ruta a 30 días</span></header>
            <div class="tw"><table class="t">
              <thead><tr><th>Interno</th><th>Riesgo</th><th class="num">P(falla 30 d)</th><th>Historial</th><th class="num">Pastillas</th><th>Preventivo</th></tr></thead>
              <tbody>${d.rows.map((r) => `<tr>
                <td style="white-space:nowrap"><a href="#/flota/${r.unit.id}"><b>${esc(r.unit.unit_no)}</b></a> <span class="small muted">${r.unit.year}</span><div>${unitStatus(r.unit.status)}</div></td>
                <td style="min-width:110px"><div class="spread small"><b>${r.score}</b><span class="b ${riskCls(r.score)}">${r.score >= 70 ? 'muy alto' : r.score >= 45 ? 'alto' : r.score >= 25 ? 'medio' : 'bajo'}</span></div>
                  <div class="bar ${r.score >= 70 ? 'crit' : r.score >= 45 ? 'warn' : ''}" style="margin-top:4px"><span style="width:${r.score}%"></span></div></td>
                <td class="num">${pct(r.p30, 0)}</td><td class="small" style="white-space:nowrap">${r.corr90} correctivos · 90 d<div class="muted">${r.road180} fallas en ruta · 180 d</div></td>
                <td class="num small">${r.brakePad !== undefined && r.brakePad !== null ? `${num(r.brakePad, 1)} mm<div class="muted">~${num(r.brakeRul)} km</div>` : '—'}</td>
                <td style="white-space:nowrap">${r.pmNext ? `${esc(r.pmNext)} ${pmStatus(r.pmStatus)}` : pmStatus('OK')}</td></tr>
                ${r.recommendations.length ? `<tr><td></td><td colspan="5" class="small ink2" style="padding-top:0">${r.recommendations.slice(0, 3).map((x) => `<div>→ ${esc(x)}</div>`).join('')}</td></tr>` : ''}`).join('')}</tbody>
            </table></div>
            <div class="note mt">${esc(d.model)} El puntaje combina alertas y tendencias de sensores, vida útil de pastillas, correctivos recientes, fallas en ruta, preventivo vencido, antigüedad y fallas recurrentes.</div>
          </div>
          <div class="grid">
            <div class="card">
              <header><h2>Distancia media entre fallas por sistema</h2><span class="sub">180 días · km de flota ÷ fallas en ruta del sistema</span></header>
              ${hbars(d.systems.filter((s) => s.mdbf).sort((a, b) => a.mdbf - b.mdbf).map((s) => ({ label: s.system, value: s.mdbf, tip: `<b>${esc(s.system)}</b><div>${s.road} fallas en ruta · ${s.n} correctivos</div><div>MTTR ${hrs(s.mttr)}</div>` })), { fmt: (v) => `${num(v / 1000, 0)} mil km` })}
              <div class="small muted mt">Los sistemas con menor distancia entre fallas son candidatos a sensorizar primero.</div>
            </div>
            <div class="card">
              <header><h2>Fallas recurrentes</h2><span class="sub">candidatas a mantenimiento proactivo</span></header>
              ${recurrent.length ? `<table class="t"><tbody>${recurrent.sort((a, b) => b.count - a.count).map((x) => `<tr><td style="white-space:nowrap"><a href="#/flota/${x.unit.id}">Int. ${esc(x.unit.unit_no)}</a></td><td>${esc(x.system)}</td><td class="num">${x.count} correctivos</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Sin fallas recurrentes</div>'}
              <div class="small muted mt">≥ 3 correctivos del mismo sistema en 180 días: analizar causa raíz y actualizar el plan.</div>
            </div>
            <div class="card">
              <header><h2>Qué esperar</h2><span class="sub">referencias industriales</span></header>
              <div class="grid g3" style="gap:8px">
                <div><div class="v" style="font-size:20px;font-weight:650">18–30%</div><div class="small muted">menos costo de mantenimiento</div></div>
                <div><div class="v" style="font-size:20px;font-weight:650">30–50%</div><div class="small muted">menos paradas no planificadas</div></div>
                <div><div class="v" style="font-size:20px;font-weight:650">−43%</div><div class="small muted">horas de trabajo (MTA NYCT, piloto)</div></div>
              </div>
            </div>
          </div>
        </div>`;
    };
    await draw();
    ctx.every(10000, draw);
  },
};
