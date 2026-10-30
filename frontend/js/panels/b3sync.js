import {combinedImport, showB3Preview} from '../b3.js';
import {notify, dateLabel} from '../dom.js';

let inboxFiles = [];
let pendingAck = [];

const byId = id => document.getElementById(id);

function formatSize(bytes) {
  if (!Number.isFinite(Number(bytes)) || bytes <= 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toLocaleString('pt-BR', {maximumFractionDigits: 0}) + ' KB';
  return (bytes / 1024 / 1024).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + ' MB';
}

function renderFiles() {
  const tbody = byId('b3-sync-file-list'),
    filesBox = byId('b3-sync-files'),
    empty = byId('b3-sync-empty'),
    button = byId('b3-sync-import');
  if (!tbody) return;
  tbody.replaceChildren();
  inboxFiles.forEach(file => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = file.name;
    const size = document.createElement('td');
    size.textContent = formatSize(file.size);
    const when = document.createElement('td');
    when.textContent = file.modified ? dateLabel(String(file.modified).slice(0, 10)) : '—';
    tr.append(name, size, when);
    tbody.append(tr);
  });
  filesBox.hidden = !inboxFiles.length;
  empty.hidden = !!inboxFiles.length;
  if (button) button.disabled = !inboxFiles.length || !byId('b3-auto-status')?.dataset.syncReady;
}

function renderStatus(data) {
  const status = byId('b3-auto-status');
  if (!status) return;
  status.dataset.syncState = data.state || '';
  status.dataset.syncReady = '1';
  const parts = [];
  if (data.running) parts.push(data.message || 'Janela de sincronização aberta.');
  else if (data.state === 'error') parts.push(data.message || 'Falha ao abrir o navegador de sincronização.');
  else if (data.state === 'login_required') parts.push('Sessão expirada. Use Conectar B3 para entrar de novo.');
  else if (data.state === 'closed' || data.state === 'downloaded') parts.push(data.message || 'Última sessão encerrada.');
  else parts.push(data.message || 'Nenhuma sessão iniciada. O piloto precisa de Node.js com Playwright e de uma sessão gráfica.');
  if (inboxFiles.length) parts.push(inboxFiles.length + ' arquivo(s) aguardando importação.');
  if (data.processed) parts.push(data.processed + ' já processado(s).');
  status.textContent = parts.join(' ');
}

async function refresh() {
  try {
    const response = await fetch('/api/b3/inbox'),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao ler a pasta de sincronização.');
    inboxFiles = Array.isArray(data.files) ? data.files : [];
    renderStatus(data);
    renderFiles();
  } catch (error) {
    const status = byId('b3-auto-status');
    if (status) status.textContent = error.message || 'Servidor local indisponível.';
  }
}

async function start(mode) {
  try {
    const response = await fetch('/api/b3/sync', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode})}),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não consegui iniciar a sincronização.');
    notify(mode === 'login' ? 'Janela de login aberta. Entre na B3 e feche quando terminar.' : 'Portal aberto. Baixe os relatórios na janela; os arquivos aparecem aqui.');
    await refresh();
  } catch (error) {
    notify(error.message || 'Não consegui iniciar a sincronização.');
    await refresh();
  }
}

async function importInbox() {
  if (!inboxFiles.length) return;
  const button = byId('b3-sync-import'),
    files = [...inboxFiles.map(file => file.name)];
  button.disabled = true;
  try {
    const payloads = [];
    for (const name of files) {
      const fileResponse = await fetch('/api/b3/inbox/file?name=' + encodeURIComponent(name));
      if (!fileResponse.ok) {
        const detail = await fileResponse.json().catch(() => ({}));
        throw new Error(detail.error || 'Falha ao ler ' + name);
      }
      const blob = await fileResponse.blob(),
        importResponse = await fetch('/api/b3/import', {
          method: 'POST',
          headers: {'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-B3-Filename': encodeURIComponent(name)},
          body: blob
        }),
        data = await importResponse.json();
      if (!importResponse.ok) throw new Error(data.error || 'Falha ao analisar ' + name);
      payloads.push(data);
    }
    if (!payloads.length) throw new Error('Nenhum arquivo para importar.');
    pendingAck = files;
    showB3Preview(payloads.length > 1 ? combinedImport(payloads) : payloads[0]);
  } catch (error) {
    pendingAck = [];
    notify(error.message || 'Não consegui analisar os arquivos baixados.');
  } finally {
    button.disabled = !inboxFiles.length;
  }
}

document.addEventListener('dorinvest:b3-applied', async () => {
  if (!pendingAck.length) return;
  const files = pendingAck;
  pendingAck = [];
  try {
    await fetch('/api/b3/inbox/ack', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({files})});
    notify('Arquivos de sincronização arquivados em data/b3-inbox/processed.');
  } catch {
    notify('Importação aplicada, mas não consegui arquivar os arquivos da inbox.');
  }
  await refresh();
});

byId('b3-sync-login')?.addEventListener('click', () => start('login'));
byId('b3-sync-open')?.addEventListener('click', () => start('sync'));
byId('b3-sync-refresh')?.addEventListener('click', refresh);
byId('b3-sync-import')?.addEventListener('click', importInbox);
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 6000);
