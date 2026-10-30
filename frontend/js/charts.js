import {S} from './store.js';
import {investedSeries} from './calc.js';
import {money,dateLabel,compactMoney} from './dom.js';
function drawLine(items, mode, extras = []) {
  const chart = document.getElementById('history-chart'),
    status = document.getElementById('history-status');
  const times = items.map(s => Date.parse(s.date)),
    start = Math.min(...times),
    duration = Math.max(...times) - start;
  const allValues = items.map(s => s.value).concat(...extras.map(extra => extra.points.map(point => point.value)));
  const min = Math.min(...allValues),
    max = Math.max(...allValues),
    range = max - min || 1;
  const xFor = date => duration ? (Date.parse(date) - start) / duration * 700 : 0;
  const yFor = value => 170 - (value - min) / range * 140;
  const points = items.map((s, i) => [duration ? xFor(s.date) : (i / (items.length - 1)) * 700, yFor(s.value)]),
    path = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  document.getElementById('chart-line').setAttribute('d', path);
  document.getElementById('chart-area').setAttribute('d', `${path} L700 180 L0 180Z`);
  document.getElementById('chart-dot').setAttribute('cx', String(points.at(-1)[0]));
  document.getElementById('chart-dot').setAttribute('cy', String(points.at(-1)[1]));
  ['chart-line-ibov', 'chart-line-cdi'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.setAttribute('d', '');
      element.style.display = 'none';
    }
  });
  extras.forEach(extra => {
    const element = document.getElementById(extra.id);
    if (!element || extra.points.length < 2) return;
    const extraPath = extra.points.map((point, index) => `${index ? 'L' : 'M'}${xFor(point.date).toFixed(1)} ${yFor(point.value).toFixed(1)}`).join(' ');
    element.setAttribute('d', extraPath);
    element.style.display = '';
  });
  chart.removeAttribute('hidden');
  document.getElementById('history-empty').hidden = true;
  status.textContent = mode === 'snapshots' ? `${items.length} snapshots · patrimônio observado` : `Capital líquido registrado (aportes − resgates) · ${items.length} datas`;
  document.getElementById('history-start').textContent = dateLabel(items[0].date);
  document.getElementById('history-end').textContent = dateLabel(items.at(-1).date);
  const vaxis = document.getElementById('chart-vaxis');
  vaxis.replaceChildren();
  [35, 80, 125, 170].forEach(y => {
    const span = document.createElement('span');
    span.style.top = (y / 190 * 100).toFixed(2) + '%';
    span.textContent = compactMoney(max - (y - 35) / 135 * (max - min));
    vaxis.append(span);
  });
}
let benchmarkToken = null;
const benchmarkCache = new Map();
function lastAtOrBefore(series, day) {
  let found = null;
  for (const point of series) {
    if (point.date <= day) found = point;
    else break;
  }
  return found;
}
function setLegend(entries) {
  const legend = document.getElementById('chart-legend');
  if (!legend) return;
  legend.hidden = !entries.length;
  ['ibov', 'cdi'].forEach(key => {
    const item = legend.querySelector('[data-legend="' + key + '"]');
    if (!item) return;
    const entry = entries.find(e => e.key === key);
    item.hidden = !entry;
    if (entry) item.textContent = entry.label + ' ' + (entry.change >= 0 ? '+' : '') + (entry.change * 100).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%';
  });
}
async function drawBenchmarks(items) {
  if (items.length < 2) {
    setLegend([]);
    return;
  }
  const start = String(items[0].date).slice(0, 10),
    end = String(items.at(-1).date).slice(0, 10),
    token = start + ':' + end;
  benchmarkToken = token;
  try {
    let data = benchmarkCache.get(token);
    if (!data) {
      const response = await fetch('/api/benchmarks?start=' + start + '&end=' + end);
      if (!response.ok) return;
      data = await response.json();
      benchmarkCache.set(token, data);
    }
    if (benchmarkToken !== token) return;
    const extras = [],
      legend = [];
    for (const [key, id, label] of [['ibov', 'chart-line-ibov', 'Ibovespa'], ['cdi', 'chart-line-cdi', 'CDI']]) {
      const series = data.series?.[key];
      if (!Array.isArray(series) || !series.length) continue;
      const base = lastAtOrBefore(series, start) || series.find(point => point.date >= start);
      if (!base || !base.value) continue;
      const scale = items[0].value / base.value,
        points = items.map(item => {
          const day = String(item.date).slice(0, 10),
            reference = lastAtOrBefore(series, day) || series.find(point => point.date >= day);
          return reference ? {date: item.date, value: reference.value * scale} : null;
        }).filter(Boolean);
      if (points.length < 2) continue;
      extras.push({id, points});
      legend.push({key, label, change: points.at(-1).value / points[0].value - 1});
    }
    if (!extras.length) {
      setLegend([]);
      return;
    }
    drawLine(items, 'snapshots', extras);
    setLegend(legend);
    const status = document.getElementById('history-status');
    status.textContent += ' · comparativo normalizado no início da série';
  } catch {
    setLegend([]);
  }
}
function renderHistory() {
  const chart = document.getElementById('history-chart'),
    empty = document.getElementById('history-empty'),
    status = document.getElementById('history-status'),
    value = document.getElementById('history-value'),
    title = document.getElementById('history-title'),
    subtitle = document.getElementById('history-subtitle'),
    items = S.marketSnapshots.filter(s => Number.isFinite(s.value)).slice(-365);
  if (items.length < 2) {
    const series = investedSeries();
    const vaxis = document.getElementById('chart-vaxis');
    if (vaxis) vaxis.replaceChildren();
    setLegend([]);
    if (series.length >= 2) {
      title.textContent = 'Capital investido registrado';
      subtitle.textContent = 'Linha do tempo derivada das movimentações de compra e venda. Para ver o patrimônio observado, importe os consolidados em "Importar B3" e clique em Aplicar importação.';
      drawLine(series, 'invested');
      value.textContent = money(series.at(-1).value);
      return;
    }
  }
  title.textContent = 'Patrimônio observado';
  subtitle.textContent = 'Snapshots registrados nas atualizações de dados';
  value.textContent = items.length ? money(items.at(-1).value) : '—';
  if (items.length < 2) {
    chart.hidden = true;
    empty.hidden = false;
    empty.textContent = items.length ? 'Um snapshot registrado. Atualize os preços em outro dia para comparar.' : 'Atualize cotações ou importe um XLSX da B3 para iniciar o histórico.';
    status.textContent = items.length ? '1 snapshot' : 'Sem histórico';
    document.getElementById('history-start').textContent = items.length ? dateLabel(items[0].date) : '—';
    document.getElementById('history-end').textContent = '—';
    return;
  }
  drawLine(items, 'snapshots');
  drawBenchmarks(items);
}

export {drawLine,renderHistory};
