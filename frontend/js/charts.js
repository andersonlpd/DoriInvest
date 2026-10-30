import {S} from './store.js';
import {investedSeries} from './calc.js';
import {money, dateLabel, compactMoney} from './dom.js';

function drawLine(items, mode) {
  const chart = document.getElementById('history-chart'),
    status = document.getElementById('history-status');
  const times = items.map(item => Date.parse(item.date)),
    start = Math.min(...times),
    duration = Math.max(...times) - start,
    min = Math.min(...items.map(item => item.value)),
    max = Math.max(...items.map(item => item.value)),
    range = max - min || 1,
    points = items.map((item, index) => [(duration ? (times[index] - start) / duration : index / (items.length - 1)) * 700, 170 - (item.value - min) / range * 140]),
    path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  document.getElementById('chart-line').setAttribute('d', path);
  document.getElementById('chart-area').setAttribute('d', `${path} L700 180 L0 180Z`);
  document.getElementById('chart-dot').setAttribute('cx', String(points.at(-1)[0]));
  document.getElementById('chart-dot').setAttribute('cy', String(points.at(-1)[1]));
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

const benchmarkCache = new Map();
let performanceToken = null;

function lastAtOrBefore(series, day) {
  let found = null;
  for (const point of series) {
    if (point.date <= day) found = point;
    else break;
  }
  return found;
}

function percent(value) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + (value * 100).toLocaleString('pt-BR', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + '%';
}

function clearPerformance(message) {
  const chart = document.getElementById('performance-chart'),
    empty = document.getElementById('performance-empty'),
    legend = document.getElementById('performance-legend'),
    value = document.getElementById('performance-value'),
    status = document.getElementById('performance-status'),
    start = document.getElementById('performance-start'),
    end = document.getElementById('performance-end'),
    vaxis = document.getElementById('performance-vaxis');
  if (!chart) return;
  ['performance-line-portfolio', 'performance-line-ibov', 'performance-line-cdi'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.setAttribute('d', '');
      element.style.display = 'none';
    }
  });
  chart.hidden = true;
  if (vaxis) vaxis.replaceChildren();
  if (legend) legend.hidden = true;
  if (value) value.textContent = '—';
  if (status) status.textContent = message;
  if (empty) {
    empty.hidden = false;
    empty.textContent = message;
  }
  if (start) start.textContent = '—';
  if (end) end.textContent = '—';
}

function setPerformanceLegend(entries) {
  const legend = document.getElementById('performance-legend');
  if (!legend) return;
  legend.hidden = false;
  const portfolio = legend.querySelector('.portfolio');
  if (portfolio) portfolio.textContent = 'Carteira ' + percent(entries.find(entry => entry.key === 'portfolio')?.change);
  ['ibov', 'cdi'].forEach(key => {
    const item = legend.querySelector('[data-legend="' + key + '"]');
    if (!item) return;
    const entry = entries.find(item2 => item2.key === key);
    item.hidden = !entry;
    if (entry) item.textContent = entry.label + ' ' + percent(entry.change);
  });
}

