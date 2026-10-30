# Arquitetura do DoriInvest

O projeto é pequeno e roda em um único processo Python. A organização segue a ideia de portas e adaptadores: as regras de negócio não conhecem HTTP, SQLite nem brapi, e os detalhes de cada tecnologia ficam nas bordas.

```
                navegador
                   │  HTTP
        infrastructure/http_api.py        (driver: rotas e arquivos estáticos)
                   │
        application/services.py            (casos de uso e validação de payload)
                   │
        domain/ports.py                    (interfaces: StateRepository, QuoteProvider, MarketDataSource, B3Importer, EventLog)
                   │
   adapters/sqlite_state.py  adapters/brapi.py  adapters/fundamentus.py
   adapters/sectors.py       adapters/b3_xlsx.py  adapters/file_log.py
```

O piloto de sincronização fica fora do runtime Python. `tools/b3sync.mjs` usa Playwright para abrir um perfil persistente, capturar downloads e escrever `data/b3-sync.json`. `application/b3_sync.py` orquestra esse helper, lista a inbox, entrega arquivos e arquiva o que foi aplicado. O import continua sendo o mesmo, então o piloto é uma porta de entrada, não um segundo pipeline.

`main.py` monta tudo (`wire`) e sobe o servidor. Trocar SQLite por outro banco significa implementar `StateRepository` de novo; trocar brapi por outra fonte significa implementar `QuoteProvider`. Nenhuma camada de aplicação importa `http.server` ou `sqlite3`.

## Domínio

`domain/rules.py` reúne funções puras usadas na importação e na normalização: números no formato brasileiro, datas ISO, classificação de ativo, apelidos de colunas e leitura de tickers compostos. `domain/ports.py` declara as portas como `Protocol`, sem dependência de framework.

## Estado da carteira

O navegador continua sendo a interface principal e o `localStorage` funciona como cache local. Toda alteração chama `persist()`, que grava as nove partes do documento no navegador e dispara um `POST /api/state` com o documento completo. O SQLite guarda o mesmo documento, substituindo o conteúdo anterior a cada gravação. Esse replace-all é simples de auditar e evita migrações parciais; o custo é regravar algumas centenas de kilobytes por operação, o que não pesa no uso local.

As partes do estado são posições, movimentações, snapshots, favoritos, cotações da watchlist, metas, alertas, metadados da importação B3 e metadados de cotações. Uma posição pode carregar `costBasisEstimated`, que indica custo médio aproximado reconstruído de um estado antigo sem rótulos de eventos. O servidor aceita apenas essas chaves e recusa o documento inteiro quando alguma falha de validação.

No arranque, `boot.js` busca `GET /api/state` somente quando o navegador está sem posições e sem movimentações. Assim, um navegador limpo recupera o banco, e um navegador com dados locais não é sobrescrito por um estado remoto mais antigo. O primeiro `persist()` depois disso alinha os dois lados.

## Rotas

| Rota | Método | Função |
| --- | --- | --- |
| `/` | GET | serve `frontend/index.html` |
| `/css/*`, `/js/*` | GET | arquivos estáticos, com proteção contra `../` |
| `/api/health` | GET | status do processo, do banco e da chave da brapi |
| `/api/state` | GET | devolve o documento salvo no SQLite |
| `/api/state` | POST | valida e substitui o documento salvo |
| `/api/quotes` | POST | cotações via brapi, no máximo 100 ativos por chamada |
| `/api/history` | GET | série diária de preços da brapi para o gráfico do ativo, com cache de 30 minutos |
| `/api/benchmarks` | GET | Ibovespa e CDI no intervalo do gráfico de patrimônio, com cache de 6 horas |
| `/api/rankings` | GET | listagem do Fundamentus enriquecida com setor, subsetor e segmento |
| `/api/b3/import` | POST | recebe o XLSX e devolve posições, movimentações e metadados |
| `/api/b3/inbox` | GET | status do piloto de sincronização e arquivos capturados |
| `/api/b3/inbox/file` | GET | entrega um XLSX da inbox para o importador |
| `/api/b3/inbox/ack` | POST | move arquivos aplicados para a pasta processed |
| `/api/b3/sync` | POST | inicia o helper Node que abre o navegador controlado |
| `/api/log` | POST | registra erros do navegador em `data/client-errors.log` |

`GET /api/state` nunca devolve 404 em banco vazio: retorna as listas vazias com `b3SyncMeta` e `quoteSyncMeta` nulos. O `POST` valida tamanho (20 MB), chaves permitidas, ticker, quantidade e formato de data antes de gravar. Para metas, exige tipo `patrimonio` ou `renda` e alvo numérico maior que zero. Para alertas, exige ticker no padrão da B3, preço positivo e direção `acima` ou `abaixo`.

