# Funcionalidades do DoriInvest

Este documento descreve o que cada parte do app faz, de onde vêm os dados, quais regras são aplicadas e onde estão os limites conhecidos. A referência de código aparece entre parênteses quando ajuda a localizar a implementação.

## Modelo de dados

O estado da carteira é um único documento com nove partes: posições, movimentações, snapshots de patrimônio, favoritos da watchlist, cotações da watchlist, metas, alertas e os metadados da última importação B3 e da última atualização de cotações.

O navegador guarda cada parte em uma chave própria do `localStorage` (`dorinvest.positions.v1`, `dorinvest.transactions.v1`, `dorinvest.snapshots.v1`, `dorinvest.favorites.v1`, `dorinvest.watch.v1`, `dorinvest.goals.v1`, `dorinvest.alerts.v1`, `dorinvest.b3sync.v1`, `dorinvest.quotes.v1`). O servidor grava o mesmo documento no SQLite.

Toda alteração chama `persist()` (`frontend/js/store.js`). A função salva no navegador, desfaz a gravação se o `localStorage` falhar e dispara um `POST /api/state` com o documento completo. O POST é assíncrono e não bloqueia a interface. Se o servidor estiver fora do ar, a carteira continua funcionando no navegador e sincroniza na próxima gravação.

No arranque, o app consulta `GET /api/state` apenas quando o navegador está sem posições e sem movimentações. Um navegador limpo recupera o banco; um navegador com dados locais não é sobrescrito por um estado remoto mais antigo.

## Importação B3

A aba Importar B3 aceita os arquivos Excel exportados pela Área do Investidor: o relatório de movimentação e os consolidados mensais ou anuais. É possível selecionar vários arquivos de uma vez, com limite de 20 MB por arquivo.

O fluxo tem três passos. Você escolhe os arquivos, clica em Pré-visualizar e o servidor lê cada planilha. A prévia mostra a contagem de posições e movimentações, a data de referência, o setor quando disponível e os avisos de custo médio. Nada é gravado nessa etapa. Ao clicar em Aplicar importação, o lote entra no estado.

O parser reconhece os layouts de consolidado mensal e anual e o relatório de movimentação, inclusive planilhas com dimensão declarada errada no XML (`src/dorinvest/adapters/b3_xlsx.py`). O lote traz posições, movimentações normalizadas, data de referência, marcação de snapshot completo ou parcial e avisos.

A aplicação usa `mergeB3Import` (`frontend/js/calc.js`). Snapshot completo substitui as posições de origem B3 e preserva posições manuais de outros tickers. Ticker igual é atualizado pelo relatório. As movimentações são deduplicadas por `sourceId` e as linhas antigas sem identificador são substituídas pelas novas. Campos que não vêm da B3, como o preço-alvo, são preservados.

Quando o relatório não traz custo médio, o app reconstrói o valor a partir das movimentações no arranque seguinte: soma compras e liquidações, desconta vendas e frações, acrescenta bonificações ao saldo e divide o custo pela quantidade. A prévia mostra quantas posições fecham a conta com o saldo do relatório. A tolerância de reconciliação é de 3% da quantidade, com mínimo de 2 unidades.

O arquivo Proventos a Receber da B3 é reconhecido como importação de renda futura. A aba única com Previsão de pagamento vira uma lista de proventos previstos: cada linha entra como Provento com a data prevista, o ticker, o tipo de evento e o valor líquido. A prévia mostra os pagamentos, a carteira não é alterada e o metadado da última importação B3 não é sobrescrito. Linhas sem data são ignoradas com um aviso agregado. Datas passadas entram como recebidas; datas futuras aparecem em Proventos futuros.

Estados antigos, importados antes de o app guardar o rótulo dos eventos, não conseguem classificar bonificações e frações. Nesse caso, quando o saldo das compras fica abaixo do saldo da posição em até 35% e existem eventos sem rótulo para o ticker, o app calcula o custo médio dividindo o custo conhecido pela quantidade da posição e marca o valor com ≈ na carteira. A marca desaparece quando você reimporta o extrato de movimentações, porque o merge substitui as linhas antigas pelas rotuladas e o custo passa a ser exato. Editar o custo médio à mão também remove a marca.

Cada aplicação registra um ponto no histórico de patrimônio com a data de referência do relatório, para o gráfico não depender do dia em que você importou.

## Lançamento manual

