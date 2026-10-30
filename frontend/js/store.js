import {notify} from './dom.js';

export const S={positions:[],transactions:[],favorites:[],watchQuotes:{},marketSnapshots:[],goals:[],alerts:[],b3SyncMeta:null,quoteSyncMeta:null,currentFilter:'Todos'};

const readStore=(key,fallback=[])=>{try{const value=JSON.parse(localStorage.getItem(key));return Array.isArray(value)?value:fallback}catch{return fallback}};
const readObject=key=>{try{const value=JSON.parse(localStorage.getItem(key));return value&&typeof value==='object'?value:null}catch{return null}};

const storedPositions=readStore('dorinvest.positions.v1');
const storedTransactions=readStore('dorinvest.transactions.v1');
S.b3SyncMeta=readObject('dorinvest.b3sync.v1');
S.quoteSyncMeta=readObject('dorinvest.quotes.v1');
S.marketSnapshots=readStore('dorinvest.snapshots.v1').filter(s=>s&&typeof s.date==='string'&&Number.isFinite(Number(s.value))&&Number(s.value)>=0).slice(-365);
S.favorites=(readStore('dorinvest.favorites.v1')||[]).filter(t=>typeof t==='string'&&t.trim()&&t.trim().length<=12).map(t=>t.trim().toUpperCase()).filter((t,i,a)=>a.indexOf(t)===i).slice(0,50);
S.watchQuotes=readObject('dorinvest.watch.v1')||{};
S.goals=readStore('dorinvest.goals.v1').filter(g=>g&&typeof g.id==='string'&&typeof g.title==='string'&&(g.type==='patrimonio'||g.type==='renda')&&Number.isFinite(Number(g.target))&&Number(g.target)>0).map(g=>({...g,title:String(g.title).slice(0,60),target:Number(g.target)})).slice(0,20);
S.alerts=readStore('dorinvest.alerts.v1').filter(a=>a&&typeof a.id==='string'&&/^[A-Z0-9]{4,8}$/.test(String(a.ticker||''))&&Number.isFinite(Number(a.price))&&Number(a.price)>0&&(a.direction==='acima'||a.direction==='abaixo')).map(a=>({...a,ticker:String(a.ticker).toUpperCase(),price:Number(a.price)})).slice(0,50);

const oldDemoB3=S.b3SyncMeta?.source==='B3 — lote fictício';
const hadDemoData=oldDemoB3||storedPositions.some(p=>p?.source==='Demo')||storedTransactions.some(t=>t?.source==='Demo');

S.positions=storedPositions.filter(p=>p&&typeof p.ticker==='string'&&Number.isFinite(Number(p.quantity))&&(p.averagePrice==null||Number.isFinite(Number(p.averagePrice)))&&(p.currentPrice==null||Number.isFinite(Number(p.currentPrice)))&&p.source!=='Demo'&&!(oldDemoB3&&p.source==='B3')).map(p=>({...p,ticker:p.ticker.trim().toUpperCase(),quantity:Number(p.quantity),averagePrice:p.averagePrice==null?null:Number(p.averagePrice),targetPrice:p.targetPrice==null?null:Number(p.targetPrice),costBasisKnown:p.costBasisKnown!==false&&p.averagePrice!=null,source:p.source||'Manual',currentPrice:p.currentPrice==null?null:Number(p.currentPrice)}));
S.transactions=storedTransactions.filter(t=>t&&typeof t.ticker==='string'&&typeof t.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(t.date)&&Number.isFinite(Number(t.amount))&&t.source!=='Demo'&&!(oldDemoB3&&t.source==='B3')).map(t=>({...t,ticker:t.ticker.trim().toUpperCase(),amount:Number(t.amount),quantity:Number(t.quantity)||0,price:Number(t.price)||0,fees:t.fees==null?null:Number(t.fees),realizedPnl:t.realizedPnl==null?null:Number.isFinite(Number(t.realizedPnl))?Number(t.realizedPnl):null,source:t.source||'Manual'}));

export const removeLegacyDemo=hadDemoData||S.positions.length!==storedPositions.length||S.transactions.length!==storedTransactions.length;
if(oldDemoB3)S.b3SyncMeta=null;
if(hadDemoData){S.quoteSyncMeta=null;S.marketSnapshots=[]}

