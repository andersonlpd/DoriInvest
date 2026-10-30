import {S} from '../store.js';
import {money, compactMoney, number, notify} from '../dom.js';
import {INDICATOR_HELP} from '../help.js';

let compareRows = null;

function marketCap(row) {
  return row.patrim && row.pvp > 0 ? row.patrim * row.pvp : null;
}

const METRICS = [
  ['Cotação', row => row.quote ? money(row.quote) : '—'],
  ['P/L', row => row.pl ? row.pl.toLocaleString('pt-BR', {maximumFractionDigits: 1}) : '—'],
  ['P/VP', row => row.pvp ? row.pvp.toLocaleString('pt-BR', {maximumFractionDigits: 2}) : '—'],
  ['P/SR', row => row.psr ? row.psr.toLocaleString('pt-BR', {maximumFractionDigits: 2}) : '—'],
  ['DY (12m)', row => row.dy ? (row.dy * 100).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%' : '—'],
  ['ROE', row => row.roe == null ? '—' : row.roe.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'],
  ['ROIC', row => row.roic == null ? '—' : row.roic.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'],
  ['Liquidez média (2m)', row => row.liq2m ? compactMoney(row.liq2m) : '—'],
  ['Patrimônio líquido', row => row.patrim ? compactMoney(row.patrim) : '—'],
  ['Valor de mercado (aprox.)', row => marketCap(row) ? compactMoney(marketCap(row)) : '—'],
  ['Setor', row => row.setor || '—'],
  ['Segmento', row => row.segmento || '—']
];

const CRITERIA = [
  {label: 'P/L', weight: 2, direction: 'lower', get: row => row.pl > 0 ? row.pl : null, format: value => value.toLocaleString('pt-BR', {maximumFractionDigits: 1})},
  {label: 'P/VP', weight: 2, direction: 'lower', get: row => row.pvp > 0 ? row.pvp : null, format: value => value.toLocaleString('pt-BR', {maximumFractionDigits: 2})},
  {label: 'DY (12m)', weight: 2, direction: 'higher', get: row => row.dy != null ? row.dy : null, format: value => (value * 100).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'},
  {label: 'ROE', weight: 2, direction: 'higher', get: row => row.roe != null ? row.roe : null, format: value => value.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'},
  {label: 'ROIC', weight: 1.5, direction: 'higher', get: row => row.roic != null ? row.roic : null, format: value => value.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'},
  {label: 'Margem líquida', weight: 1.5, direction: 'higher', get: row => row.margem != null ? row.margem : null, format: value => value.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%'},
  {label: 'Liquidez média (2m)', weight: 0.5, direction: 'higher', get: row => row.liq2m > 0 ? row.liq2m : null, format: value => compactMoney(value)}
];

function compareVerdict(rowA, rowB) {
  let pointsA = 0,
    pointsB = 0;
  const advantagesA = [],
    advantagesB = [];
  CRITERIA.forEach(criterion => {
    const valueA = criterion.get(rowA),
      valueB = criterion.get(rowB);
    if (valueA == null && valueB == null) return;
    const weight = criterion.weight;
    if (valueA == null || valueB == null) {
      const entry = {label: criterion.label, text: (valueA != null ? criterion.format(valueA) : criterion.format(valueB)) + ' do outro ativo sem dado comparável', points: weight};
      if (valueA != null) {
        pointsA += weight;
        advantagesA.push(entry);
      } else {
        pointsB += weight;
        advantagesB.push(entry);
      }
      return;
    }
    if (Math.abs(valueA - valueB) < 1e-9) {
      pointsA += weight / 2;
      pointsB += weight / 2;
      return;
    }
    const betterIsA = criterion.direction === 'lower' ? valueA < valueB : valueA > valueB;
    const entry = {label: criterion.label, text: criterion.format(valueA) + ' contra ' + criterion.format(valueB), points: weight};
    if (betterIsA) {
      pointsA += weight;
      advantagesA.push(entry);
    } else {
      pointsB += weight;
      advantagesB.push({...entry, text: criterion.format(valueB) + ' contra ' + criterion.format(valueA)});
    }
  });
  const total = CRITERIA.reduce((sum, criterion) => sum + criterion.weight, 0);
  const pctA = Math.round(pointsA / total * 100),
    pctB = Math.round(pointsB / total * 100);
  return {pctA, pctB, winner: pctA === pctB ? null : pctA > pctB ? 'A' : 'B', advantagesA, advantagesB};
}

function renderVerdict(verdict, tickerA, tickerB) {
  const box = document.getElementById('compare-verdict'),
    title = document.getElementById('compare-verdict-title'),
    subtitle = document.getElementById('compare-verdict-subtitle'),
    tooltip = document.getElementById('compare-verdict-tooltip'),
    headA = document.getElementById('compare-head-a'),
    headB = document.getElementById('compare-head-b');
  if (!box) return;
  headA.classList.toggle('compare-winner', verdict.winner === 'A');
  headB.classList.toggle('compare-winner', verdict.winner === 'B');
  if (!verdict.pctA && !verdict.pctB) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const winnerTicker = verdict.winner === 'A' ? tickerA : verdict.winner === 'B' ? tickerB : null,
    loserTicker = verdict.winner === 'A' ? tickerB : verdict.winner === 'B' ? tickerA : null;
  title.textContent = winnerTicker ? winnerTicker + ' vence ' + loserTicker + ' por ' + Math.max(verdict.pctA, verdict.pctB) + ' a ' + Math.min(verdict.pctA, verdict.pctB) : 'Empate técnico entre ' + tickerA + ' e ' + tickerB;
  subtitle.textContent = 'Placar da análise fundamentalista. Passe o mouse ou use Tab para ver os motivos.';
  tooltip.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = winnerTicker ? 'Por que ' + winnerTicker + ' ganha' : 'Critérios que separaram pouco';
  tooltip.append(heading);
  const advantages = verdict.winner === 'B' ? verdict.advantagesB : verdict.advantagesA;
  if (!advantages.length) {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Nenhum critério com dados suficientes para separar os ativos.';
    tooltip.append(paragraph);
  }
  advantages.slice(0, 8).forEach(item => {
    const row = document.createElement('div');
    row.className = 'verdict-reason';
    const label = document.createElement('strong');
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.textContent = item.text + ' · ' + item.points + (item.points === 1 ? ' ponto' : ' pontos');
    row.append(label, detail);
    tooltip.append(row);
  });
  const footer = document.createElement('p');
  footer.className = 'verdict-foot';
  footer.textContent = 'Soma dos critérios disponíveis: P/L, P/VP, DY, ROE, ROIC, margem líquida e liquidez. Não é recomendação de compra ou venda.';
  tooltip.append(footer);
}

function positionFor(ticker) {
  const position = S.positions.find(p => p.ticker === ticker && p.quantity > 0);
  if (!position) return null;
  const basis = position.costBasisKnown !== false && Number.isFinite(position.averagePrice),
    price = Number.isFinite(position.currentPrice) && position.currentPrice > 0 ? position.currentPrice : null;
  return {
    quantity: position.quantity,
    average: basis ? position.averagePrice : null,
    price,
    result: basis && price ? (price - position.averagePrice) * position.quantity : null
  };
}

function renderCompare() {
  const selectA = document.getElementById('compare-a'),
    selectB = document.getElementById('compare-b'),
    body = document.getElementById('compare-body'),
    empty = document.getElementById('compare-empty'),
    note = document.getElementById('compare-note');
  if (!selectA || !selectB || !body) return;
  const tickerA = selectA.value,
    tickerB = selectB.value,
    rowA = (compareRows || []).find(row => row.ticker === tickerA),
    rowB = (compareRows || []).find(row => row.ticker === tickerB);
  if (!rowA || !rowB || tickerA === tickerB) {
    body.replaceChildren();
    empty.hidden = false;
    empty.textContent = tickerA && tickerA === tickerB ? 'Escolha dois ativos diferentes.' : 'Escolha dois ativos e clique em Comparar.';
    document.getElementById('compare-head-a').textContent = 'Ativo A';
    document.getElementById('compare-head-b').textContent = 'Ativo B';
    document.getElementById('compare-head-a').classList.remove('compare-winner');
    document.getElementById('compare-head-b').classList.remove('compare-winner');
    const box = document.getElementById('compare-verdict');
    if (box) box.hidden = true;
    note.textContent = '';
    return;
  }
  empty.hidden = true;
  document.getElementById('compare-head-a').textContent = tickerA;
  document.getElementById('compare-head-b').textContent = tickerB;
  body.replaceChildren();
  METRICS.forEach(([label, format]) => {
    const tr = document.createElement('tr');
    const head = document.createElement('td');
    head.textContent = label;
    if (INDICATOR_HELP[label]) head.title = INDICATOR_HELP[label];
    const first = document.createElement('td');
    first.textContent = format(rowA);
    const second = document.createElement('td');
    second.textContent = format(rowB);
    tr.append(head, first, second);
    body.append(tr);
  });
  const posA = positionFor(tickerA),
    posB = positionFor(tickerB);
  if (posA || posB) {
    const personal = [
      ['Na minha carteira', position => position ? number(position.quantity) : '—'],
      ['Meu custo médio', position => position && position.average != null ? money(position.average) : '—'],
      ['Meu preço atual', position => position && position.price != null ? money(position.price) : '—'],
      ['Meu resultado aberto', position => position && position.result != null ? (position.result >= 0 ? '+' : '') + money(position.result) : '—']
    ];
    personal.forEach(([label, format]) => {
      const tr = document.createElement('tr');
      const head = document.createElement('td');
      head.textContent = label;
      const first = document.createElement('td');
      first.textContent = format(posA);
      const second = document.createElement('td');
      second.textContent = format(posB);
      tr.append(head, first, second);
      body.append(tr);
    });
  }
  renderVerdict(compareVerdict(rowA, rowB), tickerA, tickerB);
  note.textContent = 'Fundamentos do Fundamentus com defasagem de até 6 h; classificação setorial da B3. Números aproximados, não são recomendação.';
}

async function loadCompareRows() {
  if (compareRows) return compareRows;
  const response = await fetch('/api/rankings'),
    data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha ao carregar dados de mercado.');
  compareRows = data.rows || [];
  const selects = [document.getElementById('compare-a'), document.getElementById('compare-b')];
  selects.forEach(select => {
    if (!select || select.options.length > 1) return;
    [...compareRows].sort((a, b) => a.ticker.localeCompare(b.ticker)).forEach(row => {
      const option = document.createElement('option');
      option.value = row.ticker;
      option.textContent = (row.ticker + ' · ' + (row.name || row.setor || '')).slice(0, 46);
      select.append(option);
    });
  });
  return compareRows;
}

document.getElementById('compare-run')?.addEventListener('click', () => {
  loadCompareRows().then(renderCompare).catch(error => notify(error.message || 'Não carregou os dados do comparador.'));
});

['compare-a', 'compare-b'].forEach(id => {
  const select = document.getElementById(id);
  if (!select) return;
  select.addEventListener('focus', () => loadCompareRows().catch(() => {}));
  select.addEventListener('change', () => {
    if (document.getElementById('compare-a').value && document.getElementById('compare-b').value) renderCompare();
  });
});

export {renderCompare, loadCompareRows};
