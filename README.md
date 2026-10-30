# DoriInvest

Carteira de investimentos da B3 que roda na sua máquina. Você importa os relatórios Excel da Área do Investidor, lança operações avulsas e acompanha patrimônio, proventos e listas de mercado. Nada sai do seu computador além das consultas de cotação e da listagem pública usada nas Top listas.

## Como rodar

Requisitos: Python 3.11 ou mais recente e as dependências do `requirements.txt` (só `openpyxl`).

```bash
pip install -r requirements.txt
export BRAPI_API_KEY="sua-chave-do-brapi.dev"   # opcional, só para cotações automáticas
python3 run.py --port 8000
```

Abra http://127.0.0.1:8000. O banco fica em `data/dorinvest.db` e é criado na primeira execução. Sem a chave da brapi, o app funciona normalmente com preços informados à mão.

## O que dá para fazer

A importação aceita o relatório de movimentação e os consolidados mensais ou anuais, vários arquivos de uma vez. O app mostra uma prévia antes de aplicar e reconcilia os saldos com as movimentações, reconstruindo o custo médio quando o relatório não traz esse dado.

O lançamento manual cobre compra, venda, provento e eventos como bonificação, fração e liquidação. Vendas acima da posição são recusadas, e cada operação manual pode ser desfeita enquanto não houver outro lançamento posterior do mesmo ativo.

As cotações vêm da brapi.dev com cache de 30 minutos. A watchlist acompanha tickers fora da carteira. Cada posição aceita preço-alvo, e a coluna mostra a distância até ele.

As calculadoras fazem juros compostos, renda de proventos e reserva de emergência. As Top listas seguem o método do Investidor10 (Graham com valor justo e upside, Bazin com preço-teto, maior DY, buy and hold, margem líquida, valor de mercado, lucro, receita, small caps e mais) a partir da listagem pública do Fundamentus, com corte por setor e por segmento da classificação da B3. Cada lista traz um texto explicando a fórmula, os filtros e a ordenação, o nome da empresa abaixo do ticker e uma explicação do indicador ao passar o mouse no cabeçalho. A lista Meus favoritos usa a watchlist como universo.

Na carteira e nas movimentações, clicar em um ativo abre um painel com todas as operações daquele ticker, o gráfico de preços dos últimos 30 dias, a edição do custo médio e um atalho para lançar uma nova movimentação já preenchida.

O comparador coloca dois ativos lado a lado com indicadores de mercado e, quando for o caso, seus dados de posição. As metas acompanham patrimônio ou renda mensal, com barra de progresso calculada a partir da carteira e dos proventos dos últimos 12 meses. Os alertas de preço disparam quando a cotação cruza o valor definido, na próxima atualização de tela ou de preços, sem push.

O arquivo Proventos a Receber da B3 também é aceito: os pagamentos previstos entram na agenda de proventos futuros sem alterar a carteira. O gráfico de patrimônio desenha linhas comparativas de Ibovespa e CDI no mesmo período, e o comparador de ativos mostra um veredito fundamentalista com o motivo da vitória ao passar o mouse.

O histórico desenha o patrimônio observado a partir dos snapshots gerados em cada atualização de preços e em cada importação. Quando ainda não há snapshots suficientes, o gráfico usa o capital aportado derivado das movimentações.

Backup e restauração ficam na aba Movimentações. O navegador guarda uma cópia em `localStorage` e o servidor mantém o estado no SQLite, então trocar de navegador não perde a carteira.

## Testes

```bash
python3 -m unittest discover -s tests -q     # 28 testes de domínio, importação, banco, serviços, setores e benchmarks
```

Os testes de importação usam os relatórios reais da B3 como fixture. O fluxo completo de interface foi validado com Playwright contra o servidor local em 55 verificações: importação, cotações, watchlist, preço-alvo, rankings com filtros por setor e segmento, ranking de favoritos, Graham com preço justo e upside, comparador, modal do ativo com gráfico de 30 dias e edição de custo médio, metas, alertas, calculadoras, lançamento manual, desfazer, CSV, backup e restauração, além da sincronização com o SQLite e do carregamento do estado em um navegador limpo.

## Estrutura

```
run.py                     atalho de execução
src/dorinvest/             backend em arquitetura hexagonal
  domain/                  regras puras e portas
  application/             casos de uso
  adapters/                SQLite, brapi, Fundamentus, setores B3, XLSX, log
  infrastructure/          servidor HTTP e rotas
frontend/                  index.html, css e módulos ES
tests/                     testes unitários em unittest
data/                      banco SQLite e log de erros (criados em tempo de execução)
legacy/                    versão anterior em arquivo único, preservada para consulta
```

A descrição funcional completa, com regras e limites de cada tela, está em [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md). Detalhes de arquitetura, rotas e banco estão em [docs/ARQUITETURA.md](docs/ARQUITETURA.md). O levantamento que originou as features está em [docs/PLANO.md](docs/PLANO.md).

## Limitações

As Top listas usam dados públicos e algumas regras são aproximadas. O histórico de cinco anos exigido pela regra "nunca tiveram prejuízo" não está disponível na fonte gratuita, então a lista considera o lucro dos últimos doze meses. O índice de Basileia não é coberto, porque depende de dados do Banco Central.

A brapi no plano gratuito cobre uma parte dos ativos, com atraso de aproximadamente 30 minutos. Ativos sem cobertura ficam com o preço informado manualmente.

A classificação setorial vem de um snapshot estático das páginas do Status Invest, que usam a classificação da B3. Empresas novas podem aparecer sem setor até o snapshot ser atualizado. O procedimento está descrito em `docs/ARQUITETURA.md`.

Alertas não têm notificação fora do app e só são avaliados quando a tela renderiza ou quando as cotações são atualizadas. O app não calcula imposto nem gera DARF.
