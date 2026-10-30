import {S,persist,recordMarketSnapshot} from '../store.js';
import {money,number,dateLabel,notify} from '../dom.js';
import {refresh} from '../render.js';
const txBody = document.getElementById('activity-list');
function renderActivity() {
  txBody.replaceChildren();
  [...S.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).forEach(tx => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const date = document.createElement('span');
    date.className = 'activity-date';
    date.textContent = dateLabel(tx.date);
    const action = document.createElement('span');
    action.className = 'activity-action';
    const strong = document.createElement('strong');
    strong.textContent = tx.type + ' · ' + tx.ticker;
    strong.dataset.assetOpen = tx.ticker;
    strong.className = 'asset-link';
    strong.title = 'Ver movimentações e histórico do ativo';
    const small = document.createElement('small');
    small.textContent = tx.type === 'Provento' ? tx.date > new Date().toISOString().slice(0, 10) ? 'Provento futuro informado' : 'Provento recebido' : `${number(tx.quantity)} cotas · ${money(tx.price)} / un.${tx.fees ? ` · taxas ${money(tx.fees)}` : ''}${Number.isFinite(tx.realizedPnl) ? ` · P&L ${money(tx.realizedPnl)}` : ''}`;
    action.append(strong, small);
    if (canUndoTransaction(tx)) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'text-link';
      undo.dataset.undoTransaction = tx.id;
      undo.textContent = 'Desfazer última operação';
      action.append(undo);
    }
    const value = document.createElement('span');
    value.className = 'activity-value ' + (tx.type === 'Venda' || tx.type === 'Provento' ? 'positive' : '');
    value.textContent = (tx.type === 'Compra' ? '−' : tx.type === 'Venda' ? '+' : '+') + money(tx.amount);
    const type = document.createElement('span');
    type.className = 'activity-type';
    type.textContent = tx.source || 'Manual';
    row.append(date, action, value, type);
    txBody.append(row);
  });
  if (!S.transactions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nenhuma movimentação registrada.';
    txBody.append(empty);
  }
}
function canUndoTransaction(tx) {
  if (tx.source !== 'Manual' || !Object.prototype.hasOwnProperty.call(tx, 'positionBefore') || !tx.createdAt) return false;
  const created = Date.parse(tx.createdAt);
  if (!Number.isFinite(created) || S.b3SyncMeta?.importedAt && Date.parse(S.b3SyncMeta.importedAt) > created) return false;
  return !S.transactions.some(other => other.id !== tx.id && other.source === 'Manual' && other.ticker === tx.ticker && other.createdAt && Date.parse(other.createdAt) > created);
}
function undoTransaction(id) {
  const tx = S.transactions.find(item => item.id === id);
  if (!tx || !canUndoTransaction(tx)) return notify('Só é possível desfazer a última operação manual desse ativo.');
  if (!window.confirm(`Desfazer a última operação ${tx.type} de ${tx.ticker}?`)) return;
  const previous = {
      positions: S.positions,
      transactions: S.transactions,
      marketSnapshots: S.marketSnapshots
    },
    current = S.positions.find(p => p.ticker === tx.ticker),
    before = tx.positionBefore ? {
      ...tx.positionBefore
    } : null;
  if (tx.type !== 'Provento') {
    const quoteWasUpdated = S.quoteSyncMeta && Math.max(Date.parse(S.quoteSyncMeta.updatedAt || 0) || 0, Date.parse(S.quoteSyncMeta.manualUpdatedAt || 0) || 0) > Date.parse(tx.createdAt);
    if (before && current && quoteWasUpdated) {
      before.currentPrice = current.currentPrice;
      before.quoteSource = current.quoteSource;
      before.quoteTime = current.quoteTime;
    }
    S.positions = S.positions.filter(p => p.ticker !== tx.ticker);
    if (before && before.quantity > 0) S.positions.push(before);
  }
  S.transactions = S.transactions.filter(item => item.id !== id);
  recordMarketSnapshot('Operação local');
  if (!persist()) {
    S.positions = previous.positions;
    S.transactions = previous.transactions;
    S.marketSnapshots = previous.marketSnapshots;
    return;
  }
  refresh();
  notify('Operação desfeita.');
}
function exportCsv() {
  const rows = [['Data', 'Tipo', 'Ativo', 'Quantidade', 'Preço unitário/valor', 'Taxas', 'Total', 'P&L realizado', 'Origem'], ...S.transactions.map(t => [t.date, t.type, t.ticker, t.quantity, t.price, t.fees, t.amount, t.realizedPnl, t.source || 'Manual'])];
  const csv = rows.map(row => row.map(value => {
    const text = String(value ?? '');
    return '"' + (/^[=+\-@]/.test(text) ? "'" : "") + text.replaceAll('"', '""') + '"';
  }).join(';')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['\ufeff' + csv], {
    type: 'text/csv;charset=utf-8'
  }));
  link.download = 'dorinvest-movimentacoes.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  notify('CSV exportado.');
}
document.getElementById('export-button').addEventListener('click', exportCsv);
txBody.addEventListener('click', event => {
  const button = event.target.closest('[data-undo-transaction]');
  if (button) undoTransaction(button.dataset.undoTransaction);
});

export {renderActivity,exportCsv,undoTransaction,canUndoTransaction};