O formulário de movimentação cobre quatro tipos. Compra soma quantidade e custo (mais taxas). Venda reduz a quantidade e calcula o lucro realizado descontando taxas. Provento entra apenas como renda, sem mexer no custo médio. Evento trata bonificação, fração, leilão e liquidação pela descrição.

O app recusa venda acima da posição e taxas maiores que o valor da venda. Cada lançamento manual guarda uma cópia da posição anterior, o que permite desfazer. O botão de desfazer aparece apenas para lançamentos manuais e some quando existe outro lançamento manual do mesmo ativo depois dele, ou uma importação B3 posterior. Depois do desfazer, o app recompõe o histórico e os snapshots.

## Detalhe do ativo

Clicar no ticker de uma posição da carteira ou de uma movimentação abre o painel do ativo. O painel mostra o nome e a classe, o gráfico de fechamento diário dos últimos 30 dias vindo da brapi, a lista de movimentações daquele ticker e o campo de custo médio.

O gráfico usa o endpoint `/api/history`, que consulta a série diária da brapi e mantém cache de 30 minutos por ticker. Quando o ativo não tem série disponível, como no caso de títulos do Tesouro, o painel informa que o histórico não está disponível e mantém o restante das funções.

O campo de custo médio edita `averagePrice` da posição, marca `costBasisKnown` como verdadeiro quando o valor é maior que zero e remove a marca de valor aproximado, se houver. A alteração passa pelo mesmo `persist()` das outras telas, então aparece no navegador e no SQLite, e recalcula os totais na sequência.

O botão de nova movimentação fecha o painel, abre o formulário de lançamento com o ticker já preenchido e posiciona o cursor no preço. O restante do formulário funciona como no lançamento manual comum.

## Cotações

O botão Atualizar cotações consulta a brapi.dev para todas as posições com ticker elegível. Renda fixa e nomes sem dígito no ticker ficam de fora. O backend exige a chave `BRAPI_API_KEY` no ambiente e responde com a chave configurada ou não no `/api/health`.

O servidor mantém cache de 30 minutos por ativo e uma trava para evitar chamadas simultâneas repetidas. O plano gratuito da brapi atende um ativo por requisição, com atraso aproximado de 30 minutos e cobertura parcial. Ativos sem cobertura continuam com o preço informado à mão.

Cada atualização bem-sucedida registra um snapshot do patrimônio no dia e atualiza o status exibido na barra superior. O modal de preço de cada posição permite informar preço e data manualmente, com precedência sobre a cotação automática.

## Preço-alvo

O modal de preço aceita um preço-alvo por posição. A carteira mostra a distância percentual entre o preço atual e o alvo, e marca com ✓ quando o preço atual atinge ou supera o alvo. O valor fica em `targetPrice` e sobrevive a reimportação B3, restauração de backup e reconstrução de custo médio.

## Watchlist

A watchlist acompanha tickers fora da carteira. Você adiciona até 50 ativos, atualiza os preços pelo mesmo endpoint de cotações e remove quando quiser. Os preços ficam em `watchQuotes` e são usados também pelos alertas.

## Alertas de preço

Cada alerta tem ticker, condição (acima de ou abaixo de) e preço. O app avalia os alertas quando a tela é renderizada, ao criar um alerta e em cada atualização de cotações ou da watchlist. Não existe push nem verificação em segundo plano: o alerta dispara na próxima vez que o app olhar o preço.

Um alerta disparado guarda a data e o preço do disparo e não dispara de novo. A lista mostra o status (aguardando ou atingido), o preço de referência e o preço atual. O limite é de 50 alertas.

## Metas

Metas acompanham dois tipos de objetivo. A meta de patrimônio compara o valor de mercado das posições abertas com o alvo. A meta de renda compara a média mensal de proventos dos últimos 12 meses com o alvo mensal.

A média de renda soma todos os proventos com data nos últimos 12 meses e divide por 12. O progresso é limitado a 100% e a linha inferior mostra quanto falta ou se a meta foi atingida. O limite é de 20 metas.

Posições sem preço atual não entram no valor de mercado, então uma carteira parcialmente precificada mostra progresso menor do que o real até a próxima atualização de cotações.

## Top listas de mercado

As listas usam a página pública de resultados do Fundamentus, com cache de 6 horas no servidor. O endpoint `/api/rankings` devolve as linhas com indicadores e acrescenta setor, subsetor e segmento a partir de um snapshot da classificação da B3. Cada lista exibe um texto explicando o que ela significa, a fórmula aplicada, os filtros e a ordenação, além de uma nota com a aproximação usada quando o dado original não é público.

As fórmulas seguem o método do Investidor10.

