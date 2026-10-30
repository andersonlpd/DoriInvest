import {S,persist,recordMarketSnapshot} from '../store.js';
import {applyTrade} from '../calc.js';
import {money,number,makeCell,notify} from '../dom.js';
import {refresh,renderQuoteStatus} from '../render.js';
function profitOf(p) {
  return p.costBasisKnown === false || !Number.isFinite(p.averagePrice) || !Number.isFinite(p.currentPrice) ? null : p.quantity * (p.currentPrice - p.averagePrice);
}
function positionRow(p, showInvested = false) {
  const tr = document.createElement('tr'),
    first = makeCell(''),
    cell = document.createElement('div');
  cell.className = 'asset-cell';
  const logo = document.createElement('span');
  logo.className = 'asset-logo';
  logo.textContent = p.ticker.slice(0, 4);
  const name = document.createElement('span');
  name.className = 'asset-name';
  const strong = document.createElement('strong');
  strong.textContent = p.ticker;
  strong.dataset.assetOpen = p.ticker;
  strong.className = 'asset-link';
  strong.title = 'Ver movimentações e histórico do ativo';
  const small = document.createElement('small');
  small.textContent = p.name || p.category;
  name.append(strong, small);
  cell.append(logo, name);
  first.append(cell);
  const basisKnown = p.costBasisKnown !== false && Number.isFinite(p.averagePrice),
    priceCell = makeCell(''),
    priceButton = document.createElement('button');
  priceButton.type = 'button';
  priceButton.className = 'text-link';
  priceButton.dataset.editPrice = p.ticker;
  priceButton.textContent = Number.isFinite(p.currentPrice) ? money(p.currentPrice) : 'Definir preço';
  if (p.quoteSource) priceButton.title = `${p.quoteSource} · ${p.quoteTime || 'data sem horário'}`;
  priceCell.append(priceButton);
  const target = Number(p.targetPrice);
  if (Number.isFinite(target) && target > 0) {
    const distance = Number.isFinite(p.currentPrice) && p.currentPrice > 0 ? Math.abs((target / p.currentPrice - 1) * 100) : null;
    const reached = Number.isFinite(p.currentPrice) && p.currentPrice >= target;
    const tag = document.createElement('small');
    tag.className = 'target-tag' + (reached ? ' positive' : '');
    tag.textContent = `alvo ${money(target)}${distance == null ? '' : ` (${distance.toLocaleString('pt-BR', {
      maximumFractionDigits: 1
    })}%)`}${reached ? ' ✓' : ''}`;
    priceCell.append(tag);
  }
  tr.append(first, makeCell(number(p.quantity)), makeCell(basisKnown ? (p.costBasisEstimated ? '≈ ' + money(p.averagePrice) : money(p.averagePrice)) : '—'), priceCell);
  if (showInvested) tr.append(makeCell(basisKnown ? money(p.quantity * p.averagePrice) : '—'));
  tr.append(makeCell(Number.isFinite(p.currentPrice) ? money(p.quantity * p.currentPrice) : '—'));
  const profit = profitOf(p);
  tr.append(makeCell(profit === null ? '—' : (profit >= 0 ? '+' : '') + money(profit), 'delta ' + (profit === null ? '' : profit >= 0 ? 'positive' : 'negative')));
  return tr;
}
function renderPositions() {
  const valid = S.positions.filter(p => p.quantity > 0),
    top = [...valid].sort((a, b) => b.quantity * (b.currentPrice || 0) - a.quantity * (a.currentPrice || 0)),
    overview = document.getElementById('overview-assets'),
    all = document.getElementById('portfolio-assets');
  overview.replaceChildren();
  all.replaceChildren();
  top.slice(0, 5).forEach(p => overview.append(positionRow(p)));
  const query = document.getElementById('asset-search').value.trim().toLocaleLowerCase('pt-BR'),
    shown = top.filter(p => (S.currentFilter === 'Todos' || p.category === S.currentFilter) && (!query || `${p.ticker} ${p.name} ${p.category}`.toLocaleLowerCase('pt-BR').includes(query)));
  shown.forEach(p => all.append(positionRow(p, true)));
  if (!shown.length) {
    const tr = document.createElement('tr'),
      td = makeCell(valid.length ? 'Nenhum ativo corresponde aos filtros.' : 'Nenhuma posição registrada. Lance uma operação ou importe um Excel da B3.');
    td.colSpan = 7;
    td.className = 'empty';
    tr.append(td);
    all.append(tr);
  }
  document.getElementById('asset-count').textContent = String(valid.length);
}
function renderFavorites() {
  const tbody = document.getElementById('watch-body'),
    empty = document.getElementById('watch-empty');
  tbody.replaceChildren();
  empty.hidden = !!S.favorites.length;
  S.favorites.forEach(ticker => {
    const position = S.positions.find(p => p.ticker === ticker);
    const watch = S.watchQuotes[ticker];
    const price = Number(watch?.price) || Number(position?.currentPrice),
      hasPrice = Number.isFinite(price) && price > 0;
    const tr = document.createElement('tr');
    tr.append(makeCell(ticker), makeCell(position?.category || '—'), makeCell(hasPrice ? money(price) : '—'));
    const cell = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-link';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      S.favorites = S.favorites.filter(t => t !== ticker);
      delete S.watchQuotes[ticker];
      persist();
      renderFavorites();
    });
    cell.append(remove);
    tr.append(cell);
    tbody.append(tr);
  });
}
async function refreshFavorites() {
  if (!S.favorites.length) return notify('Nenhum ativo na watchlist.');
  try {
    const response = await fetch('/api/quotes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assets: S.favorites.map(t => ({
          ticker: t,
          category: S.positions.find(p => p.ticker === t)?.category || 'Ações'
        }))
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha no servidor local.');
    const results = data.quotes || [];
    let updated = 0;
    S.positions = S.positions.map(p => {
      const quote = new Map(results.map(q => [q.ticker, q])).get(p.ticker);
      return quote && Number(quote.price) > 0 ? (updated++, {
        ...p,
        currentPrice: Number(quote.price),
        quoteSource: quote.source,
        quoteTime: quote.quoteTime
      }) : p;
    });
    results.forEach(q => {
      if (Number(q.price) > 0) S.watchQuotes[q.ticker] = {
        price: Number(q.price),
        source: q.source,
        quoteTime: q.quoteTime
      };
    });
    if (updated && !persist()) return notify('Cotações obtidas, mas o saldo não salvou neste navegador.');
    refresh();
    notify(`${results.length} cotação(ões) da watchlist atualizada(s).`);
  } catch (error) {
    notify(error.message || 'Não foi possível consultar cotações da watchlist.');
  }
}
const modal = document.getElementById('transaction-modal');
const form = document.getElementById('transaction-form');
const typeSelect = document.getElementById('transaction-type');
const qtyField = document.getElementById('transaction-quantity');
const qtyWrap = document.getElementById('quantity-field');
const dateInput = document.getElementById('transaction-date');
function openForm() {
  dateInput.value = new Date().toISOString().slice(0, 10);
  form.reset();
  dateInput.value = new Date().toISOString().slice(0, 10);
  typeSelect.dispatchEvent(new Event('change'));
  modal.showModal();
}
document.getElementById('add-transaction').addEventListener('click', openForm);
document.getElementById('activity-add').addEventListener('click', openForm);
document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => modal.close()));
const feeWrap = document.getElementById('fee-field'),
  feeInput = document.getElementById('transaction-fees');