const recoupleClass=item=>{const text=`${item.ticker||''} ${item.name||''}`.toLocaleLowerCase('pt-BR'),symbol=String(item.ticker||'').toLowerCase();if(/tesouro|cdb|lci|lca|debenture|renda fixa/.test(text))return 'Renda fixa';if(/fiagro/.test(text))return 'Fiagros';if(/fii|imob/.test(text))return 'FIIs';if(/bdr|depositary/.test(text))return 'BDRs';if(/etf|indice|ishares/.test(text))return 'ETFs';if(/^[a-z0-9]{4}3[4589]$/.test(symbol))return 'BDRs';if(/^[a-z]{4}\d$/.test(symbol))return 'Ações';return 'Outros'};
S.positions=S.positions.map(p=>{if(p.source==='B3'&&p.category==='Outros'){const next=recoupleClass(p);return next.category!=='Outros'?next:p}return p});


function persist() {
  const values = {
      'dorinvest.positions.v1': S.positions,
      'dorinvest.transactions.v1': S.transactions,
      'dorinvest.b3sync.v1': S.b3SyncMeta,
      'dorinvest.quotes.v1': S.quoteSyncMeta,
      'dorinvest.snapshots.v1': S.marketSnapshots,
      'dorinvest.favorites.v1': S.favorites.length ? S.favorites : null,
      'dorinvest.watch.v1': Object.keys(S.watchQuotes || {}).length ? S.watchQuotes : null,
      'dorinvest.goals.v1': S.goals.length ? S.goals : null,
      'dorinvest.alerts.v1': S.alerts.length ? S.alerts : null
    },
    old = {};
  try {
    Object.keys(values).forEach(key => old[key] = localStorage.getItem(key));
    for (const [key, value] of Object.entries(values)) value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value));
    fireStateSync(); return true;
  } catch {
    try {
      for (const [key, value] of Object.entries(old)) value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
    } catch {}
    notify('Não foi possível salvar a carteira neste navegador.');
    return false;
  }
}


function fireStateSync(){try{fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({positions:S.positions,transactions:S.transactions,b3SyncMeta:S.b3SyncMeta,quoteSyncMeta:S.quoteSyncMeta,marketSnapshots:S.marketSnapshots,favorites:S.favorites,watchQuotes:S.watchQuotes,goals:S.goals,alerts:S.alerts})}).catch(()=>{})}catch{}}

export function loadState(remote){if(!remote||typeof remote!=='object'||!Array.isArray(remote.positions))return false;S.positions=remote.positions;S.transactions=remote.transactions||S.transactions;S.marketSnapshots=remote.marketSnapshots||S.marketSnapshots;S.favorites=remote.favorites?.length?remote.favorites:S.favorites;S.watchQuotes=remote.watchQuotes&&Object.keys(remote.watchQuotes).length?remote.watchQuotes:S.watchQuotes;S.b3SyncMeta=remote.b3SyncMeta||S.b3SyncMeta;S.quoteSyncMeta=remote.quoteSyncMeta||S.quoteSyncMeta;S.goals=remote.goals?.length?remote.goals:S.goals;S.alerts=remote.alerts?.length?remote.alerts:S.alerts;return true}


