import {S} from '../store.js';
import {totals} from '../calc.js';
import {money,topTicker,dateLabel} from '../dom.js';
function renderMetrics() {
  const active = S.positions.filter(p => p.quantity > 0),
    t = totals(active),
    knownSales = S.transactions.filter(x => x.type === 'Venda' && Number.isFinite(x.realizedPnl)),
    allSales = S.transactions.filter(x => x.type === 'Venda'),
    realized = knownSales.reduce((sum, x) => sum + x.realizedPnl, 0),
    today = new Date().toISOString().slice(0, 10),
    dividendTotal = S.transactions.filter(x => x.type === 'Provento' && String(x.date || '') <= today).reduce((sum, x) => sum + x.amount, 0),
    futureCount = S.transactions.filter(x => x.type === 'Provento' && String(x.date || '') > today).length,
    dividendAssets = new Set(S.transactions.filter(x => x.type === 'Provento' && String(x.date || '') <= today).map(x => x.ticker)).size;
  document.querySelectorAll('[data-metric="market"]').forEach(el => el.textContent = active.length && !t.priced ? '—' : money(t.market));
  document.querySelectorAll('[data-metric="invested"]').forEach(el => el.textContent = t.knownBasis ? money(t.invested) : active.length ? '—' : money(0));
  document.querySelectorAll('[data-metric="profit"]').forEach(el => {
    const value = t.profitCoverage ? (t.unrealized >= 0 ? '+' : '') + money(t.unrealized) : '—';
    el.textContent = value;
    el.classList.toggle('positive', t.unrealized >= 0);
    el.classList.toggle('negative', t.unrealized < 0);
  });
  document.querySelectorAll('[data-metric="return"]').forEach(el => {
    const rate = t.profitBasis ? t.unrealized / t.profitBasis * 100 : null;
    el.textContent = rate === null ? '—' : (rate >= 0 ? '+' : '') + rate.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + '%';
    el.classList.toggle('positive', rate !== null && rate >= 0);
    el.classList.toggle('negative', rate !== null && rate < 0);
  });
  document.querySelectorAll('[data-metric="realized"]').forEach(el => el.textContent = knownSales.length ? (realized >= 0 ? '+' : '') + money(realized) : '—');
  document.querySelectorAll('[data-metric="dividends"]').forEach(el => el.textContent = money(dividendTotal));
  document.getElementById('market-coverage').textContent = !active.length ? 'Nenhuma posição registrada' : t.unpriced ? `${t.priced} de ${active.length} posições com preço` : 'Preços atuais disponíveis para todas as posições';
  document.getElementById('cost-coverage').textContent = t.unknownBasis ? `Custo conhecido em ${t.knownBasis} de ${active.length} posições` : `Custo médio conhecido em ${t.knownBasis} posições`;
  document.getElementById('realized-coverage').textContent = allSales.length ? `${knownSales.length} de ${allSales.length} vendas com custo conhecido` : 'Nenhuma venda registrada';
  document.getElementById('allocation-total').textContent = t.priced ? money(t.market) : money(0);
  const group = {};
  active.filter(p => Number.isFinite(p.currentPrice) && p.currentPrice > 0).forEach(p => group[p.category] = (group[p.category] || 0) + p.quantity * p.currentPrice);
  const entries = Object.entries(group).sort((a, b) => b[1] - a[1]),
    colors = ['#1c7e58', '#9cc868', '#e1c66b', '#c0c9c0', '#8ab5b3'];
  let start = 0;
  document.getElementById('allocation-donut').style.background = entries.length ? `conic-gradient(${entries.map(([name, value], i) => {
    const end = start + (t.market ? value / t.market * 100 : 0),
      part = `${colors[i % colors.length]} ${start}% ${end}%`;
    start = end;
    return part;
  }).join(',')})` : 'conic-gradient(#e8ece7 0% 100%)';
  const legend = document.getElementById('allocation-legend');
  legend.replaceChildren();
  entries.forEach(([name, value], i) => {
    const row = document.createElement('div');
    row.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = colors[i % colors.length];
    const label = document.createElement('span');
    label.textContent = name;
    const pct = document.createElement('strong');
    pct.textContent = (t.market ? value / t.market * 100 : 0).toLocaleString('pt-BR', {
      maximumFractionDigits: 1
    }) + '%';
    row.append(dot, label, pct);
    legend.append(row);
  });
  document.getElementById('largest-class').textContent = entries[0]?.[0] || '—';
  document.getElementById('class-count').textContent = String(new Set(active.map(p => p.category)).size);
  document.getElementById('largest-asset').textContent = topTicker(active.filter(p => Number.isFinite(p.currentPrice) && p.currentPrice > 0));
  document.getElementById('insight-allocation').textContent = entries.length ? `${entries[0][0]} representa ${(entries[0][1] / (t.market || 1) * 100).toLocaleString('pt-BR', {
    maximumFractionDigits: 1
  })}% do valor com cotação conhecida.` : 'Atualize cotações ou importe posições para ver a alocação.';
  document.getElementById('insight-return').textContent = t.profitCoverage ? `P&L aberto de ${money(t.unrealized)} sobre posições com custo e cotação conhecidos.${t.profitCoverage < active.length ? ' Há posições sem dados suficientes e elas foram excluídas.' : ''}` : 'O P&L aberto aparece quando posição, custo e preço atual são conhecidos.';
  document.getElementById('insight-history').textContent = S.transactions.length ? `${S.transactions.length} movimentações registradas ou importadas.` : 'Nenhuma movimentação registrada.';
  document.getElementById('insight-quotes').textContent = active.length ? `${t.priced} de ${active.length} posições têm preço atual; ${futureCount} proventos futuros informados.` : 'Adicione ou importe posições para consultar cotações.';
  const snaps = S.marketSnapshots.slice().sort((a, b) => a.date.localeCompare(b.date)).filter(s => Number(s.value) > 0);
  let cagrText = 'O histórico aparece após duas observações do patrimônio (linhas B3 ou cotações).';
  if (snaps.length >= 2) {
    const first = snaps[0],
      last = snaps[snaps.length - 1],
      days = (new Date(last.date) - new Date(first.date)) / 86400000;
    if (days > 7) {
      const totalReturn = last.value / first.value - 1,
        years = days / 365.25,
        annualized = years >= 1 ? Math.pow(last.value / first.value, 1 / years) - 1 : null;
      cagrText = `De ${dateLabel(first.date)} a ${dateLabel(last.date)}: retorno total ${(totalReturn * 100).toLocaleString('pt-BR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      })}%` + (years > 1 ? `, equivalente a ${((annualized || 0) * 100).toLocaleString('pt-BR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      })}% ao ano (CAGR).` : '.');
    }
  }
  document.getElementById('insight-cagr').textContent = cagrText;
  document.getElementById('upcoming-count').textContent = String(futureCount);
  document.getElementById('dividend-asset-count').textContent = String(dividendAssets);
}

export {renderMetrics};