typeSelect.addEventListener('change', () => {
  const isDividend = typeSelect.value === 'Provento';
  qtyWrap.hidden = isDividend;
  qtyField.required = !isDividend;
  qtyField.disabled = isDividend;
  document.getElementById('category-field').hidden = isDividend;
  feeWrap.hidden = isDividend;
  feeInput.disabled = isDividend;
  document.getElementById('price-label').textContent = isDividend ? 'Valor do provento (R$)' : 'Preço unitário (R$)';
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const type = typeSelect.value,
    ticker = document.getElementById('transaction-ticker').value.trim().toUpperCase(),
    date = dateInput.value,
    price = Number(document.getElementById('transaction-price').value),
    quantity = type === 'Provento' ? 0 : Number(qtyField.value),
    fees = type === 'Provento' ? 0 : Number(feeInput.value || 0);
  if (!ticker || !date || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fees) || fees < 0 || type !== 'Provento' && (!Number.isFinite(quantity) || quantity <= 0 || type === 'Venda' && fees >= quantity * price)) {
    notify('Confira os dados da movimentação e das taxas.');
    return;
  }
  const category = document.getElementById('transaction-category').value,
    previousPositions = S.positions.map(p => ({
      ...p
    })),
    previousTransactions = S.transactions.slice(),
    positionBefore = S.positions.find(p => p.ticker === ticker),
    before = positionBefore ? {
      ...positionBefore
    } : null;
  let realizedPnl = null;
  try {
    if (type !== 'Provento') ({
      realizedPnl
    } = applyTrade(S.positions, type, ticker, quantity, price, category, fees));
  } catch (error) {
    notify(error.message);
    return;
  }
  const gross = quantity * price,
    amount = type === 'Provento' ? price : type === 'Compra' ? gross + fees : gross - fees;
  S.transactions.unshift({
    id: globalThis.crypto?.randomUUID?.() || String(Date.now()),
    createdAt: new Date().toISOString(),
    positionBefore: before,
    date,
    ticker,
    type,
    quantity,
    price,
    fees,
    realizedPnl,
    amount,
    category,
    source: 'Manual'
  });
  if (!persist()) {
    S.positions = previousPositions;
    S.transactions = previousTransactions;
    return;
  }
  modal.close();
  form.reset();
  typeSelect.dispatchEvent(new Event('change'));
  refresh();
  notify('Movimentação salva neste navegador.');
});
const quoteModal = document.getElementById('quote-modal'),
  quoteForm = document.getElementById('quote-form');