Graham usa valor justo = √(22,5 × LPA × VPA), em que LPA é a cotação dividida pelo P/L e VPA é a cotação dividida pelo P/VP. O upside é o valor justo dividido pela cotação menos 1. A lista aceita P/L e P/VP positivos, liquidez de negociação, porte mínimo de R$ 300 milhões e upside positivo, e ordena do maior upside para o menor. O corte de porte evita que empresas minúsculas com múltiplos distorcidos dominem o topo.

Bazin usa preço-teto = dividendo anual por ação dividido por 0,06, o que equivale à cotação que entrega 6% de dividend yield. O upside é o DY dividido por 0,06 menos 1. A lista exige DY de pelo menos 6% e ordena pelo upside. Como a fonte gratuita não traz a média de dividendos de cinco anos usada pelo Investidor10, o cálculo usa o DY dos últimos doze meses.

Maior Dividend Yield ordena pelo DY dos últimos doze meses, sem teto artificial, igual ao ranking do site. Valores muito altos costumam vir de pagamento extraordinário ou distorção contábil, então o texto da lista avisa para conferir o histórico antes de tratar o número como renda recorrente.

Buy and Hold reproduz a ideia da pontuação de 0 a 100 com dez critérios do Investidor10. A fonte gratuita permite avaliar quatro deles: lucro positivo, ROE de pelo menos 10%, DY de pelo menos 4% e liquidez média diária acima de R$ 50 milhões. A pontuação exibida vai de 0 a 40, com o mesmo filtro de liquidez do site, e a ordenação usa ROE como desempate.

Nunca Tiveram Prejuízo lista empresas com lucro positivo nos últimos doze meses e ordena por valor de mercado. A regra original verifica todo o histórico contábil, dado que a fonte gratuita não entrega; por isso a lista é declarada como aproximação.

Margem Líquida calcula lucro líquido dividido pela receita total, em percentual, e ordena da maior para a menor. Margens acima de 100% aparecem quando o lucro inclui ganhos não operacionais ou equivalência patrimonial e não devem ser lidas como eficiência recorrente.

Maior Valor de Mercado usa valor de mercado aproximado = P/VP × patrimônio líquido e ordena da maior capitalização para a menor. Empresas de Maior Lucro usam lucro aproximado = ROE × patrimônio líquido. Empresas de Maior Receita usam receita aproximada = valor de mercado ÷ P/SR. As três listas derivam números que a fonte não publica diretamente, e o texto de cada uma explica isso.

As Mais Queridas usam liquidez média diária de dois meses como proxy da popularidade, já que a preferência dos usuários do Investidor10 não é pública. Small Caps aceita valor de mercado entre R$ 30 milhões e R$ 3 bilhões, cotação acima de R$ 0,50 e liquidez acima de R$ 1 milhão, ordenando da menor para a maior capitalização.

Meus favoritos filtra as linhas pelos tickers da watchlist e ordena por valor de mercado. FIIs e BDRs que não aparecem na listagem do Fundamentus ficam de fora, mesmo estando na watchlist. A primeira coluna mostra o ticker com o nome da empresa abaixo, e cada cabeçalho de indicador tem uma explicação curta ao passar o mouse.

Os filtros de setor e segmento vêm do snapshot da B3 e se combinam com a lista escolhida. Ativos sem classificação no snapshot aparecem apenas quando nenhum filtro está ativo. A tabela se adapta ao número de colunas de cada lista, e o cabeçalho é reconstruído a cada carregamento.

## Comparador de ativos

O comparador coloca dois tickers lado a lado com cotação, P/L, P/VP, P/SR, DY, ROE, ROIC, liquidez, patrimônio líquido, valor de mercado aproximado, setor e segmento. Se algum dos ativos estiver na sua carteira, a tabela acrescenta quantidade, custo médio, preço atual e resultado aberto.

Acima da tabela, um veredito mostra qual ativo ganha na análise fundamentalista e o placar. A conta usa sete critérios: P/L e P/VP (menor é melhor, peso 2 cada), DY, ROE (maior é melhor, peso 2 cada), ROIC e margem líquida (peso 1,5 cada) e liquidez média (peso 0,5). Valores ausentes não pontuam para o lado sem dado. Ao passar o mouse ou focar o veredito, uma lista mostra cada vantagem do vencedor com os valores comparados e os pontos somados. O cabeçalho do ativo vencedor fica sublinhado. Empates técnicos são declarados como tal, e o texto lembra que a conta não é recomendação.

