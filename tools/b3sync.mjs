#!/usr/bin/env node
// Piloto de sincronização da Área do Investidor da B3.
// - login: abre o navegador com perfil persistente para você entrar uma vez (sem guardar senha).
// - sync: reusa a sessão salva, abre o portal e captura qualquer XLSX baixado na janela para data/b3-inbox.
// Uso: node tools/b3sync.mjs login|sync [--timeout=15]
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA = path.join(ROOT, 'data');
const PROFILE = path.join(DATA, 'b3-profile');
const INBOX = path.join(DATA, 'b3-inbox');
const STATUS = path.join(DATA, 'b3-sync.json');
const LOG = path.join(DATA, 'b3-sync.log');
const PORTAL = 'https://www.investidor.b3.com.br/';
const mode = process.argv[2] === 'login' ? 'login' : process.argv[2] === 'sync' ? 'sync' : null;
const timeoutArg = process.argv.find(arg => arg.startsWith('--timeout='));
const timeoutMinutes = Math.max(1, Math.min(60, Number(timeoutArg ? timeoutArg.split('=')[1] : 15) || 15));

if (!mode) {
  console.error('Uso: node tools/b3sync.mjs login|sync [--timeout=15]');
  process.exit(2);
}

fs.mkdirSync(INBOX, {recursive: true});
fs.mkdirSync(PROFILE, {recursive: true});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS, 'utf8'));
  } catch {
    return {files: []};
  }
}

function writeStatus(patch) {
  const next = {...readStatus(), ...patch, updatedAt: new Date().toISOString()};
  const tmp = STATUS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATUS);
}

function uniqueName(name) {
  const safe = path.basename(String(name || 'relatorio.xlsx')).replace(/[^\w.\- ]+/g, '_');
  const base = safe.toLowerCase().endsWith('.xlsx') ? safe : safe + '.xlsx';
  let candidate = base;
  let counter = 2;
  while (fs.existsSync(path.join(INBOX, candidate))) {
    candidate = base.replace(/\.xlsx$/i, '') + '-' + counter + '.xlsx';
    counter++;
  }
  return candidate;
}

writeStatus({mode, state: 'starting', message: mode === 'login' ? 'Abrindo o navegador para login…' : 'Retomando a sessão salva…', files: readStatus().files || []});
log(`Iniciando modo ${mode}`);
log(`Perfil: ${PROFILE}`);

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    acceptDownloads: true,
    locale: 'pt-BR',
    viewport: {width: 1440, height: 900},
    args: ['--disable-blink-features=AutomationControlled']
  });
} catch (error) {
  writeStatus({state: 'error', message: 'Não consegui abrir o navegador. Verifique se há uma sessão gráfica (DISPLAY) disponível.', error: String(error).slice(0, 300)});
  log('Falha ao abrir o navegador: ' + String(error));
  process.exit(1);
}

await context.addInitScript("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})");

const captured = new Set((readStatus().files || []).map(file => file.name));
context.on('download', async download => {
  try {
    const name = uniqueName(download.suggestedFilename());
    const target = path.join(INBOX, name);
    await download.saveAs(target);
    captured.add(name);
    const status = readStatus();
    const files = [...new Set([...(status.files || []).map(file => file.name), name])].map(fileName => {
      const filePath = path.join(INBOX, fileName);
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {}
      return {name: fileName, size};
    });
    writeStatus({state: 'downloaded', message: 'Arquivo capturado: ' + name, files});
    log('Download capturado: ' + name);
  } catch (error) {
    log('Falha ao salvar download: ' + String(error));
  }
});

const page = context.pages()[0] || (await context.newPage());
try {
  await page.goto(PORTAL + (mode === 'login' ? 'login' : ''), {waitUntil: 'domcontentloaded', timeout: 90000});
  await page.waitForTimeout(4000);
} catch (error) {
  log('Aviso ao abrir o portal: ' + String(error).slice(0, 200));
}

if (mode === 'login') {
  writeStatus({state: 'waiting_login', message: 'Entre com sua conta na janela do navegador. Feche a janela quando terminar; a sessão fica salva.'});
  log('Aguardando login manual. Feche a janela para concluir.');
} else {
  const loginRequired = /\/login/i.test(page.url());
  writeStatus({
    state: loginRequired ? 'login_required' : 'ready',
    message: loginRequired
      ? 'Sessão expirada. Use Conectar B3 para entrar novamente.'
      : 'Portal aberto. Baixe Movimentação, Posição e Proventos na janela; os XLSX serão capturados automaticamente.'
  });
  log(loginRequired ? 'Sessão expirada, login necessário.' : 'Portal aberto com a sessão salva.');
}

const started = Date.now();
const limit = timeoutMinutes * 60 * 1000;
const keepAlive = setInterval(() => {
  if (Date.now() - started > limit) {
    log('Tempo limite atingido; encerrando.');
    context.close().catch(() => {});
  }
}, 5000);

context.on('close', () => {
  clearInterval(keepAlive);
  const status = readStatus();
  writeStatus({state: 'closed', message: 'Janela fechada. Sessão e downloads vivem em data/b3-inbox.', files: status.files || []});
  log('Contexto encerrado.');
  process.exit(0);
});