function validateBackup(data) {
  if (!data || !['DorInvest', 'DoriInvest', 'dorinvest-backup'].includes(data.format) || data.version !== 1 || !Array.isArray(data.positions) || !Array.isArray(data.transactions) || data.positions.length > 10000 || data.transactions.length > 100000) throw new TypeError('Backup DoriInvest inválido ou de versão não suportada.');
  const normalizePosition = p => {
    if (!p || typeof p.ticker !== 'string' || !p.ticker.trim() || p.ticker.length > 32 || !Number.isFinite(Number(p.quantity)) || Number(p.quantity) < 0 || p.averagePrice != null && (!Number.isFinite(Number(p.averagePrice)) || Number(p.averagePrice) < 0) || p.currentPrice != null && (!Number.isFinite(Number(p.currentPrice)) || Number(p.currentPrice) < 0) || p.targetPrice != null && (!Number.isFinite(Number(p.targetPrice)) || Number(p.targetPrice) < 0)) throw new TypeError('O backup contém uma posição inválida.');
    return {
      ...p,
      ticker: p.ticker.trim().toUpperCase(),
      quantity: Number(p.quantity),
      averagePrice: p.averagePrice == null ? null : Number(p.averagePrice),
      currentPrice: p.currentPrice == null ? null : Number(p.currentPrice),
      targetPrice: p.targetPrice == null ? null : Number(p.targetPrice),
      costBasisKnown: p.costBasisKnown !== false && p.averagePrice != null
    };
  };
  const restoredPositions = data.positions.map(normalizePosition),
    restoredTransactions = data.transactions.map(t => {
      const quantity = Number(t?.quantity ?? 0),
        price = Number(t?.price ?? 0),
        amount = Number(t?.amount),
        fees = t?.fees == null ? null : Number(t.fees),
        realizedPnl = t?.realizedPnl == null ? null : Number(t.realizedPnl);
      if (!t || typeof t.ticker !== 'string' || !t.ticker.trim() || t.ticker.length > 32 || !['Compra', 'Venda', 'Provento', 'Evento'].includes(t.type) || !Number.isFinite(amount) || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(price) || price < 0 || fees != null && (!Number.isFinite(fees) || fees < 0) || realizedPnl != null && !Number.isFinite(realizedPnl) || t.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || Object.prototype.hasOwnProperty.call(t, 'positionBefore') && t.positionBefore !== null && !normalizePosition(t.positionBefore)) throw new TypeError('O backup contém uma movimentação inválida.');
      return {
        ...t,
        ticker: t.ticker.trim().toUpperCase(),
        amount,
        quantity,
        price,
        fees,
        realizedPnl,
        positionBefore: Object.prototype.hasOwnProperty.call(t, 'positionBefore') ? t.positionBefore : undefined
      };
    });
  const snapshots = Array.isArray(data.marketSnapshots) ? data.marketSnapshots.filter(s => s && typeof s.date === 'string' && Number.isFinite(Number(s.value)) && Number(s.value) >= 0).slice(-365) : [];
  const favorites = Array.isArray(data.favorites) ? data.favorites.filter(t => typeof t === 'string' && t.trim() && t.trim().length <= 12).map(t => t.trim().toUpperCase()).filter((t, i, a) => a.indexOf(t) === i).slice(0, 50) : [];
  return {
    positions: restoredPositions,
    transactions: restoredTransactions,
    b3SyncMeta: data.b3SyncMeta && typeof data.b3SyncMeta === 'object' ? data.b3SyncMeta : null,
    quoteSyncMeta: data.quoteSyncMeta && typeof data.quoteSyncMeta === 'object' ? data.quoteSyncMeta : null,
    marketSnapshots: snapshots,
    favorites,
    goals: Array.isArray(data.goals) ? data.goals.filter(g => g && typeof g.id === 'string' && typeof g.title === 'string' && (g.type === 'patrimonio' || g.type === 'renda') && Number.isFinite(Number(g.target)) && Number(g.target) > 0).map(g => ({...g, target: Number(g.target)})).slice(0, 20) : [],
    alerts: Array.isArray(data.alerts) ? data.alerts.filter(a => a && typeof a.id === 'string' && /^[A-Z0-9]{4,8}$/.test(String(a.ticker || '')) && Number.isFinite(Number(a.price)) && Number(a.price) > 0 && (a.direction === 'acima' || a.direction === 'abaixo')).map(a => ({...a, ticker: String(a.ticker).toUpperCase(), price: Number(a.price)})).slice(0, 50) : []
  };
}

function exportBackup() {
  const backup = {
      format: 'DoriInvest',
      version: 1,
      exportedAt: new Date().toISOString(),
      positions: S.positions,
      transactions: S.transactions,
      b3SyncMeta: S.b3SyncMeta,
      quoteSyncMeta: S.quoteSyncMeta,
      marketSnapshots: S.marketSnapshots,
      favorites: S.favorites,
      goals: S.goals,
      alerts: S.alerts
    },
    blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json'
    }),
    link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'dorinvest-backup.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function recordMarketSnapshot(source) {
  const active = S.positions.filter(p => p.quantity > 0);
  if (!active.length || active.some(p => !Number.isFinite(p.currentPrice) || p.currentPrice <= 0)) return false;
  const date = new Date().toISOString(),
    snapshot = {
      date,
      value: active.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0),
      source
    },
    next = [...S.marketSnapshots],
    sameDay = next.findIndex(item => item.date.slice(0, 10) === date.slice(0, 10));
  if (sameDay >= 0) next[sameDay] = snapshot;else next.push(snapshot);
  S.marketSnapshots = next.slice(-365);
  return true;
}

function recordSnapshotPoint(date, value, source) {
  const day = typeof date === 'string' ? date.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(value) || value <= 0) return false;
  const next = S.marketSnapshots.filter(item => item.date.slice(0, 10) !== day);
  next.push({
    date: day,
    value,
    source
  });
  next.sort((a, b) => a.date.localeCompare(b.date));
  S.marketSnapshots = next.slice(-365);
  return true;
}

export {persist,validateBackup,recordMarketSnapshot,recordSnapshotPoint,exportBackup};
