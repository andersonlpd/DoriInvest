import {S,persist,validateBackup,recordMarketSnapshot,recordSnapshotPoint} from './store.js';
import {compactMoney,money} from './dom.js';
function totals(list) {
  const sum = {
    market: 0,
    invested: 0,
    unrealized: 0,
    profitBasis: 0,
    priced: 0,
    unpriced: 0,
    knownBasis: 0,
    unknownBasis: 0,
    profitCoverage: 0
  };
  for (const p of list) {
    const quantity = Number(p.quantity) || 0,
      hasPrice = Number.isFinite(p.currentPrice) && p.currentPrice > 0,
      hasBasis = p.costBasisKnown !== false && Number.isFinite(p.averagePrice);
    if (hasPrice) {
      sum.market += quantity * p.currentPrice;
      sum.priced++;
    } else sum.unpriced++;
    if (hasBasis) {
      sum.invested += quantity * p.averagePrice;
      sum.knownBasis++;
    } else sum.unknownBasis++;
    if (hasPrice && hasBasis) {
      sum.unrealized += quantity * (p.currentPrice - p.averagePrice);
      sum.profitBasis += quantity * p.averagePrice;
      sum.profitCoverage++;
    }
  }
  return sum;
}
function analyzeMovements(list, positions) {
  const led = {};
  for (const tx of list || []) {
    const ticker = String(tx.ticker || '').toUpperCase();
    if (!ticker) continue;
    const kind = tx.type,
      label = String(tx.label || '').toLowerCase(),
      quantity = Number(tx.quantity) || 0,
      amount = Number(tx.amount) || 0;
    const row = led[ticker] || (led[ticker] = {
      qty: 0,
      cost: 0,
      income: 0
    });
    if (kind === 'Provento') {
      row.income += amount;
    } else if (kind === 'Venda') {
      row.qty -= quantity;
    } else if (kind === 'Compra') {
      if (tx.category === 'Renda Fixa') {
        row.income += 0;
        row.cost += amount;
      } else {
        row.qty += quantity;
        row.cost += amount;
      }
    } else {
      if (label.includes('bonifica')) row.qty += quantity;else if (label.includes('fração') || label.includes('fracao')) row.qty -= quantity;else if (label.includes('leilão') || label.includes('leilao')) {
        row.qty += quantity;
        row.cost += amount;
      } else if (quantity > 0 && amount > 0) {
        row.qty += quantity;
        row.cost += amount;
      }
    }
  }
  const derived = {
    pm: {},
    reconciled: {},
    ledgerQty: {},
    incomeByTicker: {},
    aportesTotal: 0,
    incomeTotal: 0
  };
  for (const [ticker, row] of Object.entries(led)) {
    derived.ledgerQty[ticker] = row.qty;
    derived.incomeByTicker[ticker] = row.income;
    derived.aportesTotal += row.cost;
    derived.incomeTotal += row.income;
  }
  for (const p of positions || []) {
    const ticker = p.ticker,
      row = led[ticker];
    if (!row || row.qty <= 0 || p.category === 'Renda Fixa') continue;
    const tolerance = Math.max(2, p.quantity * 0.03),
      missingBasis = !(p.averagePrice != null && Number.isFinite(Number(p.averagePrice))) || p.costBasisEstimated === true;
    if (Math.abs(row.qty - p.quantity) <= tolerance) {
      derived.reconciled[ticker] = true;
      if (missingBasis) derived.pm[ticker] = row.cost / row.qty;
      continue;
    }
    if (!missingBasis) continue;
    // estado antigo sem rótulo: bonificações/frações não entram no saldo do ledger.
    // Se a diferença cabe em ações corporativas e o custo é conhecido, aproxima o PM pelo saldo da posição.
    const gap = p.quantity - row.qty,
      hasUnlabeledEvent = (list || []).some(tx => String(tx.ticker || '').toUpperCase() === ticker && tx.type === 'Evento' && !tx.label);
    if (gap > 0 && gap <= p.quantity * 0.35 && hasUnlabeledEvent && row.cost > 0) {
      derived.pm[ticker] = row.cost / p.quantity;
      derived.estimated = derived.estimated || {};
      derived.estimated[ticker] = true;
    }
  }
  return derived;
}
function mergeB3Import(oldPositions, oldTransactions, payload) {
  const oldByTicker = new Map(oldPositions.map(p => [String(p.ticker).toUpperCase(), p]));
  const imported = (payload.positions || []).map(p => {
    const quantity = Number(p.quantity),
      currentPrice = Number(p.currentPrice ?? Number(p.currentValue) / quantity),
      rawAverage = p.averagePrice == null ? null : Number(p.averagePrice),
      average = Number.isFinite(rawAverage) ? rawAverage : null;
    if (!p.ticker || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) throw new TypeError('Posição B3 inválida.');
    return {
      ...p,
      ticker: String(p.ticker).trim().toUpperCase(),
      quantity,
      currentPrice,
      averagePrice: average,
      costBasisKnown: average !== null,
      quoteSource: 'B3 XLSX',
      source: 'B3',
      targetPrice: p.targetPrice == null ? oldByTicker.get(String(p.ticker || '').toUpperCase())?.targetPrice ?? null : Number(p.targetPrice)
    };
  });
  const tickers = new Set(imported.map(p => p.ticker));
  const nextPositions = oldPositions.filter(p => !(payload.fullSnapshot && p.source === 'B3') && !tickers.has(String(p.ticker).toUpperCase()));
  nextPositions.push(...imported);
  const nextTransactions = oldTransactions.slice();
  const seen = new Set(nextTransactions.map(t => t.sourceId || t.id));
  for (const tx of payload.transactions || []) {
    const sourceId = String(tx.sourceId || `${tx.date}-${tx.ticker}-${tx.type}-${tx.quantity}-${tx.amount}`);
    const amount = Number(tx.amount),
      quantity = Number(tx.quantity) || 0,
      price = Number(tx.price) || 0;
    if (!tx.ticker || !Number.isFinite(amount) || !tx.date) continue;
    const normalized = {
      ...tx,
      id: `b3-${sourceId}`,
      sourceId,
      amount,
      quantity,
      price,
      fees: tx.fees == null ? null : Number(tx.fees),
      realizedPnl: tx.realizedPnl == null ? null : Number(tx.realizedPnl),
      ticker: String(tx.ticker).trim().toUpperCase(),
      source: 'B3'
    };
    const existingIndex = nextTransactions.findIndex(t => (t.sourceId || t.id) === sourceId);
    if (existingIndex >= 0) {
      if (tx.label && !nextTransactions[existingIndex].label) nextTransactions[existingIndex] = normalized;
      continue;
    }
    nextTransactions.push(normalized);
    seen.add(sourceId);
  }
  return {
    positions: nextPositions,
    transactions: nextTransactions
  };
}
function futureValue(initial, monthly, annualRate, years) {
  const months = Math.round(years * 12),
    rate = (1 + annualRate / 100) ** (1 / 12) - 1;
  if (rate === 0) return initial + monthly * months;
  const factor = (1 + rate) ** months;
  return initial * factor + monthly * (factor - 1) / rate;
}
function requiredMonthly(target, initial, annualRate, years) {
  const months = Math.round(years * 12),
    rate = (1 + annualRate / 100) ** (1 / 12) - 1,
    remaining = target - initial * (1 + rate) ** months;
  if (remaining <= 0) return 0;
  if (rate === 0) return remaining / months;
  return remaining * rate / ((1 + rate) ** months - 1);
}
function applyTrade(list, type, ticker, quantity, price, category, fees = 0) {
  const existing = list.find(p => p.ticker.toUpperCase() === ticker);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fees) || fees < 0) throw new TypeError('Quantidade, preço ou taxas inválidos.');
  if (type === 'Venda') {
    if (!existing || quantity > existing.quantity) throw new RangeError('A quantidade vendida supera a posição registrada.');
    const known = existing.costBasisKnown !== false && Number.isFinite(existing.averagePrice);
    const realizedPnl = known ? quantity * (price - existing.averagePrice) - fees : null;
    existing.quantity -= quantity;
    if (existing.quantity < 1e-8) existing.quantity = 0;
    existing.source = 'Manual';
    return {
      realizedPnl
    };
  }
  if (type !== 'Compra') throw new TypeError('Tipo de operação inválido.');
  if (existing) {
    const next = existing.quantity + quantity;
    if (existing.costBasisKnown !== false && Number.isFinite(existing.averagePrice)) existing.averagePrice = (existing.quantity * existing.averagePrice + quantity * price + fees) / next;else {
      existing.averagePrice = null;
      existing.costBasisKnown = false;
    }
    existing.quantity = next;
    existing.source = 'Manual';
  } else list.push({
    ticker,
    name: ticker,
    category,
    quantity,
    averagePrice: price + fees / quantity,
    currentPrice: null,
    costBasisKnown: true,
    source: 'Manual'
  });
  return {
    realizedPnl: null
  };
}
function quoteablePositions(items) {
  return items.filter(p => p.category !== 'Renda fixa' && /[0-9]/.test(p.ticker) && /^[A-Z0-9]{4,8}$/.test(p.ticker));
}
function selfCheck() {
  const rkRows = [{
    ticker: 'AAA1',
    name: 'A',
    quote: 10,
    pl: 5,
    pvp: 1,
    psr: 4,
    dy: 0.1,
    roic: 15,
    roe: 20,
    liq2m: 90000000,
    patrim: 1000000000
  }, {
    ticker: 'BBB2',
    name: 'B',
    quote: 50,
    pl: 30,
    pvp: 8,
    psr: 0,
    dy: 0.3,
    roic: 2,
    roe: 5,
    liq2m: 100,
    patrim: 900000
  }, {
    ticker: 'CCC3',
    name: 'C',
    quote: 5,
    pl: 0,
    pvp: 2,
    psr: 2,
    dy: 0,
    roic: 30,
    roe: 0,
    liq2m: 0,
    patrim: 1000000000
  }];
  if (computeRanking('graham', rkRows).rows()[0].ticker !== 'AAA1') throw new Error('Falha no ranking de Graham');
  if (computeRanking('queridas', rkRows).rows()[0].ticker !== 'AAA1') throw new Error('Falha nas mais negociadas');
  if (computeRanking('receita', rkRows).rows()[0].ticker !== 'CC' + 'C3') throw new Error('Falha na receita aproximada');
  const t = totals([{
    quantity: 2,
    averagePrice: 10,
    currentPrice: 12
  }]);
  if (t.invested !== 20 || t.market !== 24 || t.unrealized !== 4) throw new Error('Falha no cálculo base da carteira');
  const sample = [];
  applyTrade(sample, 'Compra', 'TEST', 2, 10, 'Ações', 2);
  if (sample[0].quantity !== 2 || sample[0].averagePrice !== 11 || sample[0].currentPrice !== null) throw new Error('Falha no custo médio com taxas');
  const sale = applyTrade(sample, 'Venda', 'TEST', 1, 15, 'Ações', 1);
  if (sample[0].quantity !== 1 || sale.realizedPnl !== 3) throw new Error('Falha no P&L realizado');
  let rejected = false;
  try {
    applyTrade(sample, 'Venda', 'TEST', 2, 15, 'Ações');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Venda acima da posição deveria ser rejeitada');
  if (futureValue(1000, 100, 0, 2) !== 3400 || requiredMonthly(1000000, 0, 0, 10) !== 100000 / 12) throw new Error('Falha nas calculadoras');
  const merged = mergeB3Import([{
    ticker: 'KEEP',
    quantity: 1,
    currentPrice: 20,
    averagePrice: 10,
    source: 'Manual'
  }, {
    ticker: 'OLD',
    quantity: 1,
    currentPrice: 20,
    averagePrice: 12,
    source: 'B3'
  }], [{
    id: 'old',
    type: 'Compra',
    ticker: 'OLD',
    amount: 12,
    source: 'B3'
  }], {
    positions: [{
      ticker: 'KEEP',
      quantity: 2,
      currentPrice: 30,
      averagePrice: null
    }, {
      ticker: 'NEW',
      quantity: 1,
      currentPrice: 50,
      averagePrice: 40
    }],
    transactions: [{
      sourceId: 'row-1',
      date: '2026-10-26',
      ticker: 'NEW',
      type: 'Compra',
      quantity: 1,
      price: 40,
      amount: 40
    }],
    fullSnapshot: true
  });
  if (merged.positions.length !== 2 || merged.positions[0].source !== 'B3' || merged.positions[0].costBasisKnown !== false || merged.transactions.length !== 2 || mergeB3Import(merged.positions, merged.transactions, {
    positions: [],
    transactions: [{
      sourceId: 'row-1',
      ticker: 'NEW',
      type: 'Compra',
      quantity: 1,
      price: 40,
      amount: 40
    }]
  }).transactions.length !== 2) throw new Error('Falha na importação B3 idempotente');
  const analyzed = analyzeMovements([{
    type: 'Evento',
    label: 'Transferência - Liquidação',
    ticker: 'ITUB3',
    quantity: 100,
    amount: 1500,
    category: 'Ações'
  }, {
    type: 'Evento',
    label: 'Bonificação em Ativos',
    ticker: 'ITUB3',
    quantity: 3.93,
    amount: 0
  }, {
    type: 'Evento',
    label: 'Fração em Ativos',
    ticker: 'ITUB3',
    quantity: 0.93,
    amount: 0
  }, {
    type: 'Provento',
    ticker: 'ITUB3',
    quantity: 130,
    amount: 100
  }], [{
    ticker: 'ITUB3',
    quantity: 103,
    category: 'Ações'
  }]);
  if (!analyzed.reconciled.ITUB3 || Math.abs(analyzed.pm.ITUB3 - 1500 / 103) > 1e-9 || analyzed.ledgerQty.ITUB3 !== 103 || analyzed.incomeByTicker.ITUB3 !== 100 || analyzed.aportesTotal !== 1500) throw new Error('Falha na reconstrução de custo médio das movimentações');
}
selfCheck();
if (quoteablePositions([{
  ticker: 'ITSA4',
  category: 'Ações'
}, {
  ticker: 'CDB DI',
  category: 'Renda fixa'
}]).length !== 1) throw new Error('Falha ao filtrar ativos para cotação');
if (validateBackup({
  format: 'DoriInvest',
  version: 1,
  positions: [],
  transactions: []
}).positions.length !== 0) throw new Error('Falha ao validar backup vazio');
const savedPositions = S.positions,
  savedSnapshots = S.marketSnapshots;
S.positions = [{
  ticker: 'TEST',
  quantity: 2,
  currentPrice: 12
}];
S.marketSnapshots = [];
if (!recordMarketSnapshot('check') || S.marketSnapshots[0].value !== 24) throw new Error('Falha ao registrar snapshot');
S.positions = [{
  ticker: 'TEST',
  quantity: 2,
  currentPrice: null
}];
if (recordMarketSnapshot('check')) throw new Error('Snapshot sem preço deveria ser ignorado');
S.marketSnapshots = [];
if (!recordSnapshotPoint('2026-01-31T00:00:00Z', 49300, 'B3 XLSX') || S.marketSnapshots[0].date !== '2026-01-31') throw new Error('Falha em ponto histórico B3');
if (!recordSnapshotPoint('2022-12-31', 49269, 'B3 XLSX') || S.marketSnapshots[0].date !== '2022-12-31' || S.marketSnapshots.length !== 2) throw new Error('Falha em ordenação de ponto histórico');
if (recordSnapshotPoint('', -5, 'B3 XLSX') || recordSnapshotPoint('2026-01-31', 0, 'B3 XLSX') || S.marketSnapshots.length !== 2) throw new Error('Ponto histórico inválido deveria ser ignorado');
if (!recordSnapshotPoint('2022-12-31', 51200, 'B3 XLSX') || S.marketSnapshots.length !== 2 || S.marketSnapshots[0].value !== 51200) throw new Error('Ponto histórico no mesmo dia deveria ser substituído');
S.positions = savedPositions;
S.marketSnapshots = savedSnapshots;
function investedSeries() {
  const byDate = {};
  let sum = 0;
  for (const tx of [...S.transactions].filter(t => t.type === 'Compra' || t.type === 'Venda').sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    sum += (tx.type === 'Compra' ? 1 : -1) * (Number(tx.amount) || 0);
    byDate[tx.date] = sum;
  }
  return Object.entries(byDate).map(([date, value]) => ({
    date,
    value
  }));
}
function computeRanking(key, rows) {
  rows = rows.map(r => ({
    ...r,
    lucro: r.roe && r.patrim > 0 ? r.roe / 100 * r.patrim : null,
    marketCap: r.patrim && r.pvp > 0 ? r.patrim * r.pvp : null,
    receita: r.psr > 0 && r.patrim && r.pvp > 0 ? r.patrim * r.pvp / r.psr : null
  }));
  const lpa = r => r.pl > 0 && r.quote > 0 ? r.quote / r.pl : null,
    vpa = r => r.pvp > 0 && r.quote > 0 ? r.quote / r.pvp : null,
    grahamPrice = r => {
      const l = lpa(r), v = vpa(r);
      return l && v ? Math.sqrt(22.5 * l * v) : null;
    },
    grahamUpside = r => {
      const fair = grahamPrice(r);
      return fair && r.quote > 0 ? fair / r.quote - 1 : null;
    },
    bazinCeiling = r => r.dy > 0 && r.quote > 0 ? r.quote * r.dy / 0.06 : null,
    bazinUpside = r => r.dy > 0 ? r.dy / 0.06 - 1 : null,
    buyHoldScore = r => [r.pl > 0, r.roe >= 10, r.dy >= 0.04, r.liq2m >= 50000000].filter(Boolean).length * 10,
    ratio = value => value == null ? '—' : (value * 100).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%',
    percent = value => value == null ? '—' : Number(value).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%',
    decimal = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('pt-BR', {maximumFractionDigits: digits}),
    liquid = r => r.liq2m > 0,
    list = {
      lucrativas: {
        name: 'Nunca Tiveram Prejuízo',
        about: 'O Investidor10 lista empresas que nunca registraram prejuízo no histórico e ordena por valor de mercado. A verificação original usa todo o histórico contábil; a fonte pública gratuita só entrega o último balanço, então esta lista aproxima a regra com lucro positivo nos últimos doze meses e ordena pelo valor de mercado derivado de P/VP × patrimônio líquido.',
        rows: () => rows.filter(r => r.lucro > 0).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)),
        cols: [['Valor de mercado', r => r.marketCap ? compactMoney(r.marketCap) : '—'], ['ROE', r => percent(r.roe)], ['Lucro aprox. (12m)', r => r.lucro ? compactMoney(r.lucro) : '—']],
        note: 'Aproximação declarada: o histórico completo de lucros não está na fonte gratuita.'
      },
      graham: {
        name: 'Mais Baratas - Graham',
        about: 'Valor justo de Graham = √(22,5 × LPA × VPA), em que LPA é o lucro por ação (cotação ÷ P/L) e VPA é o valor patrimonial por ação (cotação ÷ P/VP). O upside é o valor justo dividido pela cotação atual menos 1. A lista inclui ativos com P/L e P/VP positivos, liquidez de negociação, porte mínimo de R$ 300 milhões e upside positivo, ordenados do maior upside para o menor, como no Investidor10. O corte de porte evita que empresas minúsculas com múltiplos distorcidos dominem o topo. O número 22,5 vem de 15 × 1,5, os limites clássicos de P/L e P/VP do método.',
        rows: () => rows.filter(r => r.pl > 0 && r.pvp > 0 && r.quote > 0 && liquid(r) && r.marketCap >= 300000000 && grahamUpside(r) > 0).sort((a, b) => grahamUpside(b) - grahamUpside(a)),
        cols: [['Preço justo de Graham', r => grahamPrice(r) ? money(grahamPrice(r)) : '—'], ['Upside Graham', r => ratio(grahamUpside(r))], ['P/L', r => decimal(r.pl)], ['P/VP', r => decimal(r.pvp)], ['DY (12m)', r => ratio(r.dy)]],
        note: 'Mesma fórmula do Investidor10. Os números podem divergir um pouco porque a fonte pública (Fundamentus) atualiza em outro momento e arredonda os múltiplos.'
      },
      bazin: {
        name: 'Mais Baratas - Bazin',
        about: 'Preço-teto de Bazin = dividendo anual por ação ÷ 0,06, ou seja, a cotação que entrega 6% de dividend yield ao ano. Como a fonte gratuita não traz a média de dividendos de cinco anos usada pelo Investidor10, aqui o cálculo usa o DY dos últimos doze meses. A lista exige DY de pelo menos 6%, liquidez de negociação e ordena pelo upside em relação ao teto, do maior para o menor.',
        rows: () => rows.filter(r => r.dy >= 0.06 && r.quote > 0 && liquid(r)).sort((a, b) => bazinUpside(b) - bazinUpside(a)),
        cols: [['Preço-teto de Bazin', r => bazinCeiling(r) ? money(bazinCeiling(r)) : '—'], ['Upside Bazin', r => ratio(bazinUpside(r))], ['DY (12m)', r => ratio(r.dy)]],
        note: 'Aproximação declarada: usa DY de 12 meses no lugar da média de dividendos de 5 anos.'
      },
      dy: {
        name: 'Maior Dividend Yield',
        about: 'Dividend Yield = dividendos pagos por ação nos últimos doze meses ÷ cotação atual, em percentual. A lista ordena do maior DY para o menor, sem teto artificial, igual ao ranking do Investidor10. Valores muito altos costumam vir de pagamentos extraordinários, venda de ativos ou distorções contábeis, então confira o histórico antes de tratar o número como renda recorrente.',
        rows: () => rows.filter(r => r.dy > 0 && liquid(r)).sort((a, b) => b.dy - a.dy),
        cols: [['DY (12m)', r => ratio(r.dy)], ['P/L', r => decimal(r.pl)], ['P/VP', r => decimal(r.pvp)]],
        note: 'O DY vem dos últimos 12 meses; o Investidor10 também mostra a média de 5 anos, que não está na fonte gratuita.'
      },
      buyhold: {
        name: 'Buy and Hold',
        about: 'O Investidor10 pontua cada ação de 0 a 100 com dez critérios de buy and hold, dez pontos por critério cumprido: tempo de bolsa, nunca ter prejuízo, lucro em 20 trimestres, DY médio, ROE, dívida/patrimônio, crescimento de receita e de lucro, liquidez e nota dos usuários. A fonte gratuita permite avaliar quatro deles: lucro positivo, ROE de pelo menos 10%, DY de pelo menos 4% e liquidez média diária acima de R$ 50 milhões. A pontuação aqui vai de 0 a 40. A lista exige liquidez média diária acima de R$ 50 milhões, como o filtro do site, e ordena da maior pontuação para a menor, com ROE como desempate.',
        rows: () => rows.filter(r => r.quote > 0 && r.liq2m >= 50000000).sort((a, b) => buyHoldScore(b) - buyHoldScore(a) || (b.roe || 0) - (a.roe || 0)),
        cols: [['Pontuação (4 de 10 critérios)', r => String(buyHoldScore(r))], ['ROE', r => percent(r.roe)], ['DY (12m)', r => ratio(r.dy)], ['Liquidez (2m)', r => r.liq2m ? compactMoney(r.liq2m) : '—']],
        note: 'Pontuação parcial: os outros seis critérios dependem de dados que a fonte gratuita não publica.'
      },
      cap: {
        name: 'Maior Valor de Mercado',
        about: 'Valor de mercado aproximado = P/VP × patrimônio líquido. A lista ordena as empresas da maior para a menor capitalização, como o ranking de valor de mercado do Investidor10. A fonte pública não traz o número de ações em circulação, então o valor é derivado dos múltiplos publicados e pode variar alguns por cento em relação ao cálculo oficial.',
        rows: () => rows.filter(r => r.marketCap > 0).sort((a, b) => b.marketCap - a.marketCap),
        cols: [['Valor de mercado (aprox.)', r => compactMoney(r.marketCap)]],
        note: 'Valor derivado de P/VP × patrimônio; não é o número oficial de ações × cotação.'
      },
      queridas: {
        name: 'As Mais Queridas',
        about: 'O Investidor10 mostra as ações mais presentes nas carteiras dos usuários da plataforma, um dado privado que não existe em fonte pública. Esta lista usa a liquidez média diária de dois meses como proxy de popularidade e ordena do maior para o menor volume financeiro. É um retrato de negociação, não da preferência dos usuários.',
        rows: () => rows.filter(liquid).sort((a, b) => b.liq2m - a.liq2m),
        cols: [['Liquidez média diária (2m)', r => compactMoney(r.liq2m)]],
        note: 'Aproximação declarada: popularidade real não é pública.'
      },
      lucro: {
        name: 'Empresas de Maior Lucro',
        about: 'Lucro líquido aproximado dos últimos doze meses = ROE × patrimônio líquido. A lista ordena do maior lucro absoluto para o menor, como o ranking de maiores lucros do Investidor10. A fonte gratuita não publica o lucro nominal na listagem, então o valor é derivado e pode divergir do balanço consolidado.',
        rows: () => rows.filter(r => r.lucro > 0).sort((a, b) => b.lucro - a.lucro),
        cols: [['Lucro aprox. (12m)', r => compactMoney(r.lucro)]],
        note: 'Lucro derivado de ROE × patrimônio; arredondamentos da fonte afetam o valor.'
      },
      margem: {
        name: 'Margem Líquida',
        about: 'Margem líquida = lucro líquido ÷ receita total, em percentual. A lista ordena da maior margem para a menor, como o ranking de maiores margens líquidas do Investidor10. Margens acima de 100% acontecem quando o lucro inclui ganhos não operacionais ou equivalência patrimonial e não devem ser lidas como eficiência operacional recorrente.',
        rows: () => rows.filter(r => r.margem != null && liquid(r)).sort((a, b) => b.margem - a.margem),
        cols: [['Margem líquida', r => percent(r.margem)], ['Lucro aprox. (12m)', r => r.lucro ? compactMoney(r.lucro) : '—'], ['Receita aprox. (12m)', r => r.receita ? compactMoney(r.receita) : '—']],
        note: 'Margem vem da listagem pública; valores extremos podem refletir eventos não recorrentes.'
      },
      receita: {
        name: 'Empresas de Maior Receita',
        about: 'Receita líquida aproximada = valor de mercado ÷ P/SR, em que o valor de mercado é derivado de P/VP × patrimônio. A lista ordena da maior receita absoluta para a menor, como o ranking de maiores receitas do Investidor10. Setores com P/SR muito baixo ou distorcido podem aparecer em posição enganosa.',
        rows: () => rows.filter(r => r.receita > 0).sort((a, b) => b.receita - a.receita),
        cols: [['Receita aprox. (12m)', r => compactMoney(r.receita)]],
        note: 'Receita derivada de valor de mercado ÷ P/SR; não é o valor bruto do balanço.'
      },
      smallcaps: {
        name: 'Small Caps',
        about: 'Small caps são empresas pequenas na B3. Esta lista aceita valor de mercado entre R$ 30 milhões e R$ 3 bilhões, cotação acima de R$ 0,50 e liquidez média diária acima de R$ 1 milhão, e ordena da menor para a maior capitalização. O Investidor10 mantém uma lista própria de small caps; os cortes aqui são os mesmos usados nas outras listas da fonte pública.',
        rows: () => rows.filter(r => r.marketCap > 30000000 && r.marketCap < 3000000000 && r.quote > 0.5 && r.liq2m > 1000000).sort((a, b) => a.marketCap - b.marketCap).slice(0, 60),
        cols: [['Valor de mercado (aprox.)', r => compactMoney(r.marketCap)]],
        note: 'Cortes de tamanho e liquidez aplicados sobre a listagem pública.'
      },
      favoritos: {
        name: 'Meus favoritos (watchlist)',
        about: 'Esta lista cruza a sua watchlist com a base pública de fundamentos e ordena por valor de mercado. Só aparecem os favoritos que existem na listagem do Fundamentus; FIIs, BDRs e ativos sem dados completos podem ficar de fora. Adicione tickers na Carteira para ampliar o universo.',
        rows: () => rows.filter(r => S.favorites.includes(r.ticker)).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)),
        cols: [['Valor de mercado (aprox.)', r => r.marketCap ? compactMoney(r.marketCap) : '—'], ['DY (12m)', r => ratio(r.dy)]],
        note: 'Universo limitado à watchlist e à listagem pública.'
      }
    };
  return list[key] || list.lucrativas;
}

export {totals,analyzeMovements,mergeB3Import,futureValue,requiredMonthly,applyTrade,quoteablePositions,investedSeries,selfCheck,computeRanking};
