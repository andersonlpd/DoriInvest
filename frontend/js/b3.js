import {S,persist,recordSnapshotPoint} from './store.js';
import {money,number,dateLabel,makeCell,notify,reportClientDebug,reportClientError} from './dom.js';
import {refresh,renderQuoteStatus} from './render.js';
import {mergeB3Import,analyzeMovements} from './calc.js';
let pendingB3Import = null;
function showB3Preview(data) {
  pendingB3Import = data;
  const importedPositions = data.positions || [],
    importedTransactions = data.transactions || [];
  const derived = analyzeMovements(importedTransactions, importedPositions);
  const reconCount = Object.keys(derived.reconciled).length;
  const incomeOnly = data.kind === 'proventos';
  const incomeTotal = importedTransactions.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  document.getElementById('b3-preview-summary').textContent = incomeOnly ? `${importedTransactions.length} proventos previstos` : `${importedPositions.length} posições · ${importedTransactions.length} movimentações`;
  document.getElementById('b3-preview-reference').textContent = incomeOnly ? `Proventos a receber · total ${money(incomeTotal)}` : `${data.source || 'Relatório B3'} · referência ${data.referenceDate ? dateLabel(data.referenceDate) : 'não informada'}`;
  const notes = [...(data.warnings || [])];
  if (data.fullSnapshot) notes.push('Snapshot completo: substitui posições B3 anteriores. Ativos manuais de outros tickers serão preservados; ticker igual será atualizado pelo relatório.');else if (importedPositions.length) notes.push('Snapshot parcial: posições não listadas serão preservadas; ticker igual substitui a posição local. Movimentações sem snapshot não recalculam saldos.');
  const missingCost = importedPositions.filter(p => p.averagePrice == null).length;
  if (missingCost) {
    const pmCount = Object.keys(derived.pm).length;
    if (pmCount) notes.push(`${pmCount} dessas posições ganham custo médio reconstruído das movimentações B3 (saldos conferem com este relatório); o restante fica "—" até você informar manualmente.`);else notes.push(`${missingCost} posições não trazem custo médio; o custo/P&L dessas linhas ficará indisponível.`);
  }
  document.getElementById('b3-preview-warning').textContent = notes.join(' ');
  const positionsWrap = document.getElementById('b3-preview-positions-wrap'),
    incomeSection = document.getElementById('b3-preview-income'),
    incomeList = document.getElementById('b3-preview-income-list');
  positionsWrap.hidden = incomeOnly;
  incomeSection.hidden = !incomeOnly;
  if (incomeOnly) {
    incomeList.replaceChildren();
    [...importedTransactions].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).slice(0, 20).forEach(tx => {
      const row = document.createElement('div');
      row.className = 'asset-movement';
      const when = document.createElement('span');
      when.textContent = tx.date ? dateLabel(tx.date) : 'sem data';
      const what = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = tx.ticker;
      const detail = document.createElement('small');
      detail.textContent = tx.label || 'Provento';
      what.append(title, document.createElement('br'), detail);
      const amount = document.createElement('span');
      amount.className = 'amount';
      amount.textContent = money(tx.amount);
      row.append(when, what, amount);
      incomeList.append(row);
    });
    document.getElementById('b3-preview-income-total').textContent = `${importedTransactions.length} pagamento(s) · ${money(incomeTotal)}`;
    document.getElementById('b3-preview-foot').textContent = `Total previsto: ${money(incomeTotal)} em ${importedTransactions.length} pagamento(s). As datas são previsões da B3; nada entra nos proventos recebidos até o pagamento.`;
  } else {
    document.getElementById('b3-preview-foot').textContent = `Saldos conferindo com este relatório (✓): ${reconCount} posições · Aportes registrados: ${money(derived.aportesTotal)} · Proventos recebidos: ${money(derived.incomeTotal)}. PM na coluna "Custo médio" vem das movimentações quando a posição fecha.`;
  }
  const tbody = document.getElementById('b3-preview-positions');
  tbody.replaceChildren();
  importedPositions.slice(0, 20).forEach(p => {
    const tr = document.createElement('tr');
    const recon = derived.reconciled[p.ticker];
    const pmCell = p.averagePrice == null ? derived.pm[p.ticker] != null ? money(derived.pm[p.ticker]) : '—' : money(p.averagePrice);
    tr.append(makeCell(p.ticker), makeCell(p.category || '—'), makeCell(number(p.quantity) + (recon ? ' ✓' : '')), makeCell(money(p.currentPrice)), makeCell(pmCell));
    tbody.append(tr);
  });
  if (!importedPositions.length) {
    const tr = document.createElement('tr'),
      td = makeCell('Este arquivo contém movimentações, sem snapshot de posições.');
    td.colSpan = 5;
    td.className = 'empty';
    tr.append(td);
    tbody.append(tr);
  }
  document.getElementById('b3-import-preview').hidden = false;
  document.getElementById('b3-import-status').textContent = incomeOnly ? 'Prévia de proventos carregada. Confira a lista e clique em Aplicar importação.' : 'Prévia carregada. Confira a tabela acima e clique em Aplicar importação.';
  document.getElementById('b3-apply-import').disabled = !importedPositions.length && !importedTransactions.length;
  reportClientDebug('preview-shown', {
    positions: importedPositions.length,
    txs: importedTransactions.length,
    history: (data.history || []).length,
    fullSnapshot: !!data.fullSnapshot,
    reportDate: data.reportDate || null
  });
}
function applyB3Import() {
  if (!pendingB3Import) {
    notify('Nenhuma prévia pendente para aplicar.');
    return;
  }
  reportClientDebug('apply-click', {
    pendingPositions: (pendingB3Import.positions || []).length,
    pendingTxs: (pendingB3Import.transactions || []).length,
    history: (pendingB3Import.history || []).length,
    fullSnapshot: !!pendingB3Import.fullSnapshot
  });
  const previous = {
    positions: S.positions,
    transactions: S.transactions,
    b3SyncMeta: S.b3SyncMeta,
    marketSnapshots: S.marketSnapshots
  };
  try {
    const merged = mergeB3Import(S.positions, S.transactions, pendingB3Import);
    const incomeOnly = pendingB3Import.kind === 'proventos';
    const appliedTxs = (pendingB3Import.transactions || []).length;
    S.positions = merged.positions;
    S.transactions = merged.transactions;
    const derived = analyzeMovements(S.transactions, S.positions);
    let pmApplied = 0;
    S.positions = S.positions.map(p => {
      if (p.source === 'B3' && p.costBasisKnown === false && derived.pm[p.ticker] != null) {
        pmApplied++;
        return {
          ...p,
          averagePrice: derived.pm[p.ticker],
          costBasisKnown: true
        };
      }
      return p;
    });
    if (!incomeOnly) S.b3SyncMeta = {
      source: 'B3 XLSX',
      referenceDate: pendingB3Import.referenceDate || null,
      reportDate: pendingB3Import.reportDate || null,
      importedAt: new Date().toISOString(),
      importId: pendingB3Import.importId,
      positionCount: (pendingB3Import.positions || []).length,
      transactionCount: (pendingB3Import.transactions || []).length
    };
    if (!incomeOnly && pendingB3Import.fullSnapshot) {
      const sum = pendingB3Import.positions.reduce((s, p) => s + p.currentValue, 0),
        points = pendingB3Import.history && pendingB3Import.history.length ? pendingB3Import.history : [{
          date: pendingB3Import.reportDate || pendingB3Import.referenceDate,
          value: sum
        }];
      for (const point of points) recordSnapshotPoint(point.date, point.value, 'B3 XLSX');
    }
    if (!persist()) {
      S.positions = previous.positions;
      S.transactions = previous.transactions;
      S.b3SyncMeta = previous.b3SyncMeta;
      S.marketSnapshots = previous.marketSnapshots;
      notify('Não foi possível salvar a carteira neste navegador.');
      return;
    }
    try {
      refresh();
      renderQuoteStatus();
    } catch (renderError) {
      reportClientError('render-after-apply', renderError);
      notify('Importação aplicada; a tela não atualizou (veja o status do importador). Recarregue a página se necessário.');
    }
    document.getElementById('b3-import-preview').hidden = true;
    pendingB3Import = null;
    document.getElementById('b3-import-status').textContent = incomeOnly
      ? 'Proventos previstos adicionados: ' + appliedTxs + ' lançamento(s); a carteira não foi alterada.'
      : 'Relatório B3 aplicado: ' + S.positions.filter(p => p.quantity > 0).length + ' posições com saldo na carteira' + (pmApplied ? `; custo médio reconstruído nas movimentações para ${pmApplied} ativos.` : '.');
    document.dispatchEvent(new CustomEvent('dorinvest:b3-applied'));
    reportClientDebug('apply-success', {
      snaps: S.marketSnapshots.length,
      pmApplied,
      snapSample: S.marketSnapshots.slice(-4).map(s => s.date + ':' + Math.round(s.value))
    });
  } catch (error) {
    S.positions = previous.positions;
    S.transactions = previous.transactions;
    S.b3SyncMeta = previous.b3SyncMeta;
    S.marketSnapshots = previous.marketSnapshots;
    reportClientError('applyB3Import', error);
    document.getElementById('b3-import-status').textContent = 'Falha ao aplicar: ' + (error.message || 'erro desconhecido');
    notify(error.message || 'Importação rejeitada.');
  }
}
function combinedImport(payloads) {
  const effective = payload => payload.reportDate || payload.referenceDate || (payload.transactions || []).map(tx => tx.date || '').filter(Boolean).sort().pop() || '';
  const withPositions = payloads.filter(p => (p.positions || []).length),
    latest = withPositions.sort((a, b) => effective(a).localeCompare(effective(b))).pop() || {};
  const transactions = [],
    seen = new Set();
  let rows = 0;
  for (const payload of payloads) {
    rows += (payload.transactions || []).length;
    for (const tx of payload.transactions || []) {
      if (seen.has(tx.sourceId)) continue;
      seen.add(tx.sourceId);
      transactions.push(tx);
    }
  }
  const warnings = [...(latest.warnings || [])];
  if (payloads.length > 1) warnings.push(`${payloads.length} relatórios lidos · posições do mais recente${effective(latest) ? ` (${dateLabel(effective(latest))})` : ''} · ${transactions.length} movimentações únicas de ${rows} linhas.`);
  const history = [];
  for (const payload of payloads) {
    const date = effective(payload),
      value = (payload.positions || []).reduce((sum, p) => sum + p.currentValue, 0);
    if (date && Number.isFinite(value) && value > 0) history.push({
      date,
      value
    });
  }
  return {
    importId: `bulk-${payloads.map(p => p.importId || '').join('.')}`,
    source: 'B3 XLSX',
    referenceDate: effective(latest) || transactions.map(tx => tx.date).filter(Boolean).sort().at(-1) || null,
    reportDate: latest.reportDate || null,
    fullSnapshot: !!(latest.positions || []).length,
    positions: latest.positions || [],
    transactions,
    sheetNames: latest.sheetNames || [],
    warnings,
    history
  };
}
async function loadB3File() {
  const files = [...document.getElementById('b3-file').files];
  if (!files.length) return notify('Selecione um arquivo XLSX da B3.');
  const oversized = files.find(file => file.size > 20 * 1024 * 1024);
  if (oversized) return notify('O arquivo ' + oversized.name + ' supera o limite de 20 MB.');
  const status = document.getElementById('b3-import-status'),
    payloads = [];
  for (let i = 0; i < files.length; i++) {
    status.textContent = `Lendo ${i + 1} de ${files.length} arquivo(s)…`;
    try {
      const response = await fetch('/api/b3/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'X-B3-Filename': encodeURIComponent(files[i].name)
        },
        body: files[i]
      });
      const data = await response.json();
      if (!response.ok) throw new Error(files[i].name + ': ' + (data.error || 'Não foi possível ler a planilha.'));
      payloads.push(data);
    } catch (error) {
      status.textContent = 'Falha ao analisar o XLSX; a carteira não foi alterada.';
      return notify(error.message || 'Servidor local indisponível.');
    }
  }
  showB3Preview(files.length > 1 ? combinedImport(payloads) : payloads[0]);
}
const b3File = document.getElementById('b3-file'),
  b3ReadButton = document.getElementById('b3-read-file');
b3File.addEventListener('change', () => {
  b3ReadButton.disabled = !b3File.files.length;
});
b3ReadButton.addEventListener('click', loadB3File);
document.getElementById('b3-apply-import').addEventListener('click', applyB3Import);
document.getElementById('b3-cancel-import').addEventListener('click', () => {
  pendingB3Import = null;
  document.getElementById('b3-import-preview').hidden = true;
  document.getElementById('b3-import-status').textContent = 'Prévia descartada; a carteira não foi alterada.';
});

export {combinedImport,showB3Preview,applyB3Import,loadB3File};