## Banco

SQLite com WAL em `data/dorinvest.db`. O schema tem quatro tabelas:

- `positions` e `transactions` guardam o documento como JSON por registro, com o ticker e a data indexados para consulta.
- `snapshots` mantém o histórico de patrimônio.
- `meta` guarda o timestamp da última gravação.

O importador aceita três famílias de planilha: consolidado de posições, extrato de movimentações e Proventos a Receber. A última é identificada pela coluna Previsão de pagamento e devolve apenas movimentações de renda futura, com `kind` igual a `proventos`, sem posições e sem sobrescrever os metadados da última importação de carteira.

Favoritos, cotações da watchlist, metas, alertas e os dois metadados ficam na tabela `meta` como JSON. A gravação é transacional: em caso de erro, o estado anterior permanece.

## Frontend

O frontend é dividido em módulos ES servidos direto pelo backend, sem bundler.

| Arquivo | Responsabilidade |
| --- | --- |
| `store.js` | estado central (`S`), carga do `localStorage`, `persist`, validação de backup, snapshots, metas e alertas, sincronização com `/api/state` |
| `dom.js` | formatação de números e datas, criação de células, avisos e log de erros do cliente |
| `calc.js` | totais, reconstrução de custo médio, merge da importação B3, calculadoras e ranking |
| `charts.js` | desenho do gráfico de patrimônio |
| `b3.js` | fluxo de importação: leitura, prévia, aplicação e cancelamento |
| `render.js` | orquestração de render e barra de cotações |
| `panels/*.js` | telas de visão geral, carteira, proventos, movimentações, ferramentas, metas, alertas, comparador e detalhe do ativo |
| `help.js` | textos de ajuda dos indicadores exibidos nos cabeçalhos das listas e do comparador |
| `boot.js` | ligação de eventos, navegação, carga inicial e diagnóstico |

A ordem de importação importa: `boot.js` carrega `b3.js` e `panels/compare.js` por efeito colateral, porque esses módulos registram os próprios listeners ao serem importados. Os módulos de metas e alertas entram pelo `render.js`, que chama as funções de desenho a cada atualização de tela. Os módulos foram extraídos do arquivo único anterior com um script baseado no AST do Babel, que renomeia apenas referências reais do estado e preserva strings. A partir de agora os módulos são a fonte de verdade; não existe mais passo de geração.

## Classificação setorial

`adapters/data/setores_b3.json` é um snapshot com 617 tickers e três níveis: setor, subsetor e segmento. A classificação é a mesma que o Status Invest exibe e vem da B3.

Para atualizar, abra as dez páginas de setor do Status Invest em um navegador real (o site fica atrás do Cloudflare, então `requests` puro recebe 403) e leia a tabela de cada página. Em ambiente Linux sem tela, `xvfb-run` com Playwright resolve:

```bash
xvfb-run -a -s "-screen 0 1600x1000x24" node scrape.mjs
```

O script visita `https://statusinvest.com.br/acoes/setor/{id}/{slug}` para os setores 1 a 10, coleta as colunas ATIVO, SETOR, SUBSETOR e SEGMENTO e grava o JSON. O adapter normaliza as vírgulas que o HTML do site entrega como pontos.

O arquivo é estático de propósito. Scraping em tempo de execução adicionaria dependência de navegador ao servidor e risco de bloqueio, e a classificação muda raramente.

## Caches e limites

A listagem do Fundamentus fica em memória por 6 horas. As cotações da brapi ficam em cache por 30 minutos, com uma trava para evitar chamadas simultâneas iguais. O histórico diário usado no modal do ativo usa a mesma trava e um cache próprio de 30 minutos por ticker. O comparativo de patrimônio tem cache de 6 horas no servidor para o CDI e para o Ibovespa, e cache em memória no navegador por intervalo consultado. O CDI vem do SGS 12 do Banco Central e o Ibovespa do Yahoo Finance, com fallback para a brapi, que no plano gratuito só entrega três meses de histórico. Os dois caches vivem no processo; reiniciar o servidor os esvazia. Se o uso crescer para várias instâncias, o próximo passo é um cache compartilhado, não um mecanismo novo dentro do processo.

## Testes

Os testes unitários ficam em `tests/` e cobrem regras de importação, o repositório SQLite, os serviços da aplicação e o mapa setorial. A interface foi exercitada com Playwright contra o servidor local, incluindo importação de arquivos reais, sincronização com o banco e recarga em navegador limpo.
