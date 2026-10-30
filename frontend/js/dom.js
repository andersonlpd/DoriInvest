const money = n => Number(n || 0).toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});
const compactMoney = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', {
  notation: 'compact',
  maximumFractionDigits: 1
});
const number = n => Number(n || 0).toLocaleString('pt-BR', {
  maximumFractionDigits: 4
});
function makeCell(text, cls = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}
function topTicker(items) {
  return [...items].sort((a, b) => b.quantity * b.currentPrice - a.quantity * a.currentPrice)[0]?.ticker || '—';
}
function dateLabel(value) {
  const text = String(value || '').slice(0, 10),
    date = new Date(text + 'T12:00:00');
  return Number.isNaN(date.valueOf()) ? text : date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}
function quoteDateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}
function notify(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function reportClientError(context, error) {
  const message = error && error.message || String(error || '');
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        context,
        message,
        stack: String(error && error.stack || '').slice(0, 2000),
        build: '2810v14',
        at: new Date().toISOString()
      })
    });
  } catch {}
}
function reportClientDebug(context, payload) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        context,
        message: JSON.stringify(payload).slice(0, 2000),
        build: '2810v14',
        at: new Date().toISOString()
      })
    });
  } catch {}
}
window.addEventListener('error', event => reportClientError('window-js', event.error || event.message));
window.addEventListener('unhandledrejection', event => reportClientError('promise', event.reason || 'rejection'));

export {money,compactMoney,number,topTicker,dateLabel,quoteDateLabel,makeCell,notify,reportClientError,reportClientDebug};
