import {S,persist,removeLegacyDemo,exportBackup,validateBackup,loadState} from './store.js';
import {notify,reportClientError,reportClientDebug} from './dom.js';
import {analyzeMovements} from './calc.js';
import {refresh,refreshQuotes,renderQuoteStatus} from './render.js';
import {openQuoteModal} from './panels/portfolio.js';
import {undoTransaction} from './panels/activity.js';
import {renderCalculators} from './panels/tools.js';
import './b3.js';
import './panels/compare.js';
import './panels/asset.js';

// puxa o estado do SQLite quando o navegador está vazio (primeiro acesso ou troca de máquina)
if(!S.positions.length&&!S.transactions.length){try{const response=await fetch('/api/state');if(response.ok)loadState(await response.json())}catch{}}
const titles = {
  overview: ['Visão geral', 'Sua carteira', 'Patrimônio e operações registradas localmente.'],
  portfolio: ['Carteira', 'Posições', 'Saldos, custo médio e preços informados.'],
  dividends: ['Proventos', 'Recebidos e informados', 'Histórico de proventos registrados ou importados.'],
  goals: ['Metas', 'Planejamento', 'Acompanhe objetivos locais.'],
  activity: ['Movimentações', 'Livro de operações', 'Compras, vendas e proventos registrados neste navegador.'],
  analysis: ['Análise', 'Alocação atual', 'Indicadores calculados a partir das posições registradas.'],
  b3: ['Importar B3', 'Arquivo local', 'Importe relatórios Excel exportados pela Área do Investidor.'],
  tools: ['Calculadoras', 'Planejamento', 'Cenários matemáticos com seus próprios parâmetros.']
};
async function restoreBackup(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return notify('O backup excede 10 MB.');
  try {
    const restored = validateBackup(JSON.parse(await file.text()));
    if (restored.positions.some(p => p.currentPrice === 0) || restored.transactions.some(t => typeof t.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(t.date) || ['Compra', 'Venda'].includes(t.type) && (t.quantity <= 0 || t.price <= 0))) throw new TypeError('O backup contém datas ou valores inválidos.');
    restored.transactions.forEach(t => {
      if (t.positionBefore === undefined) delete t.positionBefore;
    });
    if (!window.confirm('Substituir toda a carteira local pelo backup?')) return;
    const previous = {
      positions: S.positions,
      transactions: S.transactions,
      b3SyncMeta: S.b3SyncMeta,
      quoteSyncMeta: S.quoteSyncMeta,
      marketSnapshots: S.marketSnapshots,
      goals: S.goals,
      alerts: S.alerts
    };
    S.positions = restored.positions;
    S.transactions = restored.transactions;
    S.b3SyncMeta = restored.b3SyncMeta;
    S.quoteSyncMeta = restored.quoteSyncMeta;
    S.marketSnapshots = restored.marketSnapshots;
    S.favorites = restored.favorites || S.favorites;
    S.goals = restored.goals?.length ? restored.goals : S.goals;
    S.alerts = restored.alerts?.length ? restored.alerts : S.alerts;
    if (!persist()) {
      S.positions = previous.positions;
      S.transactions = previous.transactions;
      S.b3SyncMeta = previous.b3SyncMeta;
      S.quoteSyncMeta = previous.quoteSyncMeta;
      S.marketSnapshots = previous.marketSnapshots;
      S.goals = previous.goals;
      S.alerts = previous.alerts;
      return;
    }
    refresh();
    renderQuoteStatus();
    notify('Backup restaurado neste navegador.');
  } catch (error) {
    notify(error.message || 'Não consegui restaurar esse backup.');
  }
}
function setPage(page) {
  if (!titles[page]) return;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === page));
  document.querySelectorAll('.nav [data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const [title, eyebrow, subtitle] = titles[page];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-eyebrow').textContent = eyebrow;
  document.getElementById('page-subtitle').textContent = subtitle;
  document.getElementById('crumb-current').textContent = title;
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}
document.addEventListener('click', event => {
  const nav = event.target.closest('[data-page]');
  if (nav) setPage(nav.dataset.page);
  const undo = event.target.closest('[data-undo-transaction]');
  if (undo) undoTransaction(undo.dataset.undoTransaction);
  const editPrice = event.target.closest('[data-edit-price]');
  if (editPrice) openQuoteModal(editPrice.dataset.editPrice);
});
document.getElementById('backup-export').addEventListener('click', exportBackup);
document.getElementById('backup-file').addEventListener('change', async event => {
  await restoreBackup(event.target.files[0]);
  event.target.value = '';
});
document.getElementById('refresh-quotes').addEventListener('click', refreshQuotes);
if (removeLegacyDemo) persist();
const bootDerived = analyzeMovements(S.transactions, S.positions);
let bootPmApplied = 0;
S.positions = S.positions.map(p => {
  const needsPm = p.source === 'B3' && (p.costBasisKnown === false || p.costBasisEstimated === true) && bootDerived.pm[p.ticker] != null;
  if (!needsPm) return p;
  bootPmApplied++;
  return {
    ...p,
    averagePrice: bootDerived.pm[p.ticker],
    costBasisKnown: true,
    costBasisEstimated: bootDerived.estimated?.[p.ticker] === true
  };
});
if (bootPmApplied) {
  S.b3SyncMeta = {
    ...(S.b3SyncMeta || {}),
    pmReconstructedAt: new Date().toISOString()
  };
  if (!persist()) bootPmApplied = 0;
}
renderCalculators();
renderQuoteStatus();
refresh();
reportClientDebug('boot-diag', {
  positions: S.positions.length,
  txs: S.transactions.length,
  snaps: S.marketSnapshots.length,
  pmFilled: bootPmApplied,
  snapSample: S.marketSnapshots.slice(-8).map(s => s.date + ':' + Math.round(s.value) + ':' + s.source),
  b3: S.b3SyncMeta ? {
    source: S.b3SyncMeta.source,
    ref: S.b3SyncMeta.referenceDate,
    report: S.b3SyncMeta.reportDate || null,
    pos: S.b3SyncMeta.positionCount,
    txs: S.b3SyncMeta.transactionCount
  } : null,
  quote: S.quoteSyncMeta ? 'present' : 'absent'
});
try {
  const el = id => document.getElementById(id);
  reportClientDebug('render-diag', {
    title: el('history-title').textContent,
    value: el('history-value').textContent,
    status: el('history-status').textContent,
    chartHidden: el('history-chart').hasAttribute('hidden'),
    emptyHidden: el('history-empty').hidden,
    lineD: String((el('chart-line') || {}).getAttribute ? el('chart-line').getAttribute('d') : 'sem-svg').slice(0, 80),
    start: el('history-start').textContent,
    end: el('history-end').textContent
  });
} catch (diagError) {
  reportClientError('render-diag-throws', diagError);
}

export {refresh,setPage};
