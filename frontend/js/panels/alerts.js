import {S, persist} from '../store.js';
import {money, notify} from '../dom.js';

const uid = () => globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());

function priceFor(ticker) {
  const position = S.positions.find(p => p.ticker === ticker && Number.isFinite(p.currentPrice) && p.currentPrice > 0);
  if (position) return {price: Number(position.currentPrice), source: 'posição', at: position.quoteTime};
  const watch = S.watchQuotes?.[ticker];
  if (watch && Number.isFinite(Number(watch.price)) && Number(watch.price) > 0) return {price: Number(watch.price), source: 'watchlist', at: watch.quoteTime};
  return null;
}

function evaluateAlerts() {
  const triggered = [];
  S.alerts.forEach(alert => {
    if (alert.triggeredAt) return;
    const quote = priceFor(alert.ticker);
    if (!quote) return;
    const hit = alert.direction === 'acima' ? quote.price >= alert.price : quote.price <= alert.price;
    if (!hit) return;
    alert.triggeredAt = new Date().toISOString();
    alert.triggeredPrice = quote.price;
    triggered.push(alert.ticker);
  });
  if (triggered.length) {
    persist();
    notify('Alerta atingido: ' + triggered.join(', ') + '.');
  }
  return triggered.length;
}

function alertRow(alert) {
  const row = document.createElement('div');
  row.className = 'activity-row alert-row';
  const left = document.createElement('span');
  left.className = 'activity-date';
  left.textContent = alert.triggeredAt ? 'atingido' : 'aguardando';
  const action = document.createElement('span');
  action.className = 'activity-action';
  const title = document.createElement('strong');
  title.textContent = alert.ticker;
  const detail = document.createElement('small');
  detail.textContent = (alert.direction === 'acima' ? 'Acima de ' : 'Abaixo de ') + money(alert.price);
  action.append(title, detail);
  const quote = priceFor(alert.ticker);
  const current = document.createElement('span');
  current.className = 'activity-value';
  current.textContent = quote ? money(quote.price) : 'sem preço';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-link';
  remove.dataset.alertRemove = alert.id;
  remove.textContent = 'Remover';
  row.append(left, action, current, remove);
  return row;
}

function renderAlerts() {
  const list = document.getElementById('alert-list'),
    empty = document.getElementById('alert-empty');
  if (!list) return;
  list.replaceChildren();
  empty.hidden = !!S.alerts.length;
  S.alerts.slice().sort((a, b) => (a.triggeredAt ? 1 : 0) - (b.triggeredAt ? 1 : 0)).forEach(alert => list.append(alertRow(alert)));
}

document.getElementById('alert-add')?.addEventListener('click', () => {
  const input = document.getElementById('alert-ticker'),
    ticker = input.value.trim().toUpperCase(),
    direction = document.getElementById('alert-direction').value === 'abaixo' ? 'abaixo' : 'acima',
    price = Number(document.getElementById('alert-price').value);
  if (!/^[A-Z0-9]{4,8}$/.test(ticker)) return notify('Informe um ticker da B3 (ex.: PETR4, KNCR11).');
  if (!Number.isFinite(price) || price <= 0) return notify('Informe um preço maior que zero.');
  input.value = '';
  document.getElementById('alert-price').value = '';
  S.alerts = [...S.alerts, {id: uid(), ticker, direction, price, createdAt: new Date().toISOString()}].slice(-50);
  if (!persist()) return;
  evaluateAlerts();
  renderAlerts();
  notify('Alerta criado para ' + ticker + '.');
});

document.getElementById('alert-list')?.addEventListener('click', event => {
  const button = event.target.closest('[data-alert-remove]');
  if (!button) return;
  S.alerts = S.alerts.filter(alert => alert.id !== button.dataset.alertRemove);
  persist();
  renderAlerts();
  notify('Alerta removido.');
});

export {renderAlerts, evaluateAlerts};
