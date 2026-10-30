import {S, persist} from '../store.js';
import {money, number, dateLabel, notify} from '../dom.js';
import {refresh} from '../render.js';
import {openForm} from './portfolio.js';

let currentTicker = null;

function drawHistory(points) {
  const line = document.getElementById('asset-chart-line'),
    area = document.getElementById('asset-chart-area'),
    status = document.getElementById('asset-chart-status');
  const closes = points.map(point => point.close),
    min = Math.min(...closes),
    max = Math.max(...closes),
    range = max - min || 1,
    step = points.length > 1 ? 640 / (points.length - 1) : 640;
  const path = points.map((point, index) => {
    const x = (index * step).toFixed(1),
      y = (170 - (point.close - min) / range * 140).toFixed(1);
    return (index ? 'L' : 'M') + x + ' ' + y;
  }).join(' ');
  line.setAttribute('d', path);
  area.setAttribute('d', path + ' L640 180 L0 180 Z');
  const first = points[0],
    last = points[points.length - 1],
    change = first.close ? last.close / first.close - 1 : null;
  status.textContent = dateLabel(first.date) + ' a ' + dateLabel(last.date) + ' · mín ' + money(min) + ' · máx ' + money(max) + ' · último ' + money(last.close) + (change == null ? '' : ' (' + (change >= 0 ? '+' : '') + (change * 100).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%)');
}

function drawMovement(tx) {
  const row = document.createElement('div');
  row.className = 'asset-movement';
  const date = document.createElement('span');
  date.textContent = dateLabel(tx.date);
  const action = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = tx.type === 'Evento' && tx.label ? tx.label : tx.type;
  const detail = document.createElement('small');
  const quantity = Number(tx.quantity) || 0,
    price = Number(tx.price) || 0;
  detail.textContent = quantity ? number(quantity) + ' × ' + money(price) : (price ? money(price) : '—');
  action.append(title, document.createElement('br'), detail);
  const total = document.createElement('span');
  total.textContent = money(tx.amount);
  const origin = document.createElement('span');
  origin.textContent = tx.source || 'Manual';
  origin.style.color = '#879188';
  row.append(date, action, total, origin);
  return row;
}

function renderMovements(ticker) {
  const root = document.getElementById('asset-movements');
  root.replaceChildren();
  const movements = S.transactions.filter(tx => tx.ticker === ticker).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!movements.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nenhuma movimentação registrada para este ativo.';
    root.append(empty);
    return;
  }
  movements.slice(0, 200).forEach(tx => root.append(drawMovement(tx)));
  if (movements.length > 200) {
    const note = document.createElement('p');
    note.className = 'screen-summary';
    note.textContent = 'Mostrando as 200 movimentações mais recentes de ' + movements.length + '.';
    root.append(note);
  }
}

async function loadChart(ticker) {
  const status = document.getElementById('asset-chart-status'),
    line = document.getElementById('asset-chart-line'),
    area = document.getElementById('asset-chart-area');
  status.textContent = 'Carregando histórico de 30 dias…';
  line.setAttribute('d', '');
  area.setAttribute('d', '');
  try {
    const response = await fetch('/api/history?ticker=' + encodeURIComponent(ticker) + '&days=30'),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Histórico indisponível.');
    if (currentTicker !== ticker) return;
    if (!Array.isArray(data.points) || data.points.length < 2) throw new Error('Histórico insuficiente para este ativo.');
    drawHistory(data.points);
  } catch (error) {
    if (currentTicker !== ticker) return;
    status.textContent = error.message || 'Não foi possível carregar o histórico.';
  }
}

function refreshAverageField(ticker) {
  const input = document.getElementById('asset-average'),
    button = document.getElementById('asset-save-average'),
    position = S.positions.find(p => p.ticker === ticker);
  input.value = position && position.averagePrice != null ? position.averagePrice : '';
  input.disabled = !position;
  button.disabled = !position;
  input.placeholder = position ? 'Custo médio do ativo' : 'Ativo sem posição na carteira';
}

function openAsset(ticker) {
  const clean = String(ticker || '').trim().toUpperCase();
  if (!clean) return;
  currentTicker = clean;
  const position = S.positions.find(p => p.ticker === clean),
    modal = document.getElementById('asset-modal');
  document.getElementById('asset-modal-title').textContent = clean;
  document.getElementById('asset-modal-subtitle').textContent = (position?.name || 'Ativo') + ' · ' + (position?.category || 'sem posição');
  renderMovements(clean);
  refreshAverageField(clean);
  loadChart(clean);
  if (!modal.open) modal.showModal();
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-asset-open]');
  if (trigger) {
    event.preventDefault();
    openAsset(trigger.dataset.assetOpen);
  }
});

document.querySelectorAll('[data-close-asset]').forEach(button => button.addEventListener('click', () => document.getElementById('asset-modal').close()));

document.getElementById('asset-save-average')?.addEventListener('click', () => {
  if (!currentTicker) return;
  const input = document.getElementById('asset-average'),
    value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return notify('Informe um custo médio válido.');
  const position = S.positions.find(p => p.ticker === currentTicker);
  if (!position) return notify('Este ativo não está na carteira.');
  position.averagePrice = value;
  position.costBasisKnown = value > 0;
  position.costBasisEstimated = false;
  if (!persist()) return;
  refresh();
  notify('Custo médio de ' + currentTicker + ' atualizado.');
});

document.getElementById('asset-new-tx')?.addEventListener('click', () => {
  if (!currentTicker) return;
  const ticker = currentTicker;
  document.getElementById('asset-modal').close();
  openForm();
  document.getElementById('transaction-ticker').value = ticker;
  document.getElementById('transaction-price').focus();
});

export {openAsset};