async function renderPerformance(items) {
  const chart = document.getElementById('performance-chart'),
    empty = document.getElementById('performance-empty'),
    value = document.getElementById('performance-value'),
    status = document.getElementById('performance-status'),
    start = document.getElementById('performance-start'),
    end = document.getElementById('performance-end'),
    vaxis = document.getElementById('performance-vaxis');
  if (!chart) return;
  if (!items || items.length < 2) {
    clearPerformance('O comparativo aparece após dois snapshots de patrimônio.');
    return;
  }
  const first = items[0],
    startDay = String(items[0].date).slice(0, 10),
    endDay = String(items.at(-1).date).slice(0, 10),
    token = startDay + ':' + endDay;
  performanceToken = token;
  const portfolio = items.map(item => ({date: item.date, value: item.value / first.value - 1}));
  let data = benchmarkCache.get(token);
  if (!data) {
    try {
      const response = await fetch('/api/benchmarks?start=' + startDay + '&end=' + endDay);
      if (response.ok) {
        data = await response.json();
        benchmarkCache.set(token, data);
      }
    } catch {
      data = null;
    }
  }
  if (performanceToken !== token) return;
  const benchmarks = [];
  for (const [key, id, label] of [['ibov', 'performance-line-ibov', 'Ibovespa'], ['cdi', 'performance-line-cdi', 'CDI']]) {
    const series = data?.series?.[key];
    if (!Array.isArray(series) || !series.length) continue;
    const base = lastAtOrBefore(series, startDay) || series.find(point => point.date >= startDay);
    if (!base || !base.value) continue;
    const points = items.map(item => {
      const day = String(item.date).slice(0, 10),
        reference = lastAtOrBefore(series, day) || series.find(point => point.date >= day);
      return reference ? {date: item.date, value: reference.value / base.value - 1} : null;
    }).filter(Boolean);
    if (points.length >= 2) benchmarks.push({key, id, label, points});
  }
  const allSeries = [portfolio, ...benchmarks.map(benchmark => benchmark.points)],
    values = allSeries.flatMap(series => series.map(point => point.value)).concat(0),
    min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1,
    firstTime = Date.parse(items[0].date),
    duration = Date.parse(items.at(-1).date) - firstTime,
    xFor = date => duration ? (Date.parse(date) - firstTime) / duration * 700 : 0,
    yFor = value => 170 - (value - min) / range * 140,
    buildPath = points => points.map((point, index) => `${index ? 'L' : 'M'}${xFor(point.date).toFixed(1)} ${yFor(point.value).toFixed(1)}`).join(' '),
    setPath = (id, points) => {
      const element = document.getElementById(id);
      if (!element) return;
      if (!points || points.length < 2) {
        element.setAttribute('d', '');
        element.style.display = 'none';
        return;
      }
      element.setAttribute('d', buildPath(points));
      element.style.display = '';
    };
  setPath('performance-line-portfolio', portfolio);
  benchmarks.forEach(benchmark => setPath(benchmark.id, benchmark.points));
  if (!benchmarks.some(benchmark => benchmark.key === 'ibov')) setPath('performance-line-ibov', null);
  if (!benchmarks.some(benchmark => benchmark.key === 'cdi')) setPath('performance-line-cdi', null);
  document.getElementById('performance-zero').setAttribute('d', `M0 ${yFor(0).toFixed(1)}H700`);
  chart.removeAttribute('hidden');
  empty.hidden = true;
  value.textContent = percent(portfolio.at(-1).value);
  status.textContent = items.length + ' snapshots · sem ajuste de aportes' + (benchmarks.length ? '' : ' · benchmarks indisponíveis');
  start.textContent = dateLabel(items[0].date);
  end.textContent = dateLabel(items.at(-1).date);
  vaxis.replaceChildren();
  [35, 80, 125, 170].forEach(y => {
    const span = document.createElement('span');
    span.style.top = (y / 190 * 100).toFixed(2) + '%';
    span.textContent = percent(max - (y - 35) / 135 * (max - min));
    vaxis.append(span);
  });
  setPerformanceLegend([{key: 'portfolio', change: portfolio.at(-1).value}, ...benchmarks.map(benchmark => ({key: benchmark.key, label: benchmark.label, change: benchmark.points.at(-1).value}))]);
}

function renderHistory() {
  const chart = document.getElementById('history-chart'),
    empty = document.getElementById('history-empty'),
    status = document.getElementById('history-status'),
    value = document.getElementById('history-value'),
    title = document.getElementById('history-title'),
    subtitle = document.getElementById('history-subtitle'),
    items = S.marketSnapshots.filter(item => Number.isFinite(item.value)).slice(-365);
  if (items.length < 2) {
    const series = investedSeries(),
      vaxis = document.getElementById('chart-vaxis');
    if (vaxis) vaxis.replaceChildren();
    clearPerformance('O comparativo aparece após dois snapshots de patrimônio.');
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
  renderPerformance(items);
}

export {drawLine, renderHistory};