function openQuoteModal(ticker) {
  const position = S.positions.find(p => p.ticker === ticker);
  if (!position) return;
  document.getElementById('quote-ticker').value = ticker;
  document.getElementById('quote-price').value = position.currentPrice ?? '';
  document.getElementById('quote-average').value = position.averagePrice ?? '';
  document.getElementById('quote-target').value = position.targetPrice ?? '';
  document.getElementById('quote-date').value = position.quoteTime?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  quoteModal.showModal();
}
document.querySelectorAll('[data-close-quote]').forEach(button => button.addEventListener('click', () => quoteModal.close()));
quoteForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!quoteForm.reportValidity()) return;
  const ticker = document.getElementById('quote-ticker').value,
    price = Number(document.getElementById('quote-price').value),
    date = document.getElementById('quote-date').value,
    today = new Date().toISOString().slice(0, 10),
    averageRaw = document.getElementById('quote-average').value.trim(),
    average = averageRaw === '' ? null : Number(averageRaw),
    targetRaw = document.getElementById('quote-target').value.trim(),
    target = targetRaw === '' ? null : Number(targetRaw);
  if (!Number.isFinite(price) || price <= 0 || !date || date > today || average !== null && (!Number.isFinite(average) || average <= 0) || target !== null && (!Number.isFinite(target) || target <= 0)) return notify('Informe preço positivo, preço médio/preço-alvo (se preenchidos) positivos e data válida, não futura.');
  const position = S.positions.find(p => p.ticker === ticker);
  if (!position) return;
  const previous = {
      positions: S.positions,
      quoteSyncMeta: S.quoteSyncMeta,
      marketSnapshots: S.marketSnapshots
    },
    quoteTime = new Date(date + 'T12:00:00').toISOString();
  S.positions = S.positions.map(p => p.ticker === ticker ? {
    ...p,
    currentPrice: price,
    quoteSource: 'Manual',
    quoteTime,
    averagePrice: average ?? position.averagePrice,
    costBasisKnown: average != null ? true : position.costBasisKnown !== false && position.averagePrice != null,
    costBasisEstimated: average != null ? false : position.costBasisEstimated === true,
    targetPrice: target !== null ? target : average === null && position.targetPrice != null ? position.targetPrice : position.targetPrice ?? null
  } : p);
  S.quoteSyncMeta = {
    ...(S.quoteSyncMeta || {}),
    manualUpdatedAt: new Date().toISOString(),
    manualTicker: ticker
  };
  recordMarketSnapshot('Preço manual');
  if (!persist()) {
    S.positions = previous.positions;
    S.quoteSyncMeta = previous.quoteSyncMeta;
    S.marketSnapshots = previous.marketSnapshots;
    return;
  }
  quoteModal.close();
  refresh();
  renderQuoteStatus();
  notify(average != null ? `Preço e custo médio de ${ticker} salvos.` : `Preço manual de ${ticker} salvo.`);
});
document.getElementById('watch-add').addEventListener('click', () => {
  const input = document.getElementById('watch-input');
  const ticker = input.value.trim().toUpperCase();
  input.value = '';
  if (!/^[A-Z0-9]{4,8}$/.test(ticker) || !/^(?=[A-Z0-9]*\d)/.test(ticker) || /^Tesouro/i.test(ticker)) return notify('Informe um ticker da B3 (ex.: PETR4, KNCR11).');
  if (S.favorites.includes(ticker)) return notify(ticker + ' já está na watchlist.');
  S.favorites = [...S.favorites, ticker].slice(-50);
  persist();
  renderFavorites();
  notify(ticker + ' na watchlist. Clique em Atualizar preços.');
});
document.getElementById('watch-refresh').addEventListener('click', refreshFavorites);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  S.currentFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button));
  renderPositions();
}));
document.getElementById('asset-search').addEventListener('input', renderPositions);

export {positionRow,renderPositions,openForm,openQuoteModal,renderFavorites,refreshFavorites};
