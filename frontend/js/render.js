import {S,persist,recordMarketSnapshot} from './store.js';
import {quoteDateLabel,dateLabel,notify} from './dom.js';
import {quoteablePositions} from './calc.js';
import {renderMetrics} from './panels/overview.js';
import {renderPositions,renderFavorites} from './panels/portfolio.js';
import {renderActivity} from './panels/activity.js';
import {renderHistory} from './charts.js';
import {renderUpcoming,renderMonthlyDividends} from './panels/income.js';
import {renderGoals} from './panels/goals.js';
import {renderAlerts, evaluateAlerts} from './panels/alerts.js';
function renderB3Status() {
  const status = document.getElementById('b3-sync-status'),
    details = document.getElementById('b3-sync-details');
  if (!S.b3SyncMeta) {
    status.textContent = 'Importação manual';
    details.textContent = 'Aguardando relatório Excel';
    return;
  }
  status.textContent = 'Último relatório B3 importado';
  const ref = S.b3SyncMeta.referenceDate ? dateLabel(S.b3SyncMeta.referenceDate) : 'referência não informada';
  details.textContent = `${S.b3SyncMeta.positionCount || 0} posições · ${S.b3SyncMeta.transactionCount || 0} movimentações · ${ref}`;
}
function renderQuoteStatus() {
  const status = document.getElementById('quote-status');
  if (!S.quoteSyncMeta) {
    status.textContent = 'BRAPI grátis atualiza ativos cobertos sob demanda (atraso aproximado de 30 minutos). Outros preços podem ser lançados manualmente ou importados.';
    return;
  }
  if (S.quoteSyncMeta.manualUpdatedAt && (!S.quoteSyncMeta.updatedAt || S.quoteSyncMeta.manualUpdatedAt > S.quoteSyncMeta.updatedAt)) {
    status.textContent = `Preço manual de ${S.quoteSyncMeta.manualTicker} salvo em ${quoteDateLabel(S.quoteSyncMeta.manualUpdatedAt)}.`;
    return;
  }
  const updated = S.quoteSyncMeta.updatedCount || 0,
    errors = S.quoteSyncMeta.errors || [];
  if (updated) {
    status.textContent = `${updated} cotação(ões) recebida(s) via brapi.dev (${S.quoteSyncMeta.cachedCount || 0} do cache) · dados até ${quoteDateLabel(S.quoteSyncMeta.quoteAsOf || S.quoteSyncMeta.updatedAt)}.${errors.length ? ` ${errors.length} sem atualização: ${errors[0].message}` : ''}${S.quoteSyncMeta.ignored ? ` ${S.quoteSyncMeta.ignored} não cobertas pela API.` : ''}`;
    return;
  }
  const detail = errors[0]?.message || (S.quoteSyncMeta.ignored ? 'Nenhum ativo compatível com cotações BRAPI.' : 'Nenhuma cotação retornada.');
  status.textContent = `${detail}${S.quoteSyncMeta.apiKeyConfigured ? '' : ' Crie uma chave gratuita em brapi.dev/dashboard e configure BRAPI_API_KEY no servidor.'}`;
}
async function refreshQuotes() {
  const button = document.getElementById('refresh-quotes'),
    status = document.getElementById('quote-status'),
    assets = quoteablePositions(S.positions);
  if (!assets.length) {
    status.textContent = 'Nenhum ticker B3 elegível na carteira. Importe ativos ou registre uma posição.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Consultando cotações da brapi.dev…';
  try {
    const response = await fetch('/api/quotes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assets: assets.map(p => ({
          ticker: p.ticker,
          category: p.category
        }))
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha no servidor local.');
    const results = data.quotes || [],
      quotes = new Map(results.map(q => [q.ticker, q])),
      previous = {
        positions: S.positions,
        quoteSyncMeta: S.quoteSyncMeta,
        marketSnapshots: S.marketSnapshots
      };
    S.positions = S.positions.map(p => {
      const quote = quotes.get(p.ticker);
      return quote ? {
        ...p,
        currentPrice: quote.price,
        quoteSource: quote.source,
        quoteTime: quote.quoteTime
      } : p;
    });
    const quoteTimes = results.map(q => Date.parse(q.quoteTime)).filter(Number.isFinite);
    S.quoteSyncMeta = {
      updatedAt: data.updatedAt,
      quoteAsOf: quoteTimes.length ? new Date(Math.min(...quoteTimes)).toISOString() : data.updatedAt,
      updatedCount: quotes.size,
      cachedCount: results.filter(q => q.cached).length,
      errors: data.errors || [],
      apiKeyConfigured: !!data.apiKeyConfigured,
      ignored: data.ignored || 0
    };
    if (quotes.size) recordMarketSnapshot('brapi.dev');
    if (!persist()) {
      S.positions = previous.positions;
      S.quoteSyncMeta = previous.quoteSyncMeta;
      S.marketSnapshots = previous.marketSnapshots;
      return;
    }
    refresh();
    renderQuoteStatus();
    renderHistory();
    notify(quotes.size ? `${quotes.size} cotação(ões) recebida(s).` : S.quoteSyncMeta.errors[0]?.message || 'Nenhuma cotação recebida.');
  } catch (error) {
    status.textContent = error.message || 'Não foi possível consultar cotações.';
    notify(status.textContent);
  } finally {
    button.disabled = false;
  }
}
function refresh() {
  renderMetrics();
  renderPositions();
  renderActivity();
  renderB3Status();
  renderHistory();
  renderUpcoming();
  renderMonthlyDividends();
  renderFavorites();
  renderGoals();
  evaluateAlerts();
  renderAlerts();
}

export {refresh,refreshQuotes,renderQuoteStatus,renderB3Status};
