import {S} from '../store.js';
import {money,compactMoney} from '../dom.js';
function renderUpcoming() {
  const today = new Date().toISOString().slice(0, 10),
    future = S.transactions.filter(t => t.type === 'Provento' && t.date && t.date > today).sort((a, b) => a.date.localeCompare(b.date));
  for (const id of ['upcoming-list', 'dividend-calendar']) {
    const root = document.getElementById(id);
    root.replaceChildren();
    if (!future.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nenhum provento futuro informado.';
      root.append(empty);
      continue;
    }
    future.forEach(tx => {
      const row = document.createElement('div');
      row.className = 'dividend-row';
      const left = document.createElement('div');
      left.className = 'dividend-left';
      const date = new Date(tx.date + 'T12:00:00'),
        chip = document.createElement('div');
      chip.className = 'date-chip';
      chip.append(Object.assign(document.createElement('strong'), {
        textContent: String(date.getDate())
      }), document.createTextNode(date.toLocaleDateString('pt-BR', {
        month: 'short'
      }).toUpperCase()));
      const text = document.createElement('div'),
        ticker = document.createElement('strong'),
        label = document.createElement('small');
      ticker.textContent = tx.ticker;
      label.textContent = 'Provento informado';
      text.append(ticker, label);
      left.append(chip, text);
      const amount = document.createElement('span');
      amount.className = 'dividend-amount';
      amount.textContent = money(tx.amount);
      row.append(left, amount);
      root.append(row);
    });
  }
}
function renderMonthlyDividends() {
  const root = document.getElementById('dividend-month-chart'),
    now = new Date(),
    months = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'),
      label: date.toLocaleDateString('pt-BR', {month: 'short'}).replace('.', '').toUpperCase(),
      value: 0
    });
  }
  S.transactions.filter(t => t.type === 'Provento' && t.date && t.date <= now.toISOString().slice(0, 10)).forEach(tx => {
    const month = months.find(m => m.key === tx.date.slice(0, 7));
    if (month) month.value += Number(tx.amount) || 0;
  });
  root.replaceChildren();
  const max = Math.max(...months.map(m => m.value));
  if (!max) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nenhum provento registrado nos últimos 12 meses.';
    root.append(empty);
    return;
  }
  const plot = document.createElement('div');
  plot.className = 'dividend-plot';
  const grid = document.createElement('div');
  grid.className = 'dividend-grid';
  for (let step = 0; step <= 4; step++) {
    const line = document.createElement('div');
    line.className = 'dividend-grid-line';
    line.style.bottom = (step * 25) + '%';
    const label = document.createElement('span');
    label.textContent = step ? compactMoney(max * step / 4) : '0';
    line.append(label);
    grid.append(line);
  }
  const bars = document.createElement('div');
  bars.className = 'dividend-bars';
  months.forEach(month => {
    const column = document.createElement('div');
    column.className = 'bar-col';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.setProperty('--h', month.value / max * 100 + '%');
    bar.title = month.label + ': ' + money(month.value);
    column.append(bar);
    bars.append(column);
  });
  const labels = document.createElement('div');
  labels.className = 'dividend-labels';
  months.forEach(month => {
    const label = document.createElement('span');
    label.textContent = month.label;
    labels.append(label);
  });
  plot.append(grid, bars);
  root.append(plot, labels);
}

export {renderUpcoming,renderMonthlyDividends};
