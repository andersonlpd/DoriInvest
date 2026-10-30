# Sincronização com a B3 (piloto)

Este piloto reduz o trabalho de importar os relatórios da Área do Investidor. Um navegador controlado pelo app mantém a sua sessão salva. Você entra uma vez, baixa os XLSX dentro dessa janela e o app detecta os arquivos sozinho, mostra a prévia e importa com um clique.

É um piloto. O fluxo principal de importação manual continua igual, e nada foi alterado no formato de dados.

## Pré-requisitos

- App rodando com `python3 run.py` em uma sessão gráfica. O navegador controlado precisa de tela; em servidor sem interface use a importação manual.
- Node.js 20 ou mais recente.
- Dependências do helper instaladas com `npm install` na raiz do projeto.
- Playwright com Chromium baixado. O `npm install` instala o pacote; se o Chromium não estiver em cache, rode `npx playwright install chromium`.

## Como usar

1. Abra a página Importar B3.
2. Clique em Conectar B3. Uma janela do Chromium abre na tela de login da B3.
3. Entre com a sua conta. Quando terminar, feche a janela. A sessão fica salva em `data/b3-profile`; a senha não é guardada.
4. Clique em Abrir portal e capturar downloads. A janela reabre já autenticada.
5. Baixe os relatórios que quiser dentro dessa janela (Movimentação, Posição, Proventos a Receber). Cada XLSX baixado é salvo em `data/b3-inbox`.
6. De volta ao app, clique em Atualizar se a lista ainda não apareceu. Os arquivos capturados aparecem no card.
7. Clique em Analisar arquivos baixados. O app lê todos, monta a prévia combinada e você confere como na importação manual.
8. Clique em Aplicar importação. Os arquivos usados são movidos para `data/b3-inbox/processed` e não entram de novo.

Se a sessão expirar, o app avisa e pede um novo Conectar B3. O portal também pode pedir 2FA ou CAPTCHA; nesse caso você resolve na janela, como faria no navegador normal.

## O que o piloto faz e o que não faz

Faz: mantém a sessão, abre o portal autenticado, captura automaticamente qualquer download feito naquela janela, lista os arquivos, importa em lote e arquiva o que foi aplicado.

Não faz: preencher login sozinho, guardar senha, clicar em menus do portal, rodar em segundo plano sem janela, agendar sincronizações ou operar dentro de container sem tela. A automação de cliques pode entrar depois, mas só se os seletores forem estáveis e o uso estiver de acordo com os termos da B3.

## Onde ficam os arquivos

```
data/b3-profile/          perfil do navegador, incluindo cookies da sessão
data/b3-inbox/            XLSX capturados e ainda não aplicados
data/b3-inbox/processed/  XLSX já aplicados
data/b3-sync.json         status da última execução
data/b3-sync.log          log do helper
```

Para revogar a sessão local, feche o app, apague `data/b3-profile` e entre de novo quando quiser.

## Segurança

O servidor escuta em 127.0.0.1. Não exponha a porta para a internet com este piloto: não há autenticação de usuários no app e o perfil contém cookies da sua conta B3. Os arquivos e o perfil ficam em `data/`, que está fora do Git.

## Docker

O `Dockerfile` e o `docker-compose.yml` sobem o app em container. A sincronização com a B3 não funciona dentro do container, porque a janela do Chromium precisa de uma sessão gráfica e o helper Node não está na imagem. Nesse formato, use a importação manual ou rode o helper no host apontando a pasta `data/b3-inbox` compartilhada.

## Problemas comuns

- "Não consegui abrir o navegador": falta sessão gráfica ou DISPLAY. Rode o app no desktop.
- "Node.js não encontrado": instale Node 20+ e rode `npm install`.
- A janela abre no login mesmo depois de entrar: a sessão expirou ou o perfil foi apagado. Use Conectar B3 de novo.
- Arquivo não aparece na lista: confirme que o download foi feito na janela controlada e clique em Atualizar.
- Importou duas vezes: o merge deduplica por `sourceId`; arquivos aplicados saem da inbox, mas reimportar o mesmo arquivo não duplica movimentações.
- Docker sem sincronização: comportamento esperado neste piloto.