Os dados vêm do mesmo `/api/rankings`, carregados na primeira interação com os seletores. Não é possível comparar o mesmo ativo duas vezes. Cada nome de indicador tem uma explicação curta ao passar o mouse.

## Calculadoras

Juros compostos projeta o saldo com aporte mensal e taxa anual efetiva, convertida para a taxa mensal equivalente. A mesma tela calcula o aporte necessário para chegar a R$ 1 milhão no prazo informado.

Renda de proventos estima o patrimônio necessário para gerar uma meta mensal, dado um dividend yield anual. Reserva de emergência multiplica a despesa essencial pelo número de meses de cobertura.

Todas usam apenas os parâmetros digitados. Os resultados são projeções matemáticas, não previsões.

## Histórico e retorno observado

O gráfico de patrimônio usa os snapshots gravados em importações e atualizações de cotações. Com dois ou mais pontos, desenha a linha do patrimônio observado. Com menos de dois, cai para a série de capital líquido derivada das movimentações (aportes menos resgates).

Quando há dois ou mais snapshots, o gráfico busca o Ibovespa e o CDI no mesmo intervalo e desenha duas linhas comparativas normalizadas no primeiro ponto da carteira. A legenda mostra a variação de cada benchmark no período. O CDI vem do Banco Central (série diária acumulada) e o Ibovespa vem do Yahoo Finance, com fallback para os três meses disponíveis na brapi gratuita. Se uma das séries não estiver disponível, a linha correspondente é omitida sem derrubar o gráfico.

O card de retorno observado na Análise calcula o retorno total entre o primeiro e o último snapshot e, quando a janela passa de um ano, mostra o CAGR anualizado. Dias entre observações abaixo de uma semana não geram CAGR.

## Exportação e backup

A exportação CSV gera as movimentações com data, tipo, ativo, quantidade, preço, taxas, total, lucro realizado e origem. Campos que começam com sinal de igual, mais, menos ou arroba recebem apóstrofo para não virarem fórmula em planilhas.

O backup JSON guarda posições, movimentações, snapshots, favoritos, cotações da watchlist, metas, alertas e metadados. A restauração valida formato, versão, limites de quantidade e campos obrigatórios antes de pedir confirmação. A operação substitui o estado inteiro e desfaz tudo se a gravação local falhar. O limite é de 10 MB por arquivo.

## Páginas

Visão geral mostra patrimônio, custo, resultado aberto, resultado realizado, proventos, gráfico e alocação. Carteira lista posições com filtros por classe e busca, e traz a watchlist e os alertas. Proventos mostra recebidos, futuros e o gráfico mensal dos últimos 12 meses, com escala em reais e linhas de grade.

Importar B3 também abriga o piloto de sincronização automática. O botão Conectar B3 abre um Chromium com perfil persistente para login manual, sem guardar senha. O botão Abrir portal reusa a sessão e mantém a janela aberta. Qualquer XLSX baixado nessa janela é salvo em `data/b3-inbox` e listado no card, com botão para analisar em lote e aplicar. Os arquivos usados são movidos para `data/b3-inbox/processed`. O piloto não agenda execuções, não clica em menus do portal e não roda em container sem tela. O passo a passo está em `docs/B3_SYNC.md`. Metas, Movimentações, Análise, Importar B3 e Calculadoras completam a navegação.

## Limitações

As listas de mercado são aproximações declaradas de rankings comerciais e usam dados públicos com defasagem de até 6 horas. O app não calcula imposto, não gera DARF, não se conecta à B3 e não envia dados para terceiros além das consultas de cotação e da listagem pública.

A classificação setorial cobre 617 tickers no snapshot atual, dos quais 549 aparecem na listagem do Fundamentus. Empresas novas podem ficar sem setor até o snapshot ser atualizado.

Alertas não têm notificação fora do app. O disparo acontece quando a tela é atualizada ou quando você atualiza as cotações.

## Testes

Os testes unitários cobrem importação, repositório SQLite, serviços, classificação setorial e o parser de histórico da brapi (32 casos). O fluxo completo foi validado com Playwright contra o servidor local em 59 verificações: importação de dois XLSX, cotações, watchlist, preço-alvo, rankings com filtros, favoritos e Graham com preço justo e upside, comparador, modal do ativo com gráfico de 30 dias, edição de custo médio e nova movimentação pré-preenchida, metas, alertas, calculadoras, lançamento manual, desfazer, CSV, backup e restauração, sincronização com o SQLite e carregamento em navegador limpo.
